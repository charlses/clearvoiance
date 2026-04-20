/**
 * Runtime sampler — periodic snapshots of the SUT's process state that
 * replay analysis needs to explain "why was this window slow". The
 * per-query DbObservation tells you queries took N ms; this tells you
 * whether the app was short on connections, RSS was climbing, the event
 * loop was starved, or GC was thrashing.
 *
 * Emits a RuntimeSampleEvent (proto) at a fixed interval. Streams
 * through the same capture client as every other event, so it only
 * flows while a capture session is active — no background cost when
 * the monitor is idle.
 *
 * Usage:
 *
 * ```ts
 * import { instrumentRuntime } from "@clearvoiance/node/runtime";
 *
 * const handle = instrumentRuntime(client, {
 *   intervalMs: 1000,
 *   knexPool: strapi.db.connection,   // optional — adds DB pool stats
 * });
 * // call handle.stop() on shutdown.
 * ```
 */

import { monitorEventLoopDelay, PerformanceObserver } from "node:perf_hooks";

import { newEventId } from "../core/event-context.js";
import type { EventSink } from "../db/emit.js";
import type {
  Event as PbEvent,
  RuntimeSampleEvent as PbRuntimeSample,
} from "../generated/clearvoiance/v1/event.js";
import { SDK_VERSION } from "../version.js";

const ADAPTER_NAME = "runtime.node";

export interface InstrumentRuntimeOptions {
  /** Sample cadence in ms. Default 1000. Minimum 100 (clamp). */
  intervalMs?: number;
  /**
   * Optional Knex instance. When provided, each sample includes
   * pool.numUsed / free / pending / max via the tarn internals.
   * Accepts a live Knex or any object exposing `.client.pool`.
   */
  knexPool?: unknown;
  /** Error logger. Defaults to console.warn. */
  onError?: (err: unknown) => void;
}

export interface InstrumentRuntimeHandle {
  /** Stops the sampler. Idempotent. */
  stop(): void;
}

/**
 * Minimal shape of a tarn-backed Knex pool. Fields may change across
 * minor tarn releases; guarded with typeof checks at access time.
 */
interface KnexPoolLike {
  client?: {
    pool?: {
      max?: number;
      numUsed?: () => number;
      numFree?: () => number;
      numPendingAcquires?: () => number;
    };
  };
}

export function instrumentRuntime(
  client: EventSink,
  opts: InstrumentRuntimeOptions = {},
): InstrumentRuntimeHandle {
  const intervalMs = Math.max(100, opts.intervalMs ?? 1000);
  const onError = opts.onError ?? defaultOnError;
  const knex = opts.knexPool as KnexPoolLike | undefined;

  // Event-loop histogram. resolution=10ms gives us µs-accurate p99 at
  // low overhead; we reset on every sample tick so stats describe the
  // previous interval, not since-start.
  const ellHist = monitorEventLoopDelay({ resolution: 10 });
  ellHist.enable();

  // GC pauses observed since the previous tick. buffered:true gives us
  // historical entries even if we poll a bit late.
  let gcCount = 0;
  let gcTotalNs = 0n;
  const gcObs = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      gcCount += 1;
      gcTotalNs += BigInt(Math.round(entry.duration * 1_000_000));
    }
  });
  try {
    gcObs.observe({ entryTypes: ["gc"], buffered: true });
  } catch (err) {
    // Some test runners disable perf_hooks.gc; non-fatal.
    onError(err);
  }

  let lastCpu = process.cpuUsage();

  const tick = (): void => {
    try {
      const mem = process.memoryUsage();
      const cpu = process.cpuUsage(lastCpu);
      lastCpu = process.cpuUsage();

      const activeHandles = countActiveHandles();
      const activeRequests = countActiveRequests();

      const pool = knex?.client?.pool;
      const poolUsed = callSafe(pool?.numUsed, 0);
      const poolFree = callSafe(pool?.numFree, 0);
      const poolPending = callSafe(pool?.numPendingAcquires, 0);
      const poolMax = typeof pool?.max === "number" ? pool.max : 0;

      const sample: PbRuntimeSample = {
        memRss: BigInt(mem.rss),
        memHeapUsed: BigInt(mem.heapUsed),
        memHeapTotal: BigInt(mem.heapTotal),
        memExternal: BigInt(mem.external),
        memArrayBuffers: BigInt((mem as { arrayBuffers?: number }).arrayBuffers ?? 0),
        cpuUserUs: BigInt(cpu.user),
        cpuSystemUs: BigInt(cpu.system),
        eventLoopP50Ns: BigInt(Math.round(ellHist.percentile(50))),
        eventLoopP99Ns: BigInt(Math.round(ellHist.percentile(99))),
        eventLoopMaxNs: BigInt(ellHist.max === Infinity ? 0 : Math.round(ellHist.max)),
        gcCount,
        gcTotalPauseNs: gcTotalNs,
        activeHandles,
        activeRequests,
        dbPoolUsed: poolUsed,
        dbPoolFree: poolFree,
        dbPoolPending: poolPending,
        dbPoolMax: poolMax,
      };
      // Reset the windowed counters so the NEXT sample reflects only
      // what happened in the NEXT interval.
      ellHist.reset();
      gcCount = 0;
      gcTotalNs = 0n;

      const event: PbEvent = {
        id: newEventId(),
        sessionId: "",
        timestampNs: BigInt(Date.now()) * 1_000_000n,
        offsetNs: 0n,
        adapter: ADAPTER_NAME,
        sdkVersion: `@clearvoiance/node@${SDK_VERSION}`,
        metadata: {},
        redactionsApplied: [],
        runtime: sample,
      };
      const task = client.sendBatch([event]).catch(onError);
      if (client.track) void client.track(task);
    } catch (err) {
      onError(err);
    }
  };

  const timer = setInterval(tick, intervalMs);
  // Unref so the sampler never keeps the process alive during shutdown.
  timer.unref?.();

  return {
    stop(): void {
      clearInterval(timer);
      ellHist.disable();
      try {
        gcObs.disconnect();
      } catch {
        /* already disconnected */
      }
    },
  };
}

function callSafe(fn: (() => number) | undefined, fallback: number): number {
  if (typeof fn !== "function") return fallback;
  try {
    const v = fn();
    return typeof v === "number" && Number.isFinite(v) ? v : fallback;
  } catch {
    return fallback;
  }
}

// Node's process._getActiveHandles / _getActiveRequests are private but
// stable across Node 18/20/22. Guarded so non-Node runtimes (deno, bun)
// that trip our sampler don't crash.
function countActiveHandles(): number {
  const p = process as { _getActiveHandles?: () => unknown[] };
  try {
    return p._getActiveHandles?.().length ?? 0;
  } catch {
    return 0;
  }
}

function countActiveRequests(): number {
  const p = process as { _getActiveRequests?: () => unknown[] };
  try {
    return p._getActiveRequests?.().length ?? 0;
  } catch {
    return 0;
  }
}

function defaultOnError(err: unknown): void {
  // eslint-disable-next-line no-console
  console.warn("[clearvoiance] runtime sampler failed:", err);
}
