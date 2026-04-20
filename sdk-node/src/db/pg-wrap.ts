/**
 * Shared internals for the Postgres-based DB adapters. The node-postgres
 * driver (`pg`) is what ultimately runs SQL whether you're calling pg
 * directly, going through Knex, TypeORM with the pg driver, or any other
 * ORM that sits on pg.Client. Every one of those paths ends up with a
 * `pg.Client` instance whose `.query()` method we want to wrap with a
 * `SET application_name = 'clv:<eventId>'` prefix so the db-observer
 * can correlate queries back to capture/replay events.
 *
 * This module isolates that wrapping so the per-driver adapters
 * (postgres.ts, knex.ts, …) only have to handle driver-specific
 * "how do I reach the pg.Client instance when one is created?" logic
 * and defer the actual query rewriting here.
 */

import { currentEventId } from "../core/event-context.js";
import { emitDbObservation, type EmitConfig } from "./emit.js";
import { sqlFingerprint } from "./sql-fingerprint.js";

/** Minimal pg.Client shape we need; a typeof dance to avoid pulling `pg` into our type graph. */
export interface PgClientLike {
  query: (...args: unknown[]) => unknown;
}

export interface WrapOptions {
  /** Builds the application_name to SET for a given event id. */
  appNameFor: (eventId: string) => string;
  /** Called on any SET-statement failure. Defaults to silent. */
  onError?: (err: unknown) => void;
  /**
   * Optional: enable SDK-side per-query DbObservationEvent emission.
   * When set, every query on this client that crosses `emit.slowThresholdMs`
   * becomes a DbObservationEvent streamed through `emit.client.sendBatch`.
   * Independent of observer-based correlation — you can run both.
   */
  emit?: EmitConfig & { adapter: string };
}

/**
 * Wraps a pg.Client's `.query()` method so every subsequent query on
 * that same client runs `SET application_name` first whenever the
 * current event scope (see `currentEventId()`) has changed since the
 * last query on the connection. pg-node serializes queries per-client
 * so this is race-free by construction.
 *
 * Idempotent: calling twice on the same client leaves the wrapping in
 * place without double-wrapping. The tag guards against that.
 */
const CLV_WRAPPED = Symbol.for("@clearvoiance/node/db/pg-wrap/wrapped");

export function wrapPgClientWithAppName(
  client: PgClientLike,
  opts: WrapOptions,
): void {
  const tagged = client as PgClientLike & { [CLV_WRAPPED]?: boolean };
  if (tagged[CLV_WRAPPED]) return;

  const orig = client.query.bind(client);
  const onError = opts.onError ?? ((): void => {});

  // Track the last event id pinned on this connection. SET is session-
  // level so once set it persists across queries on the same client;
  // we only re-SET when the current event id differs.
  let lastPinned: string | undefined;

  const emit = opts.emit;

  const patched = function patchedQuery(this: unknown, ...args: unknown[]): unknown {
    const eventId = currentEventId();
    const needsSet = eventId !== undefined && eventId !== lastPinned;

    // Fast path: no scope change and no emit → zero-overhead passthrough.
    if (!needsSet && !emit) return orig(...args);

    const appName = eventId ? opts.appNameFor(eventId).replace(/'/g, "''") : "";
    const setSQL = appName ? `SET application_name = '${appName}'` : "";
    const isCallbackMode =
      args.length > 0 && typeof args[args.length - 1] === "function";

    // Pull out the SQL string (first arg is text or a config object with .text).
    const sqlText = extractSqlText(args[0]);

    if (isCallbackMode) {
      // Callback mode — used by pool.query() and some older client code.
      const userCb = args[args.length - 1] as (err: unknown, res: unknown) => void;
      const userArgs = args.slice(0, -1);
      const wrappedCb = emit
        ? wrapCallbackForEmit(userCb, sqlText, emit)
        : userCb;
      Promise.resolve()
        .then(() => (needsSet ? orig(setSQL) : undefined))
        .then(() => {
          if (needsSet) lastPinned = eventId;
        })
        .catch((err) => onError(err))
        .then(() => {
          orig(...userArgs, wrappedCb);
        });
      return undefined;
    }

    // Promise mode — the common path. pg@9 deprecates enqueuing a
    // second query while one is pending, so we await the SET before
    // firing the user query. The extra RTT is paid only when the
    // event scope changes (first query per new connection or scope
    // flip), not per query.
    return (async () => {
      if (needsSet) {
        try {
          await orig(setSQL);
          lastPinned = eventId;
        } catch (err) {
          onError(err);
          // Fall through and run the user query even if SET failed —
          // correctness of the user's work beats capture fidelity.
        }
      }
      if (!emit) return orig(...args);

      const startNs = process.hrtime.bigint();
      try {
        const res = await orig(...args);
        emitDbObservation(emit, {
          adapter: emit.adapter,
          startNs,
          endNs: process.hrtime.bigint(),
          queryText: truncate(sqlText, 1000),
          fingerprint: sqlFingerprint(sqlText),
          rowsAffected: rowsAffectedFromPgResult(res),
        });
        return res;
      } catch (err) {
        // Re-throw the original error — emission failure shouldn't swallow
        // the user's DB error. We still emit so failed-slow queries are
        // visible in the dashboard.
        emitDbObservation(emit, {
          adapter: emit.adapter,
          startNs,
          endNs: process.hrtime.bigint(),
          queryText: truncate(sqlText, 1000),
          fingerprint: sqlFingerprint(sqlText),
          metadata: { status: "error" },
        });
        throw err;
      }
    })();
  };

  (client as { query: typeof patched }).query = patched;
  tagged[CLV_WRAPPED] = true;
}

/**
 * Builds the conventional `clv:<replayId?>:<eventId>` application_name
 * with a 63-char truncation to fit Postgres's app-name limit. Shared
 * between adapters so the observer's single parser (parseClvAppName)
 * matches every adapter without each reimplementing the convention.
 */
export function makeAppNameBuilder(opts: {
  appPrefix?: string;
  replayId?: string;
}): (eventId: string) => string {
  const prefix = opts.appPrefix ?? "clv:";
  const replayId = opts.replayId ?? "";
  return (eventId: string): string => {
    const raw = replayId ? `${prefix}${replayId}:${eventId}` : `${prefix}${eventId}`;
    return raw.length > 63 ? raw.slice(0, 63) : raw;
  };
}

function extractSqlText(firstArg: unknown): string {
  if (typeof firstArg === "string") return firstArg;
  if (firstArg && typeof firstArg === "object") {
    const obj = firstArg as { text?: unknown; name?: unknown };
    if (typeof obj.text === "string") return obj.text;
    if (typeof obj.name === "string") return obj.name;
  }
  return "";
}

function rowsAffectedFromPgResult(res: unknown): bigint | undefined {
  if (!res || typeof res !== "object") return undefined;
  const r = res as { rowCount?: unknown };
  if (typeof r.rowCount === "number" && Number.isFinite(r.rowCount)) {
    return BigInt(r.rowCount);
  }
  return undefined;
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max);
}

function wrapCallbackForEmit(
  userCb: (err: unknown, res: unknown) => void,
  sqlText: string,
  emit: EmitConfig & { adapter: string },
): (err: unknown, res: unknown) => void {
  const startNs = process.hrtime.bigint();
  return (err: unknown, res: unknown): void => {
    emitDbObservation(emit, {
      adapter: emit.adapter,
      startNs,
      endNs: process.hrtime.bigint(),
      queryText: truncate(sqlText, 1000),
      fingerprint: sqlFingerprint(sqlText),
      rowsAffected: rowsAffectedFromPgResult(res),
      metadata: err ? { status: "error" } : undefined,
    });
    userCb(err, res);
  };
}
