/**
 * SDK client — opens a session with the engine, streams event batches, and
 * closes the session on stop().
 *
 * Durability (Phase 1h): when the gRPC stream is healthy, `sendBatch` writes
 * directly and awaits the engine's ack. When the stream is unhealthy, the
 * batch is written to a local WAL file; a background reconnect loop tries
 * to reopen the stream with backoff, and drains the WAL once it succeeds.
 * A `sendBatch` promise resolves once the batch is either acked by the
 * engine OR durably on disk — so callers never have to know which path ran.
 */

import { createHash } from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";

import { credentials, type ClientDuplexStream } from "@grpc/grpc-js";
import {
  CaptureServiceClient,
  type StreamEventsRequest,
  type StreamEventsResponse,
} from "./generated/clearvoiance/v1/capture.js";
import type { BlobRef, Event } from "./generated/clearvoiance/v1/event.js";
import { WAL } from "./client/wal.js";
import { SDK_VERSION } from "./version.js";

export { SDK_VERSION };

export interface ClientConfig {
  engine: {
    url: string; // e.g. "127.0.0.1:9100"
    apiKey: string;
    tls?: boolean; // default false — loopback dev default
  };
  session: {
    name: string;
    labels?: Record<string, string>;
  };
  wal?: {
    /** Root dir for WAL files. Default: ${os.tmpdir()}/clearvoiance-wal */
    dir?: string;
    /** Hard cap; past this, append drops batches. Default 1 GB. */
    maxBytes?: number;
    /** Set true to skip disk entirely (batches lost on engine down). Default false. */
    disabled?: boolean;
  };
  reconnect?: {
    /** Default 500 ms. */
    initialBackoffMs?: number;
    /** Default 30 000 ms. */
    maxBackoffMs?: number;
  };
}

export interface SessionHandle {
  id: string;
  maxBatchSize: number;
  maxEventsPerSecond: number;
  recommendedFlushIntervalMs: bigint;
}

export interface StopResult {
  stoppedAtNs: bigint;
  eventsCaptured: bigint;
  bytesCaptured: bigint;
}

export class Client {
  private readonly config: ClientConfig;
  private readonly grpc: CaptureServiceClient;
  private session: SessionHandle | null = null;
  private stream: ClientDuplexStream<StreamEventsRequest, StreamEventsResponse> | null = null;
  private streamHealthy = false;
  private nextBatchId = 1n;
  /** Tracks in-flight async work so stop() can drain before closing. */
  private readonly inflight = new Set<Promise<unknown>>();

  private wal: WAL | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAttempt = 0;
  private draining = false;
  private shuttingDown = false;

  constructor(config: ClientConfig) {
    this.config = config;
    const creds = config.engine.tls ? credentials.createSsl() : credentials.createInsecure();
    this.grpc = new CaptureServiceClient(config.engine.url, creds);
  }

  /** Opens a session with the engine and performs the StreamEvents handshake. */
  async start(): Promise<SessionHandle> {
    if (this.session) return this.session;

    const startResp = await new Promise<{ sessionId: string; startedAtNs: bigint }>(
      (resolve, reject) => {
        this.grpc.startSession(
          {
            name: this.config.session.name,
            apiKey: this.config.engine.apiKey,
            labels: this.config.session.labels ?? {},
            config: undefined,
          },
          (err, resp) => {
            if (err) return reject(err);
            resolve(resp);
          },
        );
      },
    );

    if (!this.config.wal?.disabled) {
      this.wal = new WAL({
        dir: this.config.wal?.dir ?? defaultWalDir(),
        sessionId: startResp.sessionId,
        maxBytes: this.config.wal?.maxBytes,
      });
      await this.wal.init();
    }

    const ack = await this.openStream(startResp.sessionId);

    this.session = {
      id: startResp.sessionId,
      maxBatchSize: ack.maxBatchSize,
      maxEventsPerSecond: ack.maxEventsPerSecond,
      recommendedFlushIntervalMs: ack.recommendedFlushIntervalMs,
    };

    this.streamHealthy = true;
    return this.session;
  }

  /**
   * Sends a batch. Resolves when the batch is either acked by the engine or
   * durably written to the WAL. Rejects only on internal errors (disk full
   * + WAL disabled, etc.).
   */
  async sendBatch(events: Event[]): Promise<void> {
    if (!this.session) {
      throw new Error("client not started — call start() before sendBatch()");
    }
    const batchId = this.nextBatchId++;

    if (this.streamHealthy && this.stream) {
      try {
        await this.track(this.sendOverStream(this.stream, batchId, events));
        return;
      } catch (err) {
        this.markStreamFailed(err);
        // fall through to WAL path
      }
    }

    await this.persistToWAL(batchId, events);
  }

  /**
   * Registers a pending async operation so `stop()` drains it before closing.
   */
  track<T>(p: Promise<T>): Promise<T> {
    const wrapped = p.finally(() => this.inflight.delete(wrapped));
    this.inflight.add(wrapped);
    return wrapped;
  }

  /** Uploads `data` to the engine's blob store and returns a BlobRef. */
  async uploadBlob(data: Buffer, opts: { contentType?: string } = {}): Promise<BlobRef> {
    if (!this.session) {
      throw new Error("client not started — call start() before uploadBlob()");
    }
    const sessionId = this.session.id;
    const sha256 = createHash("sha256").update(data).digest("hex");
    const sizeBytes = BigInt(data.length);
    const contentType = opts.contentType ?? "application/octet-stream";

    const presign = await new Promise<{
      uploadUrl: string;
      bucket: string;
      key: string;
      requiredHeaders: Record<string, string>;
    }>((resolve, reject) => {
      this.grpc.getBlobUploadUrl(
        { sessionId, sha256, sizeBytes, contentType },
        (err: Error | null, resp) => {
          if (err) return reject(err);
          resolve({
            uploadUrl: resp.uploadUrl,
            bucket: resp.bucket,
            key: resp.key,
            requiredHeaders: resp.requiredHeaders,
          });
        },
      );
    });

    const resp = await fetch(presign.uploadUrl, {
      method: "PUT",
      headers: presign.requiredHeaders,
      body: data,
    });
    if (!resp.ok) {
      throw new Error(`blob upload failed: ${resp.status} ${await safeText(resp)}`);
    }
    return { bucket: presign.bucket, key: presign.key, sha256 };
  }

  /** Stops the session and returns final counters. */
  async stop(opts: { flushTimeoutMs?: number } = {}): Promise<StopResult> {
    if (!this.session) {
      throw new Error("client not started");
    }
    const sessionId = this.session.id;
    const flushTimeoutMs = opts.flushTimeoutMs ?? 2000;

    this.shuttingDown = true;
    this.clearReconnect();

    // Drain in-flight sends before closing.
    if (this.inflight.size > 0) {
      await Promise.race([
        Promise.allSettled([...this.inflight]),
        new Promise((resolve) => setTimeout(resolve, flushTimeoutMs)),
      ]);
    }

    if (this.stream) {
      this.stream.end();
      this.stream = null;
    }
    this.streamHealthy = false;

    const result = await new Promise<StopResult>((resolve, reject) => {
      this.grpc.stopSession(
        { sessionId, apiKey: this.config.engine.apiKey },
        (err, resp) => {
          if (err) return reject(err);
          resolve({
            stoppedAtNs: resp.stoppedAtNs,
            eventsCaptured: resp.eventsCaptured,
            bytesCaptured: resp.bytesCaptured,
          });
        },
      );
    });

    this.session = null;
    this.grpc.close();
    return result;
  }

  // --- internal ------------------------------------------------------------

  private sendOverStream(
    stream: ClientDuplexStream<StreamEventsRequest, StreamEventsResponse>,
    batchId: bigint,
    events: Event[],
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const onData = (msg: StreamEventsResponse): void => {
        if (msg.batchAck && msg.batchAck.batchId === batchId) {
          stream.off("data", onData);
          stream.off("error", onErr);
          resolve();
        }
      };
      const onErr = (err: Error): void => {
        stream.off("data", onData);
        reject(err);
      };
      stream.on("data", onData);
      stream.on("error", onErr);

      stream.write({ batch: { events, batchId } });
    });
  }

  private markStreamFailed(err: unknown): void {
    this.streamHealthy = false;
    this.stream = null;
    if (!this.shuttingDown) {
      // eslint-disable-next-line no-console
      console.warn(
        "[clearvoiance] stream unhealthy, failing over to WAL:",
        (err as Error)?.message ?? String(err),
      );
      this.scheduleReconnect();
    }
  }

  private async persistToWAL(batchId: bigint, events: Event[]): Promise<void> {
    if (!this.wal) {
      throw new Error("engine unreachable and WAL disabled");
    }
    const res = await this.wal.append(batchId, events);
    if (!res.persisted) {
      throw new Error(`WAL full: ${res.reason}`);
    }
    // Make sure the reconnect loop is armed even if stream never started.
    if (!this.streamHealthy && !this.shuttingDown) this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.shuttingDown || !this.session) return;
    const cfg = this.config.reconnect ?? {};
    const initial = cfg.initialBackoffMs ?? 500;
    const cap = cfg.maxBackoffMs ?? 30_000;
    const delay = Math.min(initial * Math.pow(2, this.reconnectAttempt), cap);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.tryReconnect();
    }, delay);
  }

  private clearReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private async tryReconnect(): Promise<void> {
    if (!this.session || this.shuttingDown) return;
    this.reconnectAttempt += 1;
    try {
      await this.openStream(this.session.id);
      this.streamHealthy = true;
      this.reconnectAttempt = 0;
      // eslint-disable-next-line no-console
      console.info("[clearvoiance] stream reconnected, draining WAL");
      void this.drainWAL();
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(
        "[clearvoiance] reconnect attempt failed:",
        (err as Error)?.message ?? String(err),
      );
      this.scheduleReconnect();
    }
  }

  private async drainWAL(): Promise<void> {
    if (!this.wal || this.draining) return;
    this.draining = true;
    try {
      for (;;) {
        if (!this.streamHealthy || !this.stream) return;
        const entries = await this.wal.list();
        if (entries.length === 0) return;
        for (const entry of entries) {
          if (!this.streamHealthy || !this.stream) return;
          try {
            await this.sendOverStream(this.stream, entry.batchId, entry.events);
            await this.wal.remove(entry);
          } catch (err) {
            this.markStreamFailed(err);
            return;
          }
        }
      }
    } finally {
      this.draining = false;
    }
  }

  /** Opens the StreamEvents bidi stream and waits for the HandshakeAck. */
  private openStream(sessionId: string): Promise<{
    maxBatchSize: number;
    maxEventsPerSecond: number;
    recommendedFlushIntervalMs: bigint;
  }> {
    const stream = this.grpc.streamEvents();
    this.stream = stream;

    stream.on("error", (err: Error) => {
      this.markStreamFailed(err);
    });

    return new Promise((resolve, reject) => {
      const onData = (msg: StreamEventsResponse): void => {
        if (msg.ack) {
          stream.off("data", onData);
          stream.off("error", onErr);
          resolve({
            maxBatchSize: msg.ack.maxBatchSize,
            maxEventsPerSecond: msg.ack.maxEventsPerSecond,
            recommendedFlushIntervalMs: msg.ack.recommendedFlushIntervalMs,
          });
        }
      };
      const onErr = (err: Error): void => reject(err);

      stream.on("data", onData);
      stream.on("error", onErr);

      stream.write({
        handshake: {
          sessionId,
          sdkVersion: `@clearvoiance/node@${SDK_VERSION}`,
          apiKey: this.config.engine.apiKey,
          clientMetadata: {},
        },
      });
    });
  }
}

/** Creates a new Client. Does not open a session — call start() for that. */
export function createClient(config: ClientConfig): Client {
  return new Client(config);
}

function defaultWalDir(): string {
  // Process-scoped subdir so two processes on the same host don't stomp each
  // other's WALs. Production deployments should set an explicit `wal.dir`
  // on a persistent mount.
  return path.join(os.tmpdir(), "clearvoiance-wal", `pid-${process.pid}`);
}

async function safeText(resp: Response): Promise<string> {
  try {
    return (await resp.text()).slice(0, 200);
  } catch {
    return "<unreadable body>";
  }
}
