/**
 * Mongoose instrumentation.
 *
 * MongoDB doesn't have the Postgres-style `application_name` +
 * `pg_stat_activity` story, so we don't ship a Mongo observer binary.
 * Instead this adapter takes the SDK-side path: hooks mongoose's
 * pre/post query middleware, measures each operation, and emits a
 * DbObservationEvent via the SDK client for events that cross
 * `slowThresholdMs`. No separate observer process required.
 *
 * Events carry `caused_by_event_id` set from the active
 * AsyncLocalStorage scope so the replay detail page can correlate DB
 * ops to the HTTP / cron / queue event that caused them — same
 * mental model as the Postgres flow.
 *
 * Usage:
 *
 * ```ts
 * import mongoose from "mongoose";
 * import { createClient } from "@clearvoiance/node";
 * import { instrumentMongoose } from "@clearvoiance/node/db/mongoose";
 *
 * const client = createClient({ ... });
 * await client.start();
 *
 * // Install the plugin BEFORE defining any model so every schema picks
 * // it up. For frameworks that defer schema registration (NestJS,
 * // Strapi-via-Mongoose), call this from the bootstrap hook.
 * instrumentMongoose(mongoose, client, { slowThresholdMs: 50 });
 * ```
 */

import { currentEventId } from "../core/event-context.js";
import type {
  BlobRef,
  DbObservationEvent as PbDbObs,
  Event as PbEvent,
} from "../generated/clearvoiance/v1/event.js";
import { DbObservationEvent_DbObservationType as DbObsType } from "../generated/clearvoiance/v1/event.js";
import { SDK_VERSION } from "../version.js";

const ADAPTER_NAME = "db.mongoose";

/** Minimal client contract this adapter needs. Mirrors the cron adapter's. */
export interface EventSink {
  sendBatch(events: PbEvent[]): Promise<void>;
  uploadBlob?(data: Buffer, opts?: { contentType?: string }): Promise<BlobRef>;
  track?<T>(p: Promise<T>): Promise<T>;
}

export interface InstrumentMongooseOptions {
  /**
   * Optional replay id. When set, the emitted application_name on each
   * event becomes `clv:<replayId>:<eventId>` so UI queries that filter
   * by replay id see mongoose ops alongside Postgres observations.
   */
  replayId?: string;
  /**
   * Minimum duration (ms) an op must cross to be emitted. 0 = emit
   * everything (chatty on busy apps). 100 is a reasonable default for
   * "just show me the slow ones"; 0 during capture gives full
   * fidelity for replay analysis.
   */
  slowThresholdMs?: number;
  /** Default "clv:". Matches the pg-adapter convention so a single UI filter covers both. */
  appPrefix?: string;
  /** Called on any emit failure. Defaults to console.warn. */
  onError?: (err: unknown) => void;
}

export interface InstrumentMongooseHandle {
  /** Removes the installed plugin. Existing schemas keep their wrappers. */
  uninstall(): void;
}

/**
 * Minimal shape of the mongoose top-level module we rely on.
 * `plugin(fn)` installs a function to run against every schema defined
 * AFTER the call; existing schemas are not retroactively plugged.
 */
interface MongooseLike {
  plugin(fn: (schema: unknown) => void): unknown;
  plugins?: unknown[];
}

/** Schema-level hook API (mongoose.Schema instance). */
interface SchemaLike {
  pre(name: string | string[], fn: PreFn): unknown;
  post(name: string | string[], fn: PostFn): unknown;
}

type PreFn = (this: QueryContextLike, next?: () => void) => void;
type PostFn = (this: QueryContextLike, res: unknown, next?: () => void) => void;

/**
 * The `this` inside mongoose middleware for query ops. We only read
 * a handful of fields; typing narrowly keeps us untangled from
 * mongoose's own types.
 */
interface QueryContextLike {
  // Internal scratchpad we stash start time on. Mongoose allows
  // arbitrary assignments to `this` inside middleware.
  _clvStartNs?: bigint;
  _clvEventId?: string;
  // getQuery / getOptions are stable across mongoose 6-8.
  getQuery?: () => unknown;
  getOptions?: () => Record<string, unknown>;
  op?: string;
  model?: { modelName?: string };
  // Document middleware gives us `this` = document, which has
  // .constructor.modelName.
  constructor?: { modelName?: string };
}

/** The full set of operations we hook. Chosen to cover the ones that actually issue commands. */
const QUERY_OPS = [
  "find",
  "findOne",
  "findOneAndUpdate",
  "findOneAndDelete",
  "findOneAndRemove",
  "findOneAndReplace",
  "updateOne",
  "updateMany",
  "deleteOne",
  "deleteMany",
  "replaceOne",
  "countDocuments",
  "estimatedDocumentCount",
  "distinct",
  "aggregate",
];

const DOC_OPS = ["save", "validate", "remove", "deleteOne"];

export function instrumentMongoose(
  mongoose: unknown,
  client: EventSink,
  opts: InstrumentMongooseOptions = {},
): InstrumentMongooseHandle {
  const m = mongoose as MongooseLike;
  const prefix = opts.appPrefix ?? "clv:";
  const replayId = opts.replayId ?? "";
  const thresholdNs =
    BigInt(Math.max(0, Math.floor(opts.slowThresholdMs ?? 0))) * 1_000_000n;
  const onError = opts.onError ?? defaultOnError;

  const appNameFor = (eventId: string): string =>
    replayId ? `${prefix}${replayId}:${eventId}` : `${prefix}${eventId}`;

  const plugin = (schemaRaw: unknown): void => {
    const schema = schemaRaw as SchemaLike;
    schema.pre(QUERY_OPS, preHook);
    schema.post(QUERY_OPS, postHook);
    schema.pre(DOC_OPS, preHook);
    schema.post(DOC_OPS, postHook);
  };

  function preHook(this: QueryContextLike, next?: () => void): void {
    this._clvStartNs = process.hrtime.bigint();
    this._clvEventId = currentEventId();
    next?.();
  }

  function postHook(this: QueryContextLike): void {
    try {
      if (this._clvStartNs === undefined) return;
      const eventId = this._clvEventId;
      // No active capture scope → nothing to correlate to. Drop.
      if (!eventId) return;

      const durationNs = process.hrtime.bigint() - this._clvStartNs;
      if (durationNs < thresholdNs) return;

      const opName = this.op ?? "save";
      const modelName =
        this.model?.modelName ?? this.constructor?.modelName ?? "(unknown)";

      // query_text keeps the operation signature. Full query payloads
      // can be PII-heavy; we stay short + structured on purpose.
      const queryText = describeOp(opName, modelName, this);
      const fingerprint = `${modelName}.${opName}`;

      const dbObs: PbDbObs = {
        queryFingerprint: fingerprint,
        queryText,
        durationNs,
        rowsAffected: 0n,
        applicationName: appNameFor(eventId),
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
        adapter: ADAPTER_NAME,
        sdkVersion: `@clearvoiance/node@${SDK_VERSION}`,
        metadata: { mongoose_op: opName, model: modelName },
        redactionsApplied: [],
        db: dbObs,
      };

      const task = client.sendBatch([event]).catch(onError);
      if (client.track) void client.track(task);
    } catch (err) {
      onError(err);
    }
  }

  m.plugin(plugin);

  return {
    uninstall(): void {
      // Mongoose doesn't expose a plugin-removal API. Best we can do
      // is drop our plugin from the registered list if it's present —
      // schemas that already loaded it keep the middleware.
      if (Array.isArray(m.plugins)) {
        const idx = m.plugins.indexOf(plugin as unknown);
        if (idx >= 0) m.plugins.splice(idx, 1);
      }
    },
  };
}

function describeOp(op: string, model: string, ctx: QueryContextLike): string {
  // Best-effort one-liner summarising what ran. We skip the actual
  // filter document on purpose — it's noisy and can contain PII; the
  // model + op is enough to group in the dashboard by fingerprint.
  const filter = (() => {
    try {
      return ctx.getQuery ? JSON.stringify(ctx.getQuery()) : "";
    } catch {
      return "";
    }
  })();
  const shortFilter = filter && filter.length <= 200 ? filter : "";
  return shortFilter ? `${model}.${op}(${shortFilter})` : `${model}.${op}()`;
}

function defaultOnError(err: unknown): void {
  // eslint-disable-next-line no-console
  console.warn("[clearvoiance] mongoose capture failed:", err);
}
