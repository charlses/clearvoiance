/**
 * Phase 1a end-to-end smoke test.
 *
 * Prerequisite: run `./bin/clearvoiance serve` before invoking this script.
 *
 * Starts a session, streams 5 fake HTTP events in one batch, stops.
 * Asserts the engine reports 5 events captured with non-zero bytes.
 */
import { createClient } from "../../src/index.js";
import type { Event } from "../../src/generated/clearvoiance/v1/event.js";

const ENGINE = process.env.CLEARVOIANCE_ENGINE_URL ?? "127.0.0.1:9100";

function fakeHttpEvent(i: number, sessionId: string, startNs: bigint): Event {
  return {
    id: `ev_smoke_${i}`,
    sessionId,
    timestampNs: startNs + BigInt(i) * 1_000_000n,
    offsetNs: BigInt(i) * 1_000_000n,
    adapter: "smoke",
    sdkVersion: "smoke-test",
    metadata: {},
    redactionsApplied: [],
    http: {
      method: "GET",
      path: `/hello/${i}`,
      httpVersion: "HTTP/1.1",
      headers: {
        "content-type": { values: ["text/plain"] },
      },
      requestBody: undefined,
      status: 200,
      responseHeaders: {},
      responseBody: undefined,
      durationNs: 500_000n,
      sourceIp: "127.0.0.1",
      userId: "",
      routeTemplate: `/hello/:i`,
    },
  };
}

async function main(): Promise<void> {
  const client = createClient({
    engine: { url: ENGINE, apiKey: "smoke" },
    session: { name: "phase-1a-smoke" },
  });

  console.log(`→ connecting to ${ENGINE}`);
  const session = await client.start();
  console.log(`✓ session ${session.id}`);

  const startNs = BigInt(Date.now()) * 1_000_000n;
  const events = Array.from({ length: 5 }, (_, i) => fakeHttpEvent(i, session.id, startNs));

  await client.sendBatch(events);
  console.log(`✓ batch of ${events.length} acked`);

  const result = await client.stop();
  console.log(`✓ stopped: ${result.eventsCaptured} events / ${result.bytesCaptured} bytes`);

  if (result.eventsCaptured !== BigInt(events.length)) {
    throw new Error(
      `event count mismatch: sent ${events.length}, engine reports ${result.eventsCaptured}`,
    );
  }
  if (result.bytesCaptured <= 0n) {
    throw new Error(`expected non-zero bytes, got ${result.bytesCaptured}`);
  }
  console.log("✓ smoke passed");
}

main().catch((err) => {
  console.error("✗ smoke failed:", err);
  process.exit(1);
});
