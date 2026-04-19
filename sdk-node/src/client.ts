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

import {
  credentials,
  type ClientDuplexStream,
  type ClientReadableStream,
} from "@grpc/grpc-js";
import {
  CaptureServiceClient,
  type StreamEventsRequest,
  type StreamEventsResponse,
} from "./generated/clearvoiance/v1/capture.js";
import {
  ControlServiceClient,
  type ControlCommand,
} from "./generated/clearvoiance/v1/control.js";
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
  /**
   * Session block used only when `remote` is not set. Describes the
   * single long-lived capture session the SDK creates on start().
   */
  session: {
    name: string;
    labels?: Record<string, string>;
  };
  /**
   * Remote-control mode. When set, start() does NOT open a capture
   * session — it subscribes to the engine's ControlService and waits
   * idle until the dashboard pushes a StartCapture command. Each
   * start/stop cycle initiated from the dashboard creates a distinct
   * capture session; the SDK attaches to the engine-pre-created
   * session id and flushes cleanly on StopCapture.
   *
   * In remote mode:
   *   - sendBatch() is a no-op when no capture is active (drops silently)
   *   - adapters keep their usual API — they don't need to know about
   *     the start/stop cycles
   *   - the control stream auto-reconnects with backoff on drops
   */
  remote?: {
    clientName: string;            // stable identity, e.g. "coldfire-strapi"
    displayName?: string;          // human label for the dashboard
    labels?: Record<string, string>;
    sdkLanguage?: string;          // default "node"
    instanceId?: string;           // default os.hostname()
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
  private readonly controlGrpc: ControlServiceClient;
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

  // Remote-control (option-3 architecture): control stream lives
  // for the whole client lifetime, independently of the capture
  // session which cycles with Start/Stop commands.
  private controlStream: ClientReadableStream<ControlCommand> | null = null;
  private controlReconnectTimer: NodeJS.Timeout | null = null;
  private controlReconnectAttempt = 0;
  /** Set true once we've warned about sendBatch being dropped; we only
   *  log this once per remote-waiting period to avoid flooding. */
  private loggedDropWhileIdle = false;

  constructor(config: ClientConfig) {
    this.config = config;
    const creds = config.engine.tls ? credentials.createSsl() : credentials.createInsecure();
    this.grpc = new CaptureServiceClient(config.engine.url, creds);
    this.controlGrpc = new ControlServiceClient(config.engine.url, creds);
  }

  /**
   * Starts the client.
   *
   *  - In default mode: opens a capture session immediately and returns
   *    the session handle.
   *  - In remote mode (`config.remote`): opens a ControlService.Subscribe
   *    stream and waits for the dashboard to push StartCapture. Returns
   *    null — no session is active yet.
   *
   * Adapters shouldn't branch on the return value; they keep calling
   * sendBatch() and the client handles the rest internally.
   */
  async start(): Promise<SessionHandle | null> {
    if (this.config.remote) {
      this.openControlStream();
      return null;
    }
    if (this.session) return this.session;
    return this.openSession({
      name: this.config.session.name,
      labels: this.config.session.labels,
    });
  }

  /**
   * Opens a capture session + StreamEvents stream against the engine.
   * Called directly by non-remote start(), and indirectly by the
   * remote control-command handler when StartCapture arrives with a
   * preferred session id.
   */
  private async openSession(params: {
    name: string;
    labels?: Record<string, string>;
    preferredId?: string;
  }): Promise<SessionHandle> {
    const startResp = await new Promise<{ sessionId: string; startedAtNs: bigint }>(
      (resolve, reject) => {
        this.grpc.startSession(
          {
            name: params.name,
            apiKey: this.config.engine.apiKey,
            labels: params.labels ?? {},
            config: undefined,
            preferredSessionId: params.preferredId ?? "",
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
    this.loggedDropWhileIdle = false;
    return this.session;
  }

  /**
   * Sends a batch. Resolves when the batch is either acked by the engine or
   * durably written to the WAL. Rejects only on internal errors (disk full
   * + WAL disabled, etc.).
   */
  async sendBatch(events: Event[]): Promise<void> {
    if (!this.session) {
      // Remote mode waiting for the dashboard to click Start — drop
      // events silently. Log once per idle stretch so it's obvious
      // from the logs that capture is inactive without flooding.
      if (this.config.remote) {
        if (!this.loggedDropWhileIdle) {
          this.loggedDropWhileIdle = true;
          // eslint-disable-next-line no-console
          console.info(
            "[clearvoiance] capture idle — events are dropped until the dashboard starts a session",
          );
        }
        return;
      }
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
      alreadyExists: boolean;
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
            alreadyExists: resp.alreadyExists,
          });
        },
      );
    });

    // Engine already has this blob (same session + sha256) → skip the PUT.
    if (presign.alreadyExists) {
      return { bucket: presign.bucket, key: presign.key, sha256 };
    }

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

  /**
   * Stops the client. In default mode: closes the active session and
   * returns its final counters. In remote mode: closes the control
   * stream + any active capture session, tears down the gRPC clients.
   *
   * Always safe to call multiple times; returns a zero StopResult when
   * there's nothing active.
   */
  async stop(opts: { flushTimeoutMs?: number } = {}): Promise<StopResult> {
    this.shuttingDown = true;
    this.clearReconnect();
    this.clearControlReconnect();

    // Close control stream first so the server stops pushing commands
    // into a client that's on its way out.
    this.closeControlStream();

    let result: StopResult = {
      stoppedAtNs: 0n,
      eventsCaptured: 0n,
      bytesCaptured: 0n,
    };
    if (this.session) {
      result = await this.closeSession(opts);
    }

    this.grpc.close();
    this.controlGrpc.close();
    return result;
  }

  /**
   * Closes the currently-open capture session without touching the
   * control stream. Called by:
   *  - stop() (non-remote shutdown)
   *  - the StopCapture control-command handler (remote, capture cycles)
   *  - the StartCapture handler if a previous session is still open
   *    (defensive; the engine wouldn't normally send Start without a
   *    prior Stop, but we don't want to leak a stream).
   */
  private async closeSession(opts: { flushTimeoutMs?: number } = {}): Promise<StopResult> {
    if (!this.session) {
      return { stoppedAtNs: 0n, eventsCaptured: 0n, bytesCaptured: 0n };
    }
    const sessionId = this.session.id;
    const flushTimeoutMs = opts.flushTimeoutMs ?? 2000;

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

    let result: StopResult;
    try {
      result = await new Promise<StopResult>((resolve, reject) => {
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
    } catch (err) {
      // In remote mode the engine may have already stopped the session
      // in response to its own dashboard-side action; tolerate that so
      // we don't crash on the subsequent ack.
      if (this.config.remote) {
        // eslint-disable-next-line no-console
        console.info(
          "[clearvoiance] closeSession(): stop call rejected (likely already stopped)",
          (err as Error)?.message ?? String(err),
        );
        result = { stoppedAtNs: 0n, eventsCaptured: 0n, bytesCaptured: 0n };
      } else {
        throw err;
      }
    }

    this.session = null;
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

  // --- remote control -----------------------------------------------------
  //
  // openControlStream is non-blocking: it kicks off the Subscribe RPC and
  // returns. Commands arrive asynchronously on `data` events. Drops +
  // errors schedule a reconnect with exponential backoff, so the SDK is
  // resilient to transient engine outages the same way capture streams are.

  private openControlStream(): void {
    if (this.controlStream || this.shuttingDown) return;
    const cfg = this.config.remote;
    if (!cfg) return;

    // node:os is already imported at the top for defaultWalDir.
    const stream = this.controlGrpc.subscribe({
      clientName: cfg.clientName,
      displayName: cfg.displayName ?? cfg.clientName,
      labels: cfg.labels ?? {},
      sdkLanguage: cfg.sdkLanguage ?? "node",
      sdkVersion: SDK_VERSION,
      instanceId: cfg.instanceId ?? os.hostname(),
    });
    this.controlStream = stream;
    this.controlReconnectAttempt = 0;

    stream.on("data", (cmd: ControlCommand) => {
      // Fire-and-forget — any command-handler error logs itself, we
      // don't want to kill the stream on a transient StartCapture hiccup.
      void this.handleControlCommand(cmd);
    });
    stream.on("error", (err: Error) => {
      if (this.shuttingDown) return;
      // eslint-disable-next-line no-console
      console.warn(
        "[clearvoiance] control stream error, reconnecting:",
        err?.message ?? String(err),
      );
      this.controlStream = null;
      this.scheduleControlReconnect();
    });
    stream.on("end", () => {
      if (this.shuttingDown) return;
      this.controlStream = null;
      this.scheduleControlReconnect();
    });
  }

  private async handleControlCommand(cmd: ControlCommand): Promise<void> {
    if (cmd.start) {
      const start = cmd.start;
      // Idempotent: duplicate StartCapture for the session we already
      // have is a no-op (engine-side reconnect resume can emit this).
      if (this.session?.id === start.sessionId) return;
      // Defensive: close any previous session before attaching to a new one.
      if (this.session) {
        try {
          await this.closeSession({ flushTimeoutMs: 5_000 });
        } catch {
          // closeSession in remote mode already swallows its own errors.
        }
      }
      try {
        await this.openSession({
          name: start.sessionName || this.config.session?.name || start.sessionId,
          labels: start.sessionLabels ?? {},
          preferredId: start.sessionId,
        });
        // eslint-disable-next-line no-console
        console.info(
          "[clearvoiance] capture started from dashboard:",
          start.sessionId,
        );
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(
          "[clearvoiance] failed to attach session from dashboard:",
          (err as Error)?.message ?? String(err),
        );
      }
      return;
    }
    if (cmd.stop) {
      const stop = cmd.stop;
      if (!this.session || this.session.id !== stop.sessionId) return;
      const flushTimeoutMs = Number(stop.flushTimeoutMs) || 10_000;
      try {
        await this.closeSession({ flushTimeoutMs });
        // eslint-disable-next-line no-console
        console.info(
          "[clearvoiance] capture stopped from dashboard:",
          stop.sessionId,
        );
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(
          "[clearvoiance] error closing dashboard-stopped session:",
          (err as Error)?.message ?? String(err),
        );
      }
      return;
    }
    if (cmd.ping) {
      // gRPC keepalive does the real work; this is just observable
      // proof-of-life for the engine's monitor-row heartbeat.
      return;
    }
  }

  private scheduleControlReconnect(): void {
    if (this.controlReconnectTimer || this.shuttingDown || !this.config.remote) {
      return;
    }
    const cfg = this.config.reconnect ?? {};
    const initial = cfg.initialBackoffMs ?? 500;
    const cap = cfg.maxBackoffMs ?? 30_000;
    const delay = Math.min(
      initial * Math.pow(2, this.controlReconnectAttempt),
      cap,
    );
    this.controlReconnectTimer = setTimeout(() => {
      this.controlReconnectTimer = null;
      this.controlReconnectAttempt += 1;
      this.openControlStream();
    }, delay);
  }

  private clearControlReconnect(): void {
    if (this.controlReconnectTimer) {
      clearTimeout(this.controlReconnectTimer);
      this.controlReconnectTimer = null;
    }
  }

  private closeControlStream(): void {
    if (this.controlStream) {
      try {
        this.controlStream.cancel();
      } catch {
        /* already closed */
      }
      this.controlStream = null;
    }
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
