/**
 * Phase 1a SDK client — opens a session with the engine, streams event
 * batches, and closes the session on stop(). No redaction, no batching
 * scheduler, no WAL — those arrive in subsequent phases.
 */

import { credentials, type ClientDuplexStream } from "@grpc/grpc-js";
import {
  CaptureServiceClient,
  type StreamEventsRequest,
  type StreamEventsResponse,
} from "./generated/clearvoiance/v1/capture.js";
import type { Event } from "./generated/clearvoiance/v1/event.js";
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

    return ack;
  }

  /** Stops the session and returns final counters. */
  async stop(): Promise<StopResult> {
    if (!this.session) {
      throw new Error("client not started");
    }
    const sessionId = this.session.id;

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
