/**
 * Real-Postgres integration test for instrumentPg. Spins up Postgres via
 * @testcontainers/postgresql, runs a sleeping query inside an event scope,
 * and polls pg_stat_activity from a SEPARATE connection to verify the
 * instrumented pool's connection carries the correct application_name.
 *
 * Tagged `integration` — opted into via `pnpm test:integration` or by
 * vitest's include filter. Not part of the default fast test loop because
 * the container startup is slow.
 */

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { runWithEvent } from "../core/event-context.js";
import { instrumentPg } from "./postgres.js";

let container: StartedPostgreSqlContainer;
let pool: Pool;
// Separate observer pool — used to peek at pg_stat_activity without being
// instrumented itself (it would confuse its own rows in activity output).
let observerPool: Pool;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("test")
    .withUsername("test")
    .withPassword("test")
    .start();

  pool = new Pool({
    host: container.getHost(),
    port: container.getPort(),
    database: container.getDatabase(),
    user: container.getUsername(),
    password: container.getPassword(),
    max: 2,
  });

  observerPool = new Pool({
    host: container.getHost(),
    port: container.getPort(),
    database: container.getDatabase(),
    user: container.getUsername(),
    password: container.getPassword(),
    max: 1,
    application_name: "observer-pool",
  });
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await observerPool?.end();
  await container?.stop();
}, 60_000);

async function peekAppName(
  pidSearchTerm: string,
): Promise<Record<string, string>> {
  const { rows } = await observerPool.query<{
    pid: number;
    application_name: string;
    query: string;
    state: string;
  }>(
    `SELECT pid, application_name, query, state
       FROM pg_stat_activity
      WHERE application_name LIKE 'clv:%'
        AND query LIKE $1`,
    [`%${pidSearchTerm}%`],
  );
  const byApp: Record<string, string> = {};
  for (const r of rows) byApp[r.application_name] = r.query;
  return byApp;
}

describe("instrumentPg — real Postgres round trip", () => {
  it("pins application_name to clv:<eventId> while a query runs under an event scope", async () => {
    instrumentPg(pool);

    // We need the SUT's query to be observable while still in-flight.
    // pg_sleep() blocks on the server so pg_stat_activity snapshots it.
    const uniqueMarker = `marker_${Date.now()}_${Math.random().toString(36).slice(2)}`;

    const sutWork = runWithEvent({ eventId: "ev_pg_1" }, async () => {
      // Touch + sleep — the LIKE match on 'marker' lets us isolate this
      // query from any background pg work.
      await pool.query(`SELECT '${uniqueMarker}' AS mark, pg_sleep(1.5)`);
    });

    // Give the SET + user query a moment to land server-side.
    await new Promise((r) => setTimeout(r, 300));
    const seen = await peekAppName(uniqueMarker);

    // Finish the in-flight query.
    await sutWork;

    const apps = Object.keys(seen);
    expect(
      apps,
      `expected exactly one clv: app running the marker query, got ${JSON.stringify(seen)}`,
    ).toContain("clv:ev_pg_1");
  }, 60_000);

  it("uses clv:<replayId>:<eventId> when replayId is configured", async () => {
    // Need a fresh pool so the new `on('connect')` listener wraps new
    // physical connections with the replayId setting.
    const rpool = new Pool({
      host: container.getHost(),
      port: container.getPort(),
      database: container.getDatabase(),
      user: container.getUsername(),
      password: container.getPassword(),
      max: 1,
    });
    instrumentPg(rpool, { replayId: "rep_42" });

    try {
      const uniqueMarker = `marker2_${Date.now()}_${Math.random().toString(36).slice(2)}`;
      const sutWork = runWithEvent({ eventId: "ev_pg_2" }, async () => {
        await rpool.query(`SELECT '${uniqueMarker}' AS mark, pg_sleep(1.5)`);
      });

      await new Promise((r) => setTimeout(r, 300));
      const seen = await peekAppName(uniqueMarker);
      await sutWork;

      expect(Object.keys(seen)).toContain("clv:rep_42:ev_pg_2");
    } finally {
      await rpool.end();
    }
  }, 60_000);

  it("leaves the application_name at its default when no event scope is active", async () => {
    // Use a fresh pool so prior tests' SETs don't pollute us.
    const bpool = new Pool({
      host: container.getHost(),
      port: container.getPort(),
      database: container.getDatabase(),
      user: container.getUsername(),
      password: container.getPassword(),
      max: 1,
      application_name: "baseline-pool",
    });
    instrumentPg(bpool);

    try {
      const uniqueMarker = `no_scope_${Date.now()}`;
      const sutWork = bpool.query(
        `SELECT '${uniqueMarker}' AS mark, pg_sleep(1.0)`,
      );
      await new Promise((r) => setTimeout(r, 200));

      const { rows } = await observerPool.query<{
        application_name: string;
      }>(
        `SELECT application_name FROM pg_stat_activity
           WHERE query LIKE $1`,
        [`%${uniqueMarker}%`],
      );
      await sutWork;

      const names = rows.map((r) => r.application_name);
      expect(
        names.some((n) => n.startsWith("clv:")),
        `no clv: app names expected, got ${JSON.stringify(names)}`,
      ).toBe(false);
    } finally {
      await bpool.end();
    }
  }, 60_000);
});
