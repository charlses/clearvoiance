import { describe, expect, it } from "vitest";

import { runWithEvent } from "../core/event-context.js";
import { instrumentPg, parseClvAppName } from "./postgres.js";
import type { PgClientLike } from "./pg-wrap.js";

describe("parseClvAppName", () => {
  it("parses clv:<eventId> (no replay)", () => {
    expect(parseClvAppName("clv:ev_abc123")).toEqual({ eventId: "ev_abc123" });
  });
  it("parses clv:<replayId>:<eventId>", () => {
    expect(parseClvAppName("clv:rep_7:ev_abc123")).toEqual({
      replayId: "rep_7",
      eventId: "ev_abc123",
    });
  });
  it("returns null for non-clv names", () => {
    expect(parseClvAppName("postgres")).toBeNull();
    expect(parseClvAppName("")).toBeNull();
    expect(parseClvAppName("clv:")).toBeNull();
  });
  it("honors a custom prefix", () => {
    expect(parseClvAppName("obs:ev_1", "obs:")).toEqual({ eventId: "ev_1" });
  });
});

// Minimal fake pg.Pool that exposes `on('connect', ...)` + lets tests
// mint + drive a fake pg.Client back through the same code path that
// runs in production.
function fakePool(): {
  pool: {
    on: (event: "connect", listener: (c: PgClientLike) => void) => void;
    removeListener: (event: "connect", listener: (c: PgClientLike) => void) => void;
    emit: (c: PgClientLike) => void;
  };
} {
  const listeners: Array<(c: PgClientLike) => void> = [];
  return {
    pool: {
      on(event, listener): void {
        if (event === "connect") listeners.push(listener);
      },
      removeListener(event, listener): void {
        if (event !== "connect") return;
        const idx = listeners.indexOf(listener);
        if (idx >= 0) listeners.splice(idx, 1);
      },
      emit(c): void {
        for (const l of [...listeners]) l(c);
      },
    },
  };
}

describe("instrumentPg — SDK-side emit", () => {
  it("emits a DbObservationEvent per query when emit.client is set", async () => {
    const { pool } = fakePool();
    const calls: string[] = [];
    const conn: PgClientLike = {
      query: (async (...args: unknown[]): Promise<unknown> => {
        calls.push(args[0] as string);
        await new Promise((r) => setTimeout(r, 3));
        return { rows: [], rowCount: 0 };
      }) as PgClientLike["query"],
    };
    const sent: unknown[] = [];
    const client = {
      sendBatch: async (events: unknown[]): Promise<void> => {
        sent.push(...events);
      },
    };
    instrumentPg(pool, { emit: { client, slowThresholdMs: 0 } });
    pool.emit(conn);

    await runWithEvent(
      { eventId: "ev_pg1" },
      () => conn.query("SELECT * FROM leads WHERE id = 7") as Promise<unknown>,
    );

    expect(sent.length).toBe(1);
    const event = sent[0] as {
      adapter: string;
      db: { causedByEventId: string; queryFingerprint: string };
    };
    expect(event.adapter).toBe("db.postgres");
    expect(event.db.causedByEventId).toBe("ev_pg1");
    expect(event.db.queryFingerprint).toBe("SELECT * FROM leads WHERE id = ?");
  });

  it("does not emit under threshold", async () => {
    const { pool } = fakePool();
    const conn: PgClientLike = {
      query: (async (): Promise<unknown> => ({ rows: [] })) as PgClientLike["query"],
    };
    const sent: unknown[] = [];
    const client = {
      sendBatch: async (events: unknown[]): Promise<void> => {
        sent.push(...events);
      },
    };
    instrumentPg(pool, { emit: { client, slowThresholdMs: 500 } });
    pool.emit(conn);

    await runWithEvent(
      { eventId: "ev_pg2" },
      () => conn.query("SELECT 1") as Promise<unknown>,
    );
    expect(sent.length).toBe(0);
  });
});
