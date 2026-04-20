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

import {
  makeAppNameBuilder,
  wrapPgClientWithAppName,
  type PgClientLike,
} from "./pg-wrap.js";

/**
 * Minimal shape we need from a pg.Pool instance. Deliberately narrow so
 * we don't pull `pg` into the SDK's type graph (it's a peer dep).
 */
interface PgPoolLike {
  on(event: "connect", listener: (client: PgClientLike) => void): unknown;
  off?(event: "connect", listener: (client: PgClientLike) => void): unknown;
  removeListener?(event: "connect", listener: (client: PgClientLike) => void): unknown;
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
  const appNameFor = makeAppNameBuilder(opts);
  const onError = opts.onError;

  const onConnect = (client: PgClientLike): void => {
    wrapPgClientWithAppName(client, { appNameFor, onError });
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
