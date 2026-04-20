import { describe, expect, it } from "vitest";

import { runWithEvent } from "../core/event-context.js";
import { instrumentKnex } from "./knex.js";

// Tests here use a fake "Knex-like" object to prove the wrapper
// correctly targets the pg.Client returned by acquireRawConnection.
// Real Postgres behavior is covered by the integration test that spins
// a real Knex + testcontainers Postgres.

describe("instrumentKnex (unit)", () => {
  it("wraps query on newly-acquired connections when driver is pg", async () => {
    const calls: string[] = [];
    const fakeConn = {
      query: (sql: string): Promise<{ rows: unknown[] }> => {
        calls.push(sql);
        return Promise.resolve({ rows: [] });
      },
    };
    const fakeKnex = {
      client: {
        driverName: "pg",
        acquireRawConnection: () => Promise.resolve(fakeConn),
      },
    };

    instrumentKnex(fakeKnex, { appPrefix: "clv:" });

    const conn = await fakeKnex.client.acquireRawConnection();
    await runWithEvent(
      { eventId: "ev_test123" },
      () => (conn as typeof fakeConn).query("SELECT 1"),
    );

    // Expect two calls: the SET application_name, then the user query.
    expect(calls).toEqual([
      "SET application_name = 'clv:ev_test123'",
      "SELECT 1",
    ]);
  });

  it("is a silent no-op for non-pg drivers", async () => {
    const fakeKnex = {
      client: {
        driverName: "mysql2",
        acquireRawConnection: () => Promise.resolve({
          query: (sql: string) => Promise.resolve(sql),
        }),
      },
    };
    const originalAcquire = fakeKnex.client.acquireRawConnection;
    const handle = instrumentKnex(fakeKnex);

    expect(fakeKnex.client.acquireRawConnection).toBe(originalAcquire);
    expect(handle.uninstall).toBeDefined();
  });

  it("skips SET when no event scope is active", async () => {
    const calls: string[] = [];
    const fakeConn = {
      query: (sql: string) => {
        calls.push(sql);
        return Promise.resolve({ rows: [] });
      },
    };
    const fakeKnex = {
      client: {
        driverName: "pg",
        acquireRawConnection: () => Promise.resolve(fakeConn),
      },
    };

    instrumentKnex(fakeKnex);
    const conn = await fakeKnex.client.acquireRawConnection();
    // No runWithEvent scope — queries pass straight through.
    await (conn as typeof fakeConn).query("SELECT 2");
    expect(calls).toEqual(["SELECT 2"]);
  });

  it("wraps pre-existing pool connections retroactively", async () => {
    const calls: string[] = [];
    const existingConn = {
      query: (sql: string) => {
        calls.push(sql);
        return Promise.resolve({ rows: [] });
      },
    };
    const fakeKnex = {
      client: {
        driverName: "pg",
        acquireRawConnection: () => Promise.resolve({ query: () => Promise.resolve() }),
        pool: {
          _freeObjects: [{ resource: existingConn }],
          _usedObjects: [],
        },
      },
    };

    instrumentKnex(fakeKnex);

    await runWithEvent(
      { eventId: "ev_preexisting" },
      () => existingConn.query("SELECT 3"),
    );
    expect(calls).toEqual([
      "SET application_name = 'clv:ev_preexisting'",
      "SELECT 3",
    ]);
  });

  it("uninstall restores the original acquireRawConnection", () => {
    const originalAcquire = () => Promise.resolve({ query: () => Promise.resolve() });
    const fakeKnex = {
      client: {
        driverName: "pg",
        acquireRawConnection: originalAcquire,
      },
    };
    const handle = instrumentKnex(fakeKnex);
    expect(fakeKnex.client.acquireRawConnection).not.toBe(originalAcquire);
    handle.uninstall();
    expect(fakeKnex.client.acquireRawConnection).toBe(originalAcquire);
  });

  it("truncates application_name to 63 chars (pg limit)", async () => {
    const calls: string[] = [];
    const fakeConn = {
      query: (sql: string) => {
        calls.push(sql);
        return Promise.resolve({ rows: [] });
      },
    };
    const fakeKnex = {
      client: {
        driverName: "pg",
        acquireRawConnection: () => Promise.resolve(fakeConn),
      },
    };
    instrumentKnex(fakeKnex, { replayId: "rep_" + "x".repeat(60) });

    const conn = await fakeKnex.client.acquireRawConnection();
    await runWithEvent(
      { eventId: "ev_" + "y".repeat(40) },
      () => (conn as typeof fakeConn).query("SELECT 1"),
    );

    // First call is the SET — the app-name inside the quotes must be <= 63 chars.
    const setSQL = calls[0] ?? "";
    const match = setSQL.match(/^SET application_name = '(.*)'$/);
    expect(match).not.toBeNull();
    expect((match?.[1] ?? "").length).toBeLessThanOrEqual(63);
  });
});
