/**
 * node-cron capture adapter.
 *
 * Wrap your cron callbacks with `captureCronJob(client, name, fn)` so each
 * invocation becomes a CronEvent: `job_name`, `scheduler`, `duration_ns`,
 * `status` (success/error), `error_message` on failure.
 *
 * ```ts
 * import cron from "node-cron";
 * import { createClient } from "@clearvoiance/node";
 * import { captureCronJob } from "@clearvoiance/node/cron/node-cron";
 *
 * const client = createClient({ engine: {...}, session: {...} });
 * await client.start();
 *
 * cron.schedule(
 *   "* * * * *",
 *   captureCronJob(client, "cleanup", async () => { ... }),
 * );
 * ```
 *
 * The wrapper:
 *   - measures duration with process.hrtime.bigint()
 *   - re-throws errors after capture so the scheduler's retry/skip logic
 *     behaves the same as without the wrap
 *   - seeds the AsyncLocalStorage event context so child DB queries /
 *     outbound calls correlate to this invocation (Phase 3/4)
 */

import { newEventId, runWithEvent } from "../../core/event-context.js";
import type {
  BlobRef,
  CronEvent as PbCronEvent,
  Event as PbEvent,
} from "../../generated/clearvoiance/v1/event.js";
import { SDK_VERSION } from "../../version.js";

const ADAPTER_NAME = "cron.node-cron";
const SCHEDULER_NAME = "node-cron";

/** Minimal client contract this adapter needs. */
export interface EventSink {
  sendBatch(events: PbEvent[]): Promise<void>;
  uploadBlob?(data: Buffer, opts?: { contentType?: string }): Promise<BlobRef>;
  track?<T>(p: Promise<T>): Promise<T>;
}

export interface CaptureCronOptions {
  /**
   * Source that triggered the invocation. Defaults to "schedule". Pass
   * "manual" when you're running the handler outside a schedule (e.g., from
   * a boot script), or "retry" if the scheduler gave you retry semantics.
   */
  triggerSource?: string;

  /**
   * Called with capture errors so a broken engine connection doesn't affect
   * cron execution. Defaults to console.warn.
   */
  onError?: (err: unknown) => void;
}

/** A cron callback shape compatible with both sync and async jobs. */
export type CronFn = (...args: unknown[]) => unknown | Promise<unknown>;

/**
 * Wraps a cron callback so each invocation is captured. The returned
 * function preserves the original signature and re-throws any error.
 */
export function captureCronJob(
  client: EventSink,
  jobName: string,
  fn: CronFn,
  opts: CaptureCronOptions = {},
): (...args: unknown[]) => Promise<unknown> {
  const trigger = opts.triggerSource ?? "schedule";
  const onError = opts.onError ?? defaultOnError;

  return async function wrappedCronJob(...args: unknown[]): Promise<unknown> {
    const eventId = newEventId();
    const startHr = process.hrtime.bigint();
    const startWallNs = BigInt(Date.now()) * 1_000_000n;

    let status = "success";
    let errorMessage = "";
    let thrown: unknown;

    try {
      return await runWithEvent({ eventId }, () => Promise.resolve(fn(...args)));
    } catch (err) {
      status = "error";
      errorMessage = err instanceof Error ? err.message : String(err);
      thrown = err;
      throw err;
    } finally {
      const durationNs = process.hrtime.bigint() - startHr;

      const cronEv: PbCronEvent = {
        jobName,
        scheduler: SCHEDULER_NAME,
        args: undefined,
        durationNs,
        status,
        errorMessage,
        triggerSource: trigger,
      };

      const event: PbEvent = {
        id: eventId,
        sessionId: "",
        timestampNs: startWallNs,
        offsetNs: 0n,
        adapter: ADAPTER_NAME,
        sdkVersion: `@clearvoiance/node@${SDK_VERSION}`,
        metadata: {},
        redactionsApplied: [],
        cron: cronEv,
      };

      try {
        const task = client.sendBatch([event]).catch(onError);
        if (client.track) void client.track(task);
      } catch (sendErr) {
        onError(sendErr);
      }
      // Suppress unused-var lint: thrown is captured so the finally block
      // can't accidentally overwrite the rejected promise's rejection reason.
      void thrown;
    }
  };
}

function defaultOnError(err: unknown): void {
  // eslint-disable-next-line no-console
  console.warn("[clearvoiance] cron capture failed:", err);
}
