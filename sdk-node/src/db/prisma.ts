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
import { emitDbObservation, type EmitConfig } from "./emit.js";

const ADAPTER_NAME = "db.prisma";

/** Options for the Prisma wrapper. */
export interface InstrumentPrismaOptions {
  /** Concurrent-replay disambiguator, matches the pg instrumentor. */
  replayId?: string;
  /** Prefix for application_name. Default "clv:". */
  appPrefix?: string;
  /** Called when the SET fails so it can be audited without crashing queries. */
  onError?: (err: unknown) => void;
  /**
   * Enable SDK-side per-query DbObservationEvent emission. Every operation
   * crossing `emit.slowThresholdMs` streams through the SDK client with
   * the originating event id attached. Complementary to the db-observer.
   */
  emit?: Omit<EmitConfig, "client"> & { client: EmitConfig["client"] };
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
  const emit = opts.emit
    ? { ...opts.emit, adapter: ADAPTER_NAME }
    : undefined;

  const appNameFor = (eventId: string): string => {
    const raw = replayId ? `${prefix}${replayId}:${eventId}` : `${prefix}${eventId}`;
    return raw.length > 63 ? raw.slice(0, 63) : raw;
  };

  return prisma.$extends({
    query: {
      $allOperations: async ({
        model,
        operation,
        args,
        query,
      }: {
        model?: string;
        operation?: string;
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
        if (!emit) return query(args);

        const fingerprint = `${model ?? "(raw)"}.${operation ?? "?"}`;
        const startNs = process.hrtime.bigint();
        try {
          const res = await query(args);
          emitDbObservation(emit, {
            adapter: ADAPTER_NAME,
            startNs,
            endNs: process.hrtime.bigint(),
            queryText: fingerprint,
            fingerprint,
            metadata: {
              prisma_op: operation ?? "",
              prisma_model: model ?? "",
            },
          });
          return res;
        } catch (err) {
          emitDbObservation(emit, {
            adapter: ADAPTER_NAME,
            startNs,
            endNs: process.hrtime.bigint(),
            queryText: fingerprint,
            fingerprint,
            metadata: {
              prisma_op: operation ?? "",
              prisma_model: model ?? "",
              status: "error",
            },
          });
          throw err;
        }
      },
    },
  }) as T;
}
