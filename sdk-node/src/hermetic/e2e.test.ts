/**
 * End-to-end Phase 3 core-slice test: captures outbound events via the real
 * outbound/fetch patch, builds a MockStore from those captures (mirroring
 * what the engine's mockpack/gRPC streaming does), installs the hermetic
 * intercept, and verifies that replay-phase fetch calls NEVER touch the
 * real target.
 *
 * This is the strongest integration test we can run in-process: it exercises
 * capture → signature computation → mock-pack build → hermetic lookup in
 * a single Node process, catching any JS-only drift between capture-time
 * and replay-time signatures that the golden-value parity test can't
 * detect on its own.
 */

import type { Server } from "node:http";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { currentEventId, runWithEvent } from "../core/event-context.js";
import { patchFetch } from "../outbound/fetch.js";
import type { PatchHandle } from "../outbound/http.js";
import { signatureOf } from "../outbound/signature.js";
import type {
  Event as PbEvent,
  OutboundEvent as PbOutboundEvent,
} from "../generated/clearvoiance/v1/event.js";

import { installHermetic, type HermeticHandle } from "./intercept.js";
import { MockStore, type MockEntry } from "./mock-store.js";

interface CountingServer {
  server: Server;
  url: string;
  /** Number of requests this server has observed (resets on reset()). */
  count(): number;
  reset(): void;
}

async function startTargetServer(): Promise<CountingServer> {
  let hits = 0;
  const server = createServer((req, res) => {
    hits++;
    let body = "";
    req.on("data", (c) => (body += c.toString()));
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      res.statusCode = 200;
      res.end(
        JSON.stringify({
          ok: true,
          path: req.url,
          method: req.method,
          echoed: body,
        }),
      );
    });
  });
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  const { port } = server.address() as AddressInfo;
  return {
    server,
    url: `http://127.0.0.1:${port}`,
    count: () => hits,
    reset: () => {
      hits = 0;
    },
  };
}

function stop(server: Server): Promise<void> {
  return new Promise((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
}

/** A sink that keeps the captured events for later replay-side translation. */
class CaptureSink {
  readonly events: PbEvent[] = [];
  async sendBatch(batch: PbEvent[]): Promise<void> {
    this.events.push(...batch);
  }
  readonly inflight: Promise<unknown>[] = [];
  track<T>(p: Promise<T>): Promise<T> {
    this.inflight.push(p);
    return p;
  }
  async drain(): Promise<void> {
    await Promise.allSettled([...this.inflight]);
  }
}

/**
 * Translates captured Events into MockEntry form the exact way the engine's
 * BuildMockPack does. If this function drifts from engine/internal/hermetic/
 * mockpack.go, the integration breaks — this is the ground truth for the
 * wire format.
 */
function mockEntriesFromCapture(events: PbEvent[]): MockEntry[] {
  const out: MockEntry[] = [];
  for (const ev of events) {
    const outbound = ev.outbound as PbOutboundEvent | undefined;
    if (!outbound) continue;
    const httpEv = outbound.http;
    if (!httpEv) continue;

    const host = ev.metadata?.["host"] ?? outbound.target;
    const requestBody = httpEv.requestBody?.inline
      ? Buffer.from(httpEv.requestBody.inline)
      : undefined;
    const responseBody = httpEv.responseBody?.inline
      ? Buffer.from(httpEv.responseBody.inline)
      : Buffer.alloc(0);

    const signature = signatureOf({
      method: httpEv.method,
      host,
      path: httpEv.path,
      body: requestBody,
      contentType: httpEv.requestBody?.contentType,
    });

    const responseHeaders: Record<string, string[]> = {};
    for (const [k, v] of Object.entries(httpEv.responseHeaders ?? {})) {
      responseHeaders[k] = v.values ?? [];
    }

    out.push({
      eventId: outbound.causedByEventId,
      signature,
      status: httpEv.status,
      responseHeaders,
      responseBody,
      responseContentType: httpEv.responseBody?.contentType ?? "",
    });
  }
  return out;
}

describe("Phase 3 e2e: capture → mockpack → hermetic replay", () => {
  let target: CountingServer;
  let captureHandle: PatchHandle | null = null;
  let hermeticHandle: HermeticHandle | null = null;

  beforeEach(async () => {
    target = await startTargetServer();
  });

  afterEach(async () => {
    if (captureHandle) captureHandle.uninstall();
    if (hermeticHandle) hermeticHandle.uninstall();
    captureHandle = null;
    hermeticHandle = null;
    await stop(target.server);
  });

  it("replays captured outbounds from mocks and never touches the real target", async () => {
    const sink = new CaptureSink();

    // --- Capture phase: hit the real target a few times, recording outbounds. ---
    captureHandle = patchFetch(sink);

    const captureResponses = await runWithEvent(
      { eventId: "ev_inbound_1" },
      async () => {
        const r1 = await fetch(`${target.url}/api/profile`);
        const body1 = await r1.json();

        const r2 = await fetch(`${target.url}/api/webhook`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ event: "user.created", id: 42 }),
        });
        const body2 = await r2.json();

        // A second identical call — tests that mock cycling/reuse works.
        const r3 = await fetch(`${target.url}/api/profile`);
        const body3 = await r3.json();

        return [body1, body2, body3];
      },
    );
    await sink.drain();

    expect(target.count()).toBe(3); // three real round trips
    expect(sink.events).toHaveLength(3);
    expect(captureResponses[0]).toMatchObject({ ok: true });

    // Tear down capture before hermetic (both patch the same surfaces).
    captureHandle.uninstall();
    captureHandle = null;

    // --- Translate captured events → mock pack → store. ---
    const entries = mockEntriesFromCapture(sink.events);
    expect(entries).toHaveLength(3);
    const store = new MockStore();
    for (const e of entries) store.add(e);
    expect(store.size).toBe(3);

    // --- Replay phase: install hermetic, fire the same calls, assert no
    //     bytes leave the process. ---
    target.reset();
    hermeticHandle = installHermetic({ store, policy: "strict" });

    const replayResponses = await runWithEvent(
      { eventId: "ev_inbound_1" },
      async () => {
        const r1 = await fetch(`${target.url}/api/profile`);
        const body1 = await r1.json();

        const r2 = await fetch(`${target.url}/api/webhook`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ event: "user.created", id: 42 }),
        });
        const body2 = await r2.json();

        const r3 = await fetch(`${target.url}/api/profile`);
        const body3 = await r3.json();

        return [body1, body2, body3];
      },
    );

    expect(target.count()).toBe(0); // HERMETIC: zero real requests
    expect(replayResponses).toEqual(captureResponses);
  });

  it("throws under strict policy when the SUT makes a new outbound not in the mock pack", async () => {
    const sink = new CaptureSink();
    captureHandle = patchFetch(sink);

    await runWithEvent({ eventId: "ev_2" }, async () => {
      const r = await fetch(`${target.url}/api/known`);
      await r.json();
    });
    await sink.drain();

    captureHandle.uninstall();
    captureHandle = null;

    const store = new MockStore();
    for (const e of mockEntriesFromCapture(sink.events)) store.add(e);

    target.reset();
    hermeticHandle = installHermetic({ store, policy: "strict" });

    // Same inbound scope, but a DIFFERENT outbound — not in the pack.
    // Under strict, this throws rather than letting the SUT hit the real target.
    await expect(
      runWithEvent({ eventId: "ev_2" }, async () => {
        const r = await fetch(`${target.url}/api/new-endpoint`);
        await r.json();
      }),
    ).rejects.toThrow(/unmocked outbound/);

    expect(target.count()).toBe(0);
    // Verify currentEventId still works correctly — hermetic doesn't leak scope.
    expect(currentEventId()).toBeUndefined();
  });
});
