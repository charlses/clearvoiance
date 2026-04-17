/**
 * Phase 1a SDK client — opens a session with the engine, streams event
 * batches, and closes the session on stop(). No redaction, no batching
 * scheduler, no WAL — those arrive in subsequent phases.
 */

import { createHash } from "node:crypto";

import { credentials, type ClientDuplexStream } from "@grpc/grpc-js";
import {
  CaptureServiceClient,
  type StreamEventsRequest,
  type StreamEventsResponse,
} from "./generated/clearvoiance/v1/capture.js";
import type { BlobRef, Event } from "./generated/clearvoiance/v1/event.js";
import { SDK_VERSION } from "./version.js";

export { SDK_VERSION };

export interface ClientConfig {
  engine: {
    url: string; // e.g. "127.0.0.1:9100"
    apiKey: string;
    tls?: boolean; // default false — Phase 1a runs in loopback
  };
  session: {
    name: string;
    labels?: Record<string, string>;
  };
}

export interface SessionHandle {
  /** Engine-issued session ID. */
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
  private nextBatchId = 1n;
  /** Tracks in-flight async work so stop() can drain before closing. */
  private readonly inflight = new Set<Promise<unknown>>();

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

    const ack = await this.openStream(startResp.sessionId);

    this.session = {
      id: startResp.sessionId,
      maxBatchSize: ack.maxBatchSize,
      maxEventsPerSecond: ack.maxEventsPerSecond,
      recommendedFlushIntervalMs: ack.recommendedFlushIntervalMs,
    };

    return this.session;
  }

  /**
   * Sends a batch of events. Returns when the engine acks it.
   * Throws if the session is not started or the stream is closed.
   */
  async sendBatch(events: Event[]): Promise<void> {
    if (!this.session || !this.stream) {
      throw new Error("client not started — call start() before sendBatch()");
    }
    const batchId = this.nextBatchId++;
    const stream = this.stream;

    const ack = new Promise<void>((resolve, reject) => {
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
    });

    stream.write({
      batch: { events, batchId },
    });

    return this.track(ack);
  }

  /**
   * Registers a pending async operation with the client so `stop()` can drain
   * it before closing the stream. Adapters use this for their whole capture
   * IIFE (finalizeBody + uploadBlob + sendBatch) so a blob upload in progress
   * when shutdown starts doesn't get cut off.
   */
  track<T>(p: Promise<T>): Promise<T> {
    const wrapped = p.finally(() => this.inflight.delete(wrapped));
    this.inflight.add(wrapped);
    return wrapped;
  }

  /**
   * Uploads `data` to the engine's blob store, returning a BlobRef that
   * adapters can embed in an Event's Body. Throws if the engine has no blob
   * backend (callers should catch and fall back to inline/truncate).
   */
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

    // Drain in-flight batches before ending the stream. Capped so a misbehaving
    // engine can't block shutdown indefinitely.
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

  /** Opens the StreamEvents bidi stream and waits for the HandshakeAck. */
  private openStream(sessionId: string): Promise<{
    maxBatchSize: number;
    maxEventsPerSecond: number;
    recommendedFlushIntervalMs: bigint;
  }> {
    const stream = this.grpc.streamEvents();
    this.stream = stream;

    // Persistent error listener: 'error' on a Duplex stream without a listener
    // crashes Node. Once we hand the stream around to sendBatch + the handshake
    // promise, we need a catch-all that logs but doesn't rethrow so that an
    // engine crash / network blip can't take down the user's app.
    stream.on("error", (err: Error) => {
      // eslint-disable-next-line no-console
      console.warn("[clearvoiance] gRPC stream error:", err.message);
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

async function safeText(resp: Response): Promise<string> {
  try {
    return (await resp.text()).slice(0, 200);
  } catch {
    return "<unreadable body>";
  }
}
