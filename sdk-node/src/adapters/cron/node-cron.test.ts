import { describe, expect, it } from "vitest";

import type { Event as PbEvent } from "../../generated/clearvoiance/v1/event.js";
import { captureCronJob } from "./node-cron.js";

class RecordingSink {
  public events: PbEvent[] = [];
  async sendBatch(events: PbEvent[]): Promise<void> {
    this.events.push(...events);
  }
}

async function settle(): Promise<void> {
  // Two microtask ticks: sendBatch() is called in a finally block, then
  // resolved on the microtask queue; await-ing twice is enough slack.
  await Promise.resolve();
  await Promise.resolve();
}

describe("captureCronJob (node-cron adapter)", () => {
  it("captures a successful invocation", async () => {
    const sink = new RecordingSink();
    const job = captureCronJob(sink, "cleanup", async () => "ok");

    const result = await job();
    expect(result).toBe("ok");

    await settle();
    expect(sink.events).toHaveLength(1);
    const ev = sink.events[0]!;
    expect(ev.adapter).toBe("cron.node-cron");
    expect(ev.cron?.jobName).toBe("cleanup");
    expect(ev.cron?.scheduler).toBe("node-cron");
    expect(ev.cron?.status).toBe("success");
    expect(ev.cron?.errorMessage).toBe("");
    expect(ev.cron?.triggerSource).toBe("schedule");
    expect(ev.cron?.durationNs).toBeGreaterThan(0n);
  });

  it("captures + re-throws on failure, recording the error message", async () => {
    const sink = new RecordingSink();
    const boom = new Error("disk full");
    const job = captureCronJob(sink, "backup", async () => {
      throw boom;
    });

    await expect(job()).rejects.toThrow("disk full");

    await settle();
    expect(sink.events).toHaveLength(1);
    const ev = sink.events[0]!;
    expect(ev.cron?.status).toBe("error");
    expect(ev.cron?.errorMessage).toBe("disk full");
  });

  it("respects triggerSource override", async () => {
    const sink = new RecordingSink();
    const job = captureCronJob(
      sink,
      "retry-only",
      async () => undefined,
      { triggerSource: "retry" },
    );
    await job();
    await settle();
    expect(sink.events[0]!.cron?.triggerSource).toBe("retry");
  });

  it("handles sync (non-async) callbacks", async () => {
    const sink = new RecordingSink();
    const job = captureCronJob(sink, "sync", () => 42);

    const result = await job();
    expect(result).toBe(42);

    await settle();
    expect(sink.events[0]!.cron?.status).toBe("success");
  });

  it("routes capture failures through onError without affecting cron return", async () => {
    let captured: unknown = null;
    const failing = {
      sendBatch: async (): Promise<void> => {
        throw new Error("engine down");
      },
    };
    const job = captureCronJob(failing, "ok", async () => "done", {
      onError: (err) => (captured = err),
    });

    const result = await job();
    expect(result).toBe("done");

    // onError fires asynchronously via .catch — give it a tick.
    await settle();
    await settle();
    expect((captured as Error | null)?.message).toBe("engine down");
  });
});
