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
  /**
   * Optional replay id for the current request. Set by HTTP adapters when
   * they see an `X-Clearvoiance-Replay-Id` header on the inbound request
   * (dispatched by the engine during a replay). Propagated to DB
   * observations so the dashboard can filter by replay without any
   * process-level replayId config.
   */
  replayId?: string;
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

/** Returns the active replay id, or undefined when the request isn't a replay. */
export function currentReplayId(): string | undefined {
  return storage.getStore()?.replayId;
}

/** Standardised header the replay engine stamps on every dispatched request. */
export const REPLAY_ID_HEADER = "x-clearvoiance-replay-id";

/**
 * Extracts the replay id from a headers-like shape. Handles both Node
 * IncomingMessage.headers (lowercase keys, string | string[]) and Fetch
 * Headers (case-insensitive get()).
 */
export function extractReplayId(
  headers: unknown,
): string | undefined {
  if (!headers) return undefined;
  // Fetch Headers shape.
  if (typeof (headers as { get?: unknown }).get === "function") {
    const v = (headers as { get(k: string): string | null }).get(
      REPLAY_ID_HEADER,
    );
    return v ?? undefined;
  }
  const h = headers as Record<string, string | string[] | undefined>;
  const raw = h[REPLAY_ID_HEADER] ?? h[REPLAY_ID_HEADER.toUpperCase()];
  if (Array.isArray(raw)) return raw[0];
  return raw;
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
