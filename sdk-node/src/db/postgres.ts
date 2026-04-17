/**
 * node-postgres (`pg`) instrumentation. During capture and replay, every
 * SQL statement the SUT runs must carry the originating event id through
 * Postgres's `application_name` connection setting so the db-observer can
 * correlate slow queries / locks back to the replay event that caused them.
 *
 * Usage:
 *
 * ```ts
 * import { Pool } from "pg";
 * import { instrumentPg } from "@clearvoiance/node/db/postgres";
 *
 * const pool = new Pool({ connectionString: process.env.DATABASE_URL });
 * instrumentPg(pool, { replayId: process.env.CLEARVOIANCE_REPLAY_ID });
 * ```
 *
 * Works for `pg.Pool` (and therefore anything that sits on top of it — Knex,
 * Prisma when using the pg adapter, TypeORM with pg driver). The
 * instrumentation hooks `pool.on('connect')`, which fires once per physical
 * connection. On every `client.query()` thereafter we prepend a
 * `SET application_name = 'clv:<replayId?>:<eventId>'` when an event scope
 * is active, and skip otherwise. Session-level SET persists across queries
 * on the same connection, so the next event's SET cleanly overwrites it.
 */

import { currentEventId } from "../core/event-context.js";

/**
 * Minimal shape we need from a pg.Pool instance. Deliberately narrow so
 * we don't pull `pg` into the SDK's type graph (it's a peer dep).
 */
interface PgPoolLike {
  on(event: "connect", listener: (client: PgClientLike) => void): unknown;
  off?(event: "connect", listener: (client: PgClientLike) => void): unknown;
  removeListener?(event: "connect", listener: (client: PgClientLike) => void): unknown;
}

interface PgClientLike {
  query: (...args: unknown[]) => unknown;
}

export interface InstrumentPgOptions {
  /**
   * Optional replay id. When set, every application_name becomes
   * `clv:<replayId>:<eventId>` so concurrent replays against the same DB
   * don't cross-attribute. Leave undefined during capture.
   */
  replayId?: string;
  /** Default "clv:". Override if clashing with an existing app-name scheme. */
  appPrefix?: string;
  /** Called on any SET-statement failure. Defaults to silent. */
  onError?: (err: unknown) => void;
}

export interface InstrumentPgHandle {
  /**
   * Stops instrumenting NEW connections. Connections already opened keep
   * their wrapped `query` method — pg has no clean way to swap it back
   * without re-invoking the driver's internals.
   */
  uninstall(): void;
}

/** Installs the instrumentation. Returns a handle whose `uninstall()` is a no-op for connections already issued by the pool. */
export function instrumentPg(
  pool: unknown,
  opts: InstrumentPgOptions = {},
): InstrumentPgHandle {
  const p = pool as PgPoolLike;
  const prefix = opts.appPrefix ?? "clv:";
  const replayId = opts.replayId ?? "";
  const onError = opts.onError ?? ((): void => {});

  const appNameFor = (eventId: string): string => {
    const raw = replayId ? `${prefix}${replayId}:${eventId}` : `${prefix}${eventId}`;
    // pg lets app names be up to 63 chars; truncate defensively so oversized
    // event ids don't break the SET statement.
    return raw.length > 63 ? raw.slice(0, 63) : raw;
  };

  const onConnect = (client: PgClientLike): void => {
    const orig = client.query.bind(client);

    // Track the last event id we SET for on this connection. pg-node serializes
    // queries per-client, so once we SET, every query that follows on the
    // same client inherits the app_name. We only re-SET when the current
    // event id differs from the last one we pinned.
    let lastPinned: string | undefined;

    const patched = function patchedQuery(this: unknown, ...args: unknown[]): unknown {
      const eventId = currentEventId();
      if (!eventId) return orig(...args);
      if (eventId === lastPinned) return orig(...args);

      const appName = appNameFor(eventId).replace(/'/g, "''");
      const setSQL = `SET application_name = '${appName}'`;
      const isCallbackMode =
        args.length > 0 && typeof args[args.length - 1] === "function";

      if (isCallbackMode) {
        // Callback mode — used internally by `pool.query()` and some older
        // client code. We run the SET via pg's promise interface (no
        // callback passed), then dispatch the user query preserving their
        // callback. If SET fails we still run the user query so a bad
        // observer doesn't break the app.
        const userCb = args[args.length - 1] as (
          err: unknown,
          res: unknown,
        ) => void;
        const userArgs = args.slice(0, -1);
        Promise.resolve()
          .then(() => orig(setSQL))
          .then(() => {
            lastPinned = eventId;
          })
          .catch((err) => onError(err))
          .then(() => {
            orig(...userArgs, userCb);
          });
        return undefined;
      }

      // Promise mode — the common path for modern code. pg@9 deprecates
      // enqueuing a second query while one is pending, so we await the SET
      // before firing the user query. The extra RTT is paid only when the
      // event scope changes (first query per new connection or scope flip),
      // not per query.
      return (async () => {
        try {
          await orig(setSQL);
          lastPinned = eventId;
        } catch (err) {
          onError(err);
          // Fall through and run the user query even if SET failed —
          // correctness of the user's work beats capture fidelity.
        }
        return orig(...args);
      })();
    };
    (client as { query: typeof patched }).query = patched;
  };

  p.on("connect", onConnect);

  return {
    uninstall(): void {
      const off = p.off ?? p.removeListener;
      off?.call(p, "connect", onConnect);
    },
  };
}

/** Parses an application_name like `clv:<eventId>` or `clv:<replayId>:<eventId>`. */
export function parseClvAppName(
  appName: string,
  prefix = "clv:",
): { eventId: string; replayId?: string } | null {
  if (!appName.startsWith(prefix)) return null;
  const tail = appName.slice(prefix.length);
  if (!tail) return null;
  const firstColon = tail.indexOf(":");
  if (firstColon < 0) return { eventId: tail };
  return {
    replayId: tail.slice(0, firstColon),
    eventId: tail.slice(firstColon + 1),
  };
}
