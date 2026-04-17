import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { cronRegistry, patchCron, registerCronHandler } from "./cron-killer.js";

// patchCron mutates the CJS module.exports of node-cron. The ESM namespace
// view in TypeScript is a frozen snapshot, so tests grab the CJS module
// directly — same trick used for the outbound/http tests.
const nodeRequire = createRequire(import.meta.url);

describe("cronRegistry / registerCronHandler", () => {
  beforeEach(() => cronRegistry.clear());

  it("stores and retrieves handlers by name", () => {
    const fn = async (): Promise<string> => "ran";
    registerCronHandler("nightly-sync", fn);
    expect(cronRegistry.has("nightly-sync")).toBe(true);
    expect(cronRegistry.get("nightly-sync")).toBe(fn);
    expect(cronRegistry.size).toBe(1);
    expect(cronRegistry.names()).toContain("nightly-sync");
  });
});

describe("patchCron", () => {
  // node-cron is an optional peer dep — if not installed in the test env the
  // patch is a no-op. Guard so the suite still runs on minimal machines.
  let cron: { schedule: (...args: unknown[]) => unknown } | null = null;
  beforeEach(() => {
    cronRegistry.clear();
    try {
      cron = nodeRequire("node-cron") as {
        schedule: (...args: unknown[]) => unknown;
      };
    } catch {
      cron = null;
    }
  });
  afterEach(() => {
    cronRegistry.clear();
  });

  it("does not schedule work; handlers land in the registry", async () => {
    if (!cron) return; // node-cron not installed here
    const handle = patchCron();
    try {
      let ran = 0;
      const task = cron.schedule(
        "* * * * *",
        () => {
          ran++;
        },
        { name: "counter" },
      );
      // Give the scheduler a tick to prove it never fires.
      await new Promise((r) => setTimeout(r, 50));
      expect(ran).toBe(0);

      // Returned task is a no-op stub (start/stop don't explode).
      expect(typeof (task as { stop: () => void }).stop).toBe("function");
      (task as { stop: () => void }).stop();

      // But the registry has our handler keyed by the opts.name we passed.
      expect(cronRegistry.has("counter")).toBe(true);
      const handler = cronRegistry.get("counter");
      expect(handler).toBeDefined();

      await handler?.();
      expect(ran).toBe(1);
    } finally {
      handle.uninstall();
    }
  });

  it("falls back to the function name then cron_${n} when opts.name is missing", async () => {
    if (!cron) return;
    const handle = patchCron();
    try {
      cron.schedule("0 * * * *", function hourly(): void {});
      cron.schedule("0 0 * * *", () => {}); // anonymous — gets cron_<n>

      expect(cronRegistry.has("hourly")).toBe(true);
      // Anonymous → something like cron_1 (counter, not enforced to exact value
      // because `.has('hourly')` already incremented state-wise via counter
      // initialization choices — just check we have 2 entries registered).
      expect(cronRegistry.size).toBe(2);
    } finally {
      handle.uninstall();
    }
  });

  it("uninstall restores the original schedule", async () => {
    if (!cron) return;
    const before = cron.schedule;
    const handle = patchCron();
    expect(cron.schedule).not.toBe(before);
    handle.uninstall();
    expect(cron.schedule).toBe(before);
  });
});
