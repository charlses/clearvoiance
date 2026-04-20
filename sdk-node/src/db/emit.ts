/**
 * Shared DbObservation emission used by every DB adapter that runs
 * SDK-side (no observer required): postgres, knex, prisma, mongoose.
 *
 * The observer-based path (db-observer polling pg_stat_activity) only
 * sees queries that are currently running at poll time with duration
 * >= threshold. Anything that starts and finishes inside a poll window
 * is invisible. For apps where most queries are fast but you still want
 * 100% correlation (load analysis, capture-vs-replay diffs, or any
 * backend where there's no equivalent of pg_stat_activity — e.g. Mongo),
 * opt into SDK-side emission on each adapter by passing `emit.client`.
 *
 * The emitted event shape is identical to what the observer writes, so
 * the dashboard's /db page merges both sources without knowing which
 * produced a row.
 */

import { currentEventId as defaultCurrentEventId } from "../core/event-context.js";
import type {
  BlobRef,
  DbObservationEvent as PbDbObs,
  Event as PbEvent,
} from "../generated/clearvoiance/v1/event.js";
import { DbObservationEvent_DbObservationType as DbObsType } from "../generated/clearvoiance/v1/event.js";
import { SDK_VERSION } from "../version.js";

/** Minimal client contract every adapter needs. */
export interface EventSink {
  sendBatch(events: PbEvent[]): Promise<void>;
  uploadBlob?(data: Buffer, opts?: { contentType?: string }): Promise<BlobRef>;
  track?<T>(p: Promise<T>): Promise<T>;
}

/**
 * Opt-in per-adapter emission config. Every adapter accepts the same
 * shape so users can enable it consistently.
 */
export interface EmitConfig {
  /** Required. Client returned by `createClient()`. */
  client: EventSink;
  /**
   * Minimum duration in ms for a query to be emitted. 0 = emit everything
   * (chatty on high-QPS apps). 10 is a reasonable default for "catch
   * everything that matters".
   */
  slowThresholdMs?: number;
  /**
   * Optional replay id. When set, `db.applicationName` becomes
   * `clv:<replayId>:<eventId>` so the UI filters that scan by replay id
   * see these SDK-emitted events alongside observer rows. Omit during
   * capture — the SDK is not intrinsically aware of replay context.
   */
  replayId?: string;
  /** Default "clv:". Matches the observer convention. */
  appPrefix?: string;
  /** Called on any emit failure. Defaults to console.warn. */
  onError?: (err: unknown) => void;
  /**
   * Override the source of the active event id. Tests inject this. The
   * default reads from AsyncLocalStorage via `currentEventId()`.
   */
  currentEventId?: () => string | undefined;
}

/** What an adapter hands us to describe a single query. */
export interface DbObservationInput {
  /** "db.postgres" / "db.knex" / "db.prisma" / "db.mongoose" */
  adapter: string;
  /** Start time captured via `process.hrtime.bigint()` before the query ran. */
  startNs: bigint;
  /** End time captured immediately after the query resolved. */
  endNs: bigint;
  /** A single-line summary of the query. For SQL: the statement itself (may be truncated). */
  queryText: string;
  /** Grouping key. For SQL: normalised shape. For ORMs: `<Model>.<op>`. */
  fingerprint: string;
  /** Free-form adapter-specific labels carried on the Event. */
  metadata?: Record<string, string>;
  /** Optional rowsAffected from driver-specific command tag. */
  rowsAffected?: bigint;
}

/**
 * Fire-and-forget emit. Returns synchronously; the actual network write
 * happens on the client's background queue via `client.sendBatch`.
 *
 * Drops ops that fire outside any event scope — they have nothing to
 * correlate against and only add noise. Drops ops below the configured
 * threshold.
 */
export function emitDbObservation(
  cfg: EmitConfig,
  input: DbObservationInput,
): void {
  const onError = cfg.onError ?? defaultOnError;
  try {
    const eventIdSource = cfg.currentEventId ?? defaultCurrentEventId;
    const eventId = eventIdSource();
    if (!eventId) return;

    const durationNs = input.endNs - input.startNs;
    const thresholdNs =
      BigInt(Math.max(0, Math.floor(cfg.slowThresholdMs ?? 0))) * 1_000_000n;
    if (durationNs < thresholdNs) return;

    const appName = buildAppName(cfg, eventId);

    const dbObs: PbDbObs = {
      queryFingerprint: input.fingerprint,
      queryText: input.queryText,
      durationNs,
      rowsAffected: input.rowsAffected ?? 0n,
      applicationName: appName,
      causedByEventId: eventId,
      observationType: DbObsType.DB_OBSERVATION_TYPE_SLOW_QUERY,
      explainPlan: "",
      locks: [],
    };

    const event: PbEvent = {
      id: eventId,
      sessionId: "",
      timestampNs: BigInt(Date.now()) * 1_000_000n - durationNs,
      offsetNs: 0n,
      adapter: input.adapter,
      sdkVersion: `@clearvoiance/node@${SDK_VERSION}`,
      metadata: input.metadata ?? {},
      redactionsApplied: [],
      db: dbObs,
    };

    const task = cfg.client.sendBatch([event]).catch(onError);
    if (cfg.client.track) void cfg.client.track(task);
  } catch (err) {
    onError(err);
  }
}

function buildAppName(cfg: EmitConfig, eventId: string): string {
  const prefix = cfg.appPrefix ?? "clv:";
  const replayId = cfg.replayId ?? "";
  const raw = replayId ? `${prefix}${replayId}:${eventId}` : `${prefix}${eventId}`;
  return raw.length > 63 ? raw.slice(0, 63) : raw;
}

function defaultOnError(err: unknown): void {
  // eslint-disable-next-line no-console
  console.warn("[clearvoiance] db emit failed:", err);
}
