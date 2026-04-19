import { describe, expect, it } from "vitest";

import { currentEventId } from "../../core/event-context.js";
import type { Event as PbEvent } from "../../generated/clearvoiance/v1/event.js";
import { captureBullMQ, type BullMQJobLike } from "./bullmq.js";

class RecordingSink {
  public batches: PbEvent[][] = [];
  async sendBatch(events: PbEvent[]): Promise<void> {
    this.batches.push(events);
  }
  events(): PbEvent[] {
    return this.batches.flat();
  }
  inflight: Promise<unknown>[] = [];
  track<T>(p: Promise<T>): Promise<T> {
    this.inflight.push(p);
    return p;
  }
  async drain(): Promise<void> {
    await Promise.allSettled([...this.inflight]);
  }
}

describe("captureBullMQ", () => {
  it("emits a QueueEvent with payload, status=success, and duration", async () => {
    const sink = new RecordingSink();
    const wrapped = captureBullMQ(sink, "emails", async (job: BullMQJobLike<{ to: string }>) => {
      expect(currentEventId()).toBeDefined();
      return `sent:${job.data.to}`;
    });

    const result = await wrapped({ id: "j1", name: "send-email", data: { to: "a@b" } });
    expect(result).toBe("sent:a@b");
    await sink.drain();

    const events = sink.events();
    expect(events).toHaveLength(1);
    const q = events[0]!.queue!;
    expect(q.queueName).toBe("emails");
    expect(q.broker).toBe("bullmq");
    expect(q.messageId).toBe("j1");
    expect(q.status).toBe("success");
    expect(q.durationNs).toBeGreaterThanOrEqual(0n);
    expect(q.headers.job_name).toBe("send-email");
    expect(events[0]!.metadata.queue).toBe("emails");

    const inline = q.payload?.inline;
    expect(inline).toBeDefined();
    expect(JSON.parse(Buffer.from(inline!).toString("utf-8"))).toEqual({
      to: "a@b",
    });
  });

  it("captures a failed job with status=error and re-throws", async () => {
    const sink = new RecordingSink();
    const wrapped = captureBullMQ(sink, "emails", async () => {
      throw new Error("smtp boom");
    });

    await expect(wrapped({ id: "j2", name: "flaky", data: {} })).rejects.toThrow(
      "smtp boom",
    );
    await sink.drain();

    const q = sink.events()[0]!.queue!;
    expect(q.status).toBe("error");
    expect(sink.events()[0]!.metadata.error).toBe("smtp boom");
  });

  it("runs the processor inside a capture scope", async () => {
    const sink = new RecordingSink();
    let inside: string | undefined;
    const wrapped = captureBullMQ(sink, "emails", async () => {
      inside = currentEventId();
    });

    await wrapped({ id: "j3", name: "x", data: {} });
    await sink.drain();

    expect(inside).toBeDefined();
    expect(inside).toBe(sink.events()[0]!.id);
    // Outside, no scope.
    expect(currentEventId()).toBeUndefined();
  });

  it("handles jobs without an id", async () => {
    const sink = new RecordingSink();
    const wrapped = captureBullMQ(sink, "emails", async () => "ok");

    await wrapped({ name: "unnamed", data: {} });
    await sink.drain();

    expect(sink.events()[0]!.queue!.messageId).toBe("");
  });
});
