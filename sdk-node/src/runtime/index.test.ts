import { afterEach, describe, expect, it } from "vitest";

import type { Event as PbEvent } from "../generated/clearvoiance/v1/event.js";
import { instrumentRuntime } from "./index.js";

function fakeClient(): { client: { sendBatch: (events: PbEvent[]) => Promise<void>; track<T>(p: Promise<T>): Promise<T> }; sent: PbEvent[] } {
  const sent: PbEvent[] = [];
  return {
    sent,
    client: {
      sendBatch: async (events) => {
        sent.push(...events);
      },
      track: (p) => p,
    },
  };
}

describe("instrumentRuntime", () => {
  let stop: (() => void) | undefined;
  afterEach(() => {
    stop?.();
    stop = undefined;
  });

  it("emits a RuntimeSampleEvent at the configured interval", async () => {
    const { client, sent } = fakeClient();
    const handle = instrumentRuntime(client, { intervalMs: 100 });
    stop = handle.stop;

    await new Promise((r) => setTimeout(r, 250));

    // Expect at least 2 ticks within ~250ms at 100ms cadence.
    expect(sent.length).toBeGreaterThanOrEqual(2);
    const ev = sent[0]!;
    expect(ev.adapter).toBe("runtime.node");
    expect(ev.runtime).toBeDefined();
    expect(ev.runtime?.memRss).toBeGreaterThan(0n);
    expect(ev.runtime?.memHeapUsed).toBeGreaterThan(0n);
    // Active handles includes the setInterval timer itself, so >= 1.
    expect(ev.runtime?.activeHandles).toBeGreaterThanOrEqual(1);
  });

  it("stamps DB pool stats when knexPool is provided", async () => {
    const { client, sent } = fakeClient();
    const fakeKnex = {
      client: {
        pool: {
          max: 10,
          numUsed: () => 7,
          numFree: () => 3,
          numPendingAcquires: () => 2,
        },
      },
    };
    const handle = instrumentRuntime(client, {
      intervalMs: 100,
      knexPool: fakeKnex,
    });
    stop = handle.stop;

    await new Promise((r) => setTimeout(r, 150));

    const ev = sent[0]!;
    expect(ev.runtime?.dbPoolMax).toBe(10);
    expect(ev.runtime?.dbPoolUsed).toBe(7);
    expect(ev.runtime?.dbPoolFree).toBe(3);
    expect(ev.runtime?.dbPoolPending).toBe(2);
  });

  it("zeros pool stats when knexPool is not provided", async () => {
    const { client, sent } = fakeClient();
    const handle = instrumentRuntime(client, { intervalMs: 100 });
    stop = handle.stop;
    await new Promise((r) => setTimeout(r, 150));
    const ev = sent[0]!;
    expect(ev.runtime?.dbPoolMax).toBe(0);
    expect(ev.runtime?.dbPoolUsed).toBe(0);
  });

  it("stop() halts emission", async () => {
    const { client, sent } = fakeClient();
    const handle = instrumentRuntime(client, { intervalMs: 50 });
    await new Promise((r) => setTimeout(r, 120));
    const countAtStop = sent.length;
    handle.stop();
    await new Promise((r) => setTimeout(r, 200));
    expect(sent.length).toBe(countAtStop);
  });

  it("clamps interval below 100ms up to 100ms", async () => {
    const { client, sent } = fakeClient();
    const handle = instrumentRuntime(client, { intervalMs: 10 });
    stop = handle.stop;
    await new Promise((r) => setTimeout(r, 250));
    // With 10ms clamped to 100ms, we expect 2-3 ticks in 250ms, not 20+.
    expect(sent.length).toBeGreaterThanOrEqual(2);
    expect(sent.length).toBeLessThan(6);
  });
});
