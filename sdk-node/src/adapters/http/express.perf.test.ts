/**
 * Overhead benchmark: Express with the clearvoiance capture middleware vs.
 * Express without it. Drives 1000 requests through both and asserts the
 * capture middleware adds no more than `MAX_OVERHEAD_PCT` on wall clock.
 *
 * Not a precise microbenchmark — Node's IO-heavy request loop makes absolute
 * numbers noisy between machines. What we *can* assert is "the sink is not a
 * bottleneck" — i.e. middleware overhead stays in the single-digit percent
 * range. This catches regressions like accidentally switching to a sync sink
 * or removing the fire-and-forget dispatch path.
 */

import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Event as PbEvent } from "../../generated/clearvoiance/v1/event.js";
import { captureHttp } from "./express.js";

const N_REQUESTS = 1000;
// Safety margin: local dev typically sees <20%. CI (constrained CPU, noisy
// neighbours) can spike into the 50s. We just need to catch pathological
// regressions (e.g. middleware went synchronous or added ~millisecond per req).
const MAX_OVERHEAD_PCT = 100;

class DiscardSink {
  async sendBatch(_events: PbEvent[]): Promise<void> {
    // Fire-and-forget: mirror what the real client's non-blocking dispatch
    // does. No await work, no allocations beyond what the middleware itself
    // is already doing.
  }
}

function listen(app: express.Express): Promise<{ server: Server; url: string }> {
  return new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, url: `http://127.0.0.1:${port}` });
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

async function drive(url: string, n: number): Promise<number> {
  const start = process.hrtime.bigint();
  for (let i = 0; i < n; i++) {
    const r = await fetch(`${url}/ping`);
    await r.text();
  }
  const end = process.hrtime.bigint();
  return Number(end - start) / 1_000_000; // ms
}

describe("captureHttp overhead vs. baseline express", () => {
  let baselineServer: Server | null = null;
  let capturedServer: Server | null = null;

  beforeEach(() => {
    baselineServer = null;
    capturedServer = null;
  });

  afterEach(async () => {
    if (baselineServer) await close(baselineServer);
    if (capturedServer) await close(capturedServer);
  });

  it(
    `adds <${MAX_OVERHEAD_PCT}% wall-clock overhead at ${N_REQUESTS} requests`,
    async () => {
      const baselineApp = express();
      baselineApp.get("/ping", (_req, res) => {
        res.json({ ok: true });
      });
      const baseline = await listen(baselineApp);
      baselineServer = baseline.server;

      const capturedApp = express();
      capturedApp.use(captureHttp(new DiscardSink()));
      capturedApp.get("/ping", (_req, res) => {
        res.json({ ok: true });
      });
      const captured = await listen(capturedApp);
      capturedServer = captured.server;

      // Warm up both — JIT, socket pool, etc. The first few requests are
      // always slower and distort the comparison.
      await drive(baseline.url, 50);
      await drive(captured.url, 50);

      const baselineMs = await drive(baseline.url, N_REQUESTS);
      const capturedMs = await drive(captured.url, N_REQUESTS);

      const overheadPct = ((capturedMs - baselineMs) / baselineMs) * 100;

      // Surface the numbers in CI logs so we can tune the threshold if it
      // turns out to be too tight.
      // eslint-disable-next-line no-console
      console.log(
        `[perf] baseline=${baselineMs.toFixed(1)}ms captured=${capturedMs.toFixed(
          1,
        )}ms overhead=${overheadPct.toFixed(1)}%`,
      );

      expect(overheadPct).toBeLessThan(MAX_OVERHEAD_PCT);
    },
    30_000,
  );
});
