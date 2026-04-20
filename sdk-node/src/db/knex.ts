/**
 * Knex.js instrumentation.
 *
 * Knex sits on top of any driver; for clearvoiance we only care about
 * the Postgres case (client: 'pg' or 'pgnative'). That's where the
 * db-observer's `application_name`/`pg_stat_activity` correlation lives.
 * For other drivers (mysql2, sqlite, mssql, oracledb) `instrumentKnex`
 * is a silent no-op — those need their own per-driver adapters.
 *
 * Knex manages its own pooled connections via tarn.js, so we can't
 * just hook `pool.on('connect')` like we do for raw pg. Instead we wrap
 * `knex.client.acquireRawConnection()` — the internal factory tarn
 * calls to mint a new pg.Client — and pass the returned client through
 * the same query wrapper used by the pg adapter.
 *
 * Usage:
 *
 * ```ts
 * import knex from "knex";
 * import { instrumentKnex } from "@clearvoiance/node/db/knex";
 *
 * const db = knex({ client: "pg", connection: process.env.DATABASE_URL });
 * instrumentKnex(db, { replayId: process.env.CLEARVOIANCE_REPLAY_ID });
 * ```
 *
 * For Strapi: `instrumentKnex(strapi.db.connection)` from a bootstrap
 * hook. Strapi 4 exposes the knex instance as `strapi.db.connection`.
 */

import {
  makeAppNameBuilder,
  wrapPgClientWithAppName,
  type PgClientLike,
} from "./pg-wrap.js";

export interface InstrumentKnexOptions {
  /**
   * Optional replay id. When set, every application_name becomes
   * `clv:<replayId>:<eventId>` so concurrent replays against the same
   * DB don't cross-attribute. Leave undefined during capture.
   */
  replayId?: string;
  /** Default "clv:". Override if clashing with an existing app-name scheme. */
  appPrefix?: string;
  /** Called on any SET-statement failure. Defaults to silent. */
  onError?: (err: unknown) => void;
}

export interface InstrumentKnexHandle {
  /**
   * Uninstalls the wrapper from the knex client. Connections already
   * in the pool keep their wrapped `query` method until they're
   * recycled — knex has no hook to swap it back.
   */
  uninstall(): void;
}

/**
 * Minimal shape of a Knex instance we rely on. Typed with `unknown` at
 * the public surface so we don't pull `knex` into our type graph.
 */
interface KnexLike {
  client: KnexClientLike;
}

interface KnexClientLike {
  /** Name of the underlying driver — "pg", "pgnative", "mysql2", etc. */
  driverName?: string;
  dialect?: string;
  /** Factory tarn calls for each new connection. Returns a pg.Client when driver==pg. */
  acquireRawConnection: (this: KnexClientLike, ...args: unknown[]) => Promise<unknown> | unknown;
  /** Tarn pool. Present on live knex instances; we walk it to wrap already-open connections. */
  pool?: {
    numUsed?: () => number;
    numFree?: () => number;
    /** tarn keeps connections in `_freeObjects` / `_usedObjects`; API is stable but undocumented. */
    _freeObjects?: Array<{ resource: PgClientLike }>;
    _usedObjects?: Array<{ resource: PgClientLike }>;
  };
}

/**
 * Installs the knex wrapper. Returns a handle whose `uninstall()`
 * restores the original `acquireRawConnection`; already-open connections
 * keep their patched `.query`.
 */
export function instrumentKnex(
  knex: unknown,
  opts: InstrumentKnexOptions = {},
): InstrumentKnexHandle {
  const k = knex as KnexLike;
  const driver = k.client?.driverName ?? k.client?.dialect ?? "";
  if (!isPostgresDriver(driver)) {
    // Not a Postgres-backed Knex — nothing to instrument here. Return a
    // no-op handle so callers don't have to branch.
    return { uninstall() {} };
  }

  const appNameFor = makeAppNameBuilder(opts);
  const onError = opts.onError;

  // Wrap the factory: every new connection knex mints gets its .query
  // method patched with the application_name prefix.
  const originalAcquire = k.client.acquireRawConnection;
  const patchedAcquire = async function (this: KnexClientLike, ...args: unknown[]): Promise<unknown> {
    const conn = await originalAcquire.apply(this, args);
    if (conn && typeof (conn as PgClientLike).query === "function") {
      wrapPgClientWithAppName(conn as PgClientLike, { appNameFor, onError });
    }
    return conn;
  };
  (k.client as { acquireRawConnection: typeof patchedAcquire }).acquireRawConnection = patchedAcquire;

  // Also wrap connections tarn has already created before we were
  // called. This matters when instrumentKnex runs after Strapi's first
  // query on boot — without this, the initial pool connections slip
  // through unwrapped until they're recycled.
  wrapExistingPoolConnections(k.client, { appNameFor, onError });

  return {
    uninstall(): void {
      (k.client as { acquireRawConnection: typeof originalAcquire }).acquireRawConnection =
        originalAcquire;
    },
  };
}

function isPostgresDriver(name: string): boolean {
  const n = name.toLowerCase();
  return n === "pg" || n === "pgnative" || n === "postgres" || n === "postgresql";
}

function wrapExistingPoolConnections(
  client: KnexClientLike,
  wrapOpts: {
    appNameFor: (eventId: string) => string;
    onError?: (err: unknown) => void;
  },
): void {
  const pool = client.pool;
  if (!pool) return;
  // tarn's internals. Safe enough — the field names have been stable
  // across tarn 3.x which knex 2+ uses. If they change we lose the
  // retroactive wrap but new connections still get patched via the
  // acquireRawConnection override, so the failure mode is graceful.
  for (const bucket of [pool._freeObjects, pool._usedObjects]) {
    if (!Array.isArray(bucket)) continue;
    for (const entry of bucket) {
      const resource = (entry as { resource?: PgClientLike }).resource;
      if (resource && typeof resource.query === "function") {
        wrapPgClientWithAppName(resource, wrapOpts);
      }
    }
  }
}

// Re-export parseClvAppName for observers that consume knex-tagged
// queries — the tag format is identical to what instrumentPg produces,
// so the same parser applies.
export { parseClvAppName } from "./postgres.js";
