/**
 * AsyncLocalStorage context that ties an inbound event (HTTP, socket, cron) to
 * anything it spawns: DB queries, outbound HTTP calls, queue publishes.
 *
 * Phase 1c sets the current event id at the middleware boundary. Phase 3
 * (outbound mocking) + Phase 4 (DB observer) will read it to correlate child
 * operations back to the originating event.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";

export interface EventContext {
  /** Unique id for the inbound event currently being handled. */
  eventId: string;
}

const storage = new AsyncLocalStorage<EventContext>();

/** Runs `fn` with the given EventContext installed. */
export function runWithEvent<T>(ctx: EventContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

/** Returns the active event id, or undefined when no capture is in flight. */
export function currentEventId(): string | undefined {
  return storage.getStore()?.eventId;
}

/**
 * Runs `fn` outside any active event scope. Useful when you need to make an
 * HTTP call (e.g. logging to the engine) from inside a scope and must not
 * trigger outbound capture or hermetic intercept on it.
 */
export function runOutsideEvent<T>(fn: () => T): T {
  return storage.exit(fn);
}

/**
 * Generates a new event id. UUID-v7-ish: 8-byte big-endian ms timestamp +
 * 8 bytes of randomness, hex-encoded. Timestamp-ordered so ClickHouse reads
 * stay sequential and binary search by time stays cheap.
 */
export function newEventId(): string {
  const tsMs = BigInt(Date.now());
  const buf = Buffer.alloc(16);
  buf.writeBigUInt64BE(tsMs, 0);
  randomBytes(8).copy(buf, 8);
  return `ev_${buf.toString("hex")}`;
}
