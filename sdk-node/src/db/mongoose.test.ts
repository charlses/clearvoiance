import { describe, expect, it } from "vitest";

import { runWithEvent } from "../core/event-context.js";
import { instrumentMongoose } from "./mongoose.js";
import type { Event as PbEvent } from "../generated/clearvoiance/v1/event.js";

// Unit tests with a stub mongoose that captures installed pre/post
// hooks so we can drive them directly. Real mongoose behavior is
// covered by an integration test that the consumer runs against a
// throwaway MongoDB if we add one; the SDK core tests stay hermetic.

function fakeMongoose(): {
  mongoose: {
    plugin: (fn: (schema: unknown) => void) => void;
    plugins: unknown[];
  };
  invoke: (
    preOrPost: "pre" | "post",
    op: string,
    ctx: Record<string, unknown>,
    res?: unknown,
  ) => void;
} {
  type Hook = {
    kind: "pre" | "post";
    ops: string[];
    fn: (this: Record<string, unknown>, ...args: unknown[]) => void;
  };
  const hooks: Hook[] = [];
  const schema = {
    pre(name: string | string[], fn: Hook["fn"]): void {
      const ops = Array.isArray(name) ? name : [name];
      hooks.push({ kind: "pre", ops, fn });
    },
    post(name: string | string[], fn: Hook["fn"]): void {
      const ops = Array.isArray(name) ? name : [name];
      hooks.push({ kind: "post", ops, fn });
    },
  };
  const mongoose = {
    plugins: [] as unknown[],
    plugin(fn: (schema: unknown) => void): void {
      fn(schema);
      this.plugins.push(fn);
    },
  };
  return {
    mongoose,
    invoke(kind, op, ctx, res) {
      for (const h of hooks) {
        if (h.kind === kind && h.ops.includes(op)) {
          h.fn.call(ctx, res);
        }
      }
    },
  };
}

function fakeClient(): {
  client: {
    sendBatch: (events: PbEvent[]) => Promise<void>;
    track<T>(p: Promise<T>): Promise<T>;
  };
  sent: PbEvent[];
} {
  const sent: PbEvent[] = [];
  const client = {
    sendBatch: async (events: PbEvent[]): Promise<void> => {
      sent.push(...events);
    },
    track<T>(p: Promise<T>): Promise<T> {
      return p;
    },
  };
  return { client, sent };
}

// Simulate hrtime: pre-hook stores start, post-hook computes duration.
// We don't need real time — the hook reads process.hrtime.bigint()
// directly, so we just ensure some real time passes between pre and
// post to get a nonzero duration.
async function nap(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

describe("instrumentMongoose", () => {
  it("emits a DbObservation with caused_by_event_id set from AsyncLocalStorage", async () => {
    const { mongoose, invoke } = fakeMongoose();
    const { client, sent } = fakeClient();

    instrumentMongoose(mongoose, client);

    await runWithEvent({ eventId: "ev_http_42" }, async () => {
      const ctx: Record<string, unknown> = {
        op: "find",
        model: { modelName: "User" },
        getQuery: () => ({ email: "x@example.com" }),
      };
      invoke("pre", "find", ctx);
      await nap(5);
      invoke("post", "find", ctx);
    });

    // Let the async sendBatch fire.
    await nap(0);

    expect(sent.length).toBe(1);
    const ev = sent[0]!;
    // Each DbObservation event gets its own unique id; the linkage to the
    // triggering HTTP event lives in db.causedByEventId.
    expect(ev.id).toMatch(/^ev_/);
    expect(ev.id).not.toBe("ev_http_42");
    expect(ev.adapter).toBe("db.mongoose");
    expect(ev.db).toBeDefined();
    expect(ev.db?.causedByEventId).toBe("ev_http_42");
    expect(ev.db?.queryFingerprint).toBe("User.find");
    expect(ev.db?.queryText).toContain("User.find");
    expect(ev.db?.applicationName).toBe("clv:ev_http_42");
  });

  it("drops ops that fire outside any event scope", async () => {
    const { mongoose, invoke } = fakeMongoose();
    const { client, sent } = fakeClient();

    instrumentMongoose(mongoose, client);

    const ctx: Record<string, unknown> = {
      op: "findOne",
      model: { modelName: "Post" },
    };
    invoke("pre", "findOne", ctx);
    await nap(5);
    invoke("post", "findOne", ctx);
    await nap(0);

    expect(sent.length).toBe(0);
  });

  it("respects slowThresholdMs and drops fast queries", async () => {
    const { mongoose, invoke } = fakeMongoose();
    const { client, sent } = fakeClient();

    instrumentMongoose(mongoose, client, { slowThresholdMs: 1000 });

    await runWithEvent({ eventId: "ev_x" }, async () => {
      const ctx: Record<string, unknown> = {
        op: "find",
        model: { modelName: "Order" },
      };
      invoke("pre", "find", ctx);
      await nap(5); // way under 1000ms
      invoke("post", "find", ctx);
    });
    await nap(0);

    expect(sent.length).toBe(0);
  });

  it("encodes replayId into the application_name when set", async () => {
    const { mongoose, invoke } = fakeMongoose();
    const { client, sent } = fakeClient();

    instrumentMongoose(mongoose, client, { replayId: "rep_abc" });

    await runWithEvent({ eventId: "ev_1" }, async () => {
      const ctx: Record<string, unknown> = {
        op: "find",
        model: { modelName: "Widget" },
      };
      invoke("pre", "find", ctx);
      await nap(1);
      invoke("post", "find", ctx);
    });
    await nap(0);

    expect(sent[0]?.db?.applicationName).toBe("clv:rep_abc:ev_1");
  });

  it("handles document middleware (save) where `this` is a doc", async () => {
    const { mongoose, invoke } = fakeMongoose();
    const { client, sent } = fakeClient();

    instrumentMongoose(mongoose, client);

    await runWithEvent({ eventId: "ev_save" }, async () => {
      const ctx: Record<string, unknown> = {
        // Document middleware: `this` is the doc, modelName comes from
        // the constructor.
        constructor: { modelName: "User" },
      };
      invoke("pre", "save", ctx);
      await nap(1);
      invoke("post", "save", ctx);
    });
    await nap(0);

    expect(sent.length).toBe(1);
    expect(sent[0]?.db?.queryFingerprint).toBe("User.save");
  });
});
