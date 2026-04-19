/**
 * BullMQ queue capture adapter. Wraps a processor function so every job
 * the worker consumes becomes a QueueEvent. Also seeds the event-context
 * so DB + outbound adapters correlate child operations back to the job.
 *
 * Usage:
 *
 * ```ts
 * import { Worker } from "bullmq";
 * import { createClient } from "@clearvoiance/node";
 * import { captureBullMQ } from "@clearvoiance/node/queue/bullmq";
 *
 * const client = createClient({ engine: {...}, session: {...} });
 * await client.start();
 *
 * const worker = new Worker(
 *   "emails",
 *   captureBullMQ(client, "emails", async (job) => {
 *     // your job logic
 *   }),
 *   { connection: { host: "localhost", port: 6379 } },
 * );
 * ```
 *
 * The wrapper mirrors the node-cron adapter's contract: re-throws on
 * failure so BullMQ's retry semantics still kick in, measures duration
 * via `process.hrtime.bigint()`, and captures the resulting status
 * ("success" | "error") alongside the error message.
 */

import { newEventId, runWithEvent } from "../../core/event-context.js";
import type {
  BlobRef,
  Event as PbEvent,
  QueueEvent as PbQueueEvent,
} from "../../generated/clearvoiance/v1/event.js";
import { SDK_VERSION } from "../../version.js";

const ADAPTER_NAME = "queue.bullmq";
const BROKER_NAME = "bullmq";

/** Minimal shape of a BullMQ job. Kept narrow so we don't import bullmq. */
export interface BullMQJobLike<T = unknown> {
  id?: string | number | null;
  name: string;
  data: T;
  attemptsMade?: number;
}

export interface EventSink {
  sendBatch(events: PbEvent[]): Promise<void>;
  uploadBlob?(data: Buffer, opts?: { contentType?: string }): Promise<BlobRef>;
  track?<T>(p: Promise<T>): Promise<T>;
}

export interface CaptureBullMQOptions {
  /** Error sink; defaults to console.warn. Does NOT affect BullMQ's retry flow. */
  onError?: (err: unknown) => void;
}

/**
 * Wraps a BullMQ processor function so every job invocation emits a
 * QueueEvent. `queueName` is stashed on the event so downstream filters
 * can target specific queues.
 *
 * ```ts
 * new Worker("emails", captureBullMQ(client, "emails", async job => {...}));
 * ```
 */
export function captureBullMQ<T, R>(
  client: EventSink,
  queueName: string,
  processor: (job: BullMQJobLike<T>) => R | Promise<R>,
  opts: CaptureBullMQOptions = {},
): (job: BullMQJobLike<T>) => Promise<R> {
  const onError = opts.onError ?? defaultOnError;

  return async function wrappedProcessor(job: BullMQJobLike<T>): Promise<R> {
    const eventId = newEventId();
    const startHr = process.hrtime.bigint();
    const startWallNs = BigInt(Date.now()) * 1_000_000n;

    let status: "success" | "error" = "success";
    let errorMessage = "";
    let thrown: unknown = null;
    let result: R | undefined;

    try {
      result = await runWithEvent({ eventId }, async () => {
        return await processor(job);
      });
    } catch (err) {
      status = "error";
      errorMessage = err instanceof Error ? err.message : String(err);
      thrown = err;
    }

    const durationNs = process.hrtime.bigint() - startHr;

    const task = (async (): Promise<void> => {
      try {
        const event = buildEvent({
          eventId,
          queueName,
          job,
          startWallNs,
          durationNs,
          status,
          errorMessage,
        });
        await client.sendBatch([event]);
      } catch (sendErr) {
        onError(sendErr);
      }
    })();
    if (client.track) void client.track(task);

    if (thrown) throw thrown;
    return result!;
  };
}

function buildEvent(a: {
  eventId: string;
  queueName: string;
  job: BullMQJobLike<unknown>;
  startWallNs: bigint;
  durationNs: bigint;
  status: string;
  errorMessage: string;
}): PbEvent {
  const payloadBytes = serializeJobData(a.job.data);

  const queue: PbQueueEvent = {
    queueName: a.queueName,
    broker: BROKER_NAME,
    messageId: a.job.id != null ? String(a.job.id) : "",
    payload: payloadBytes
      ? {
          inline: payloadBytes,
          contentType: "application/json",
          sizeBytes: BigInt(payloadBytes.length),
          encoding: "utf-8",
        }
      : undefined,
    retryCount: a.job.attemptsMade ?? 0,
    durationNs: a.durationNs,
    status: a.status,
    headers: { job_name: a.job.name },
  };

  const ev: PbEvent = {
    id: a.eventId,
    sessionId: "",
    timestampNs: a.startWallNs,
    offsetNs: 0n,
    adapter: ADAPTER_NAME,
    sdkVersion: `@clearvoiance/node@${SDK_VERSION}`,
    metadata: { queue: a.queueName, job_name: a.job.name },
    redactionsApplied: [],
    queue,
  };
  if (a.errorMessage) ev.metadata["error"] = a.errorMessage;
  return ev;
}

function serializeJobData(data: unknown): Buffer | null {
  if (data == null) return null;
  try {
    return Buffer.from(JSON.stringify(data));
  } catch {
    return null;
  }
}

function defaultOnError(err: unknown): void {
  // eslint-disable-next-line no-console
  console.warn("[clearvoiance] bullmq capture failed:", err);
}
