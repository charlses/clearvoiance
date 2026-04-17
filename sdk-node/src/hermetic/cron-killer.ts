/**
 * Cron killer. During hermetic replay, the SUT's own scheduler must not fire
 * anything — the replay engine is the sole source of cron invocations,
 * scheduled at compressed timing from captured CronEvents.
 *
 * This module:
 *   1. Holds a per-process handler registry keyed by job name.
 *   2. Patches `node-cron.schedule(expr, handler, opts)` to register the
 *      handler in the registry instead of scheduling it. The returned
 *      ScheduledTask is a no-op stub so calling code that holds the return
 *      value (e.g. `const task = cron.schedule(...); task.stop();`) keeps
 *      working.
 *   3. Exposes `registerCronHandler(name, fn)` for handlers scheduled
 *      outside of node-cron (e.g. bullmq workers) so the invoke server can
 *      still fire them.
 *
 * BullMQ / Agenda / Bree are not patched here — their APIs are heterogeneous
 * enough that a one-size-fits-all monkey-patch doesn't cleanly work.
 * Users of those schedulers should call `registerCronHandler` themselves
 * from the wrapper that used to register the job. This is documented in
 * the Phase 3 README.
 */

import { createRequire } from "node:module";

import type { PatchHandle } from "../outbound/http.js";

const nodeRequire = createRequire(import.meta.url);

export type CronHandler = (args?: unknown) => unknown | Promise<unknown>;

class CronRegistry {
  private readonly handlers = new Map<string, CronHandler>();

  register(name: string, fn: CronHandler): void {
    this.handlers.set(name, fn);
  }

  get(name: string): CronHandler | undefined {
    return this.handlers.get(name);
  }

  has(name: string): boolean {
    return this.handlers.has(name);
  }

  names(): string[] {
    return [...this.handlers.keys()];
  }

  clear(): void {
    this.handlers.clear();
  }

  get size(): number {
    return this.handlers.size;
  }
}

/** The process-global registry. Accessible to the invoke server. */
export const cronRegistry = new CronRegistry();

/** Exposed so apps using custom schedulers can register handlers manually. */
export function registerCronHandler(name: string, fn: CronHandler): void {
  cronRegistry.register(name, fn);
}

export interface CronKillerOptions {
  /** Override how a ScheduledTask-returning call is named. Default: `cron_${counter}`. */
  nameFromArgs?: (expr: unknown, handler: unknown, opts: unknown) => string | undefined;
}

/**
 * Patches `node-cron.schedule` to stash handlers in the registry and return
 * a no-op ScheduledTask stub. Calling schedule() does NOT start the job.
 *
 * Returns a handle with `uninstall()` that restores the original schedule.
 */
export function patchCron(opts: CronKillerOptions = {}): PatchHandle {
  let nodeCron: { schedule: (...args: unknown[]) => unknown };
  try {
    nodeCron = nodeRequire("node-cron") as {
      schedule: (...args: unknown[]) => unknown;
    };
  } catch {
    // node-cron not installed — nothing to patch. Apps that don't use it
    // (e.g. bullmq-only) hit `registerCronHandler` directly.
    return { uninstall() {} };
  }

  const original = nodeCron.schedule;
  let counter = 0;
  const nameFromArgs =
    opts.nameFromArgs ??
    ((_expr: unknown, handler: unknown, runOpts: unknown) => {
      const fromOpts = (runOpts as { name?: string } | undefined)?.name;
      if (fromOpts) return fromOpts;
      const fromFn = (handler as { name?: string } | undefined)?.name;
      if (fromFn && fromFn !== "anonymous") return fromFn;
      return `cron_${++counter}`;
    });

  nodeCron.schedule = function patchedSchedule(
    expr: unknown,
    handler: unknown,
    runOpts?: unknown,
  ): unknown {
    const name = nameFromArgs(expr, handler, runOpts) ?? `cron_${++counter}`;
    if (typeof handler === "function") {
      cronRegistry.register(name, handler as CronHandler);
    }
    // Return a minimal no-op task so code that does `task.stop()` or
    // `task.start()` doesn't blow up.
    return stubTask();
  } as typeof nodeCron.schedule;

  return {
    uninstall() {
      nodeCron.schedule = original;
    },
  };
}

function stubTask(): unknown {
  return {
    start(): void {},
    stop(): void {},
    getStatus(): string {
      return "stopped";
    },
    // Some versions expose a `now()` trigger — run nothing, succeed.
    now(): Promise<void> {
      return Promise.resolve();
    },
  };
}
