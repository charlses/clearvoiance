/**
 * Prisma instrumentation. Prisma's client goes through its own engine
 * process (prisma-engine or client-based) instead of `pg.Pool`, so the
 * `instrumentPg` adapter doesn't apply. Instead, we use Prisma's
 * `$extends({ query: { $allOperations } })` to prepend a raw SQL
 * `SET application_name` before each user operation.
 *
 * Usage:
 *
 * ```ts
 * import { PrismaClient } from "@prisma/client";
 * import { instrumentPrisma } from "@clearvoiance/node/db/prisma";
 *
 * const prisma = instrumentPrisma(new PrismaClient(), {
 *   replayId: process.env.CLEARVOIANCE_REPLAY_ID,
 * });
 * ```
 *
 * Replace `new PrismaClient()` with the return value — it's a new object
 * that preserves Prisma's fluent API via `$extends`. Call this ONCE at
 * startup before any queries fire.
 */

import { currentEventId } from "../core/event-context.js";

/** Options for the Prisma wrapper. */
export interface InstrumentPrismaOptions {
  /** Concurrent-replay disambiguator, matches the pg instrumentor. */
  replayId?: string;
  /** Prefix for application_name. Default "clv:". */
  appPrefix?: string;
  /** Called when the SET fails so it can be audited without crashing queries. */
  onError?: (err: unknown) => void;
}

// Narrow shape we need from a Prisma client — keeps Prisma as a pure peer dep.
interface PrismaLike {
  $executeRawUnsafe: (query: string) => Promise<unknown>;
  $extends: (def: unknown) => PrismaLike;
}

/**
 * Returns a Prisma client extended with application_name setting. The
 * original client is unchanged; use the returned one for all queries.
 */
export function instrumentPrisma<T extends PrismaLike>(
  prisma: T,
  opts: InstrumentPrismaOptions = {},
): T {
  const prefix = opts.appPrefix ?? "clv:";
  const replayId = opts.replayId ?? "";
  const onError = opts.onError ?? ((): void => {});

  const appNameFor = (eventId: string): string => {
    const raw = replayId ? `${prefix}${replayId}:${eventId}` : `${prefix}${eventId}`;
    return raw.length > 63 ? raw.slice(0, 63) : raw;
  };

  return prisma.$extends({
    query: {
      $allOperations: async ({
        args,
        query,
      }: {
        args: unknown;
        query: (args: unknown) => Promise<unknown>;
      }) => {
        const eventId = currentEventId();
        if (!eventId) return query(args);
        const appName = appNameFor(eventId).replace(/'/g, "''");
        try {
          await prisma.$executeRawUnsafe(`SET application_name = '${appName}'`);
        } catch (err) {
          onError(err);
        }
        return query(args);
      },
    },
  }) as T;
}
