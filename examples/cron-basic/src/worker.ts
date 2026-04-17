/**
 * Minimal cron worker wired up with @clearvoiance/node.
 *
 * Schedules two jobs:
 *   - `heartbeat`  — every second, always succeeds
 *   - `flaky`      — every 2 seconds, throws every 3rd run
 *
 * Each invocation becomes a CronEvent (job_name, scheduler, duration,
 * status, error_message). Ctrl-C closes the session cleanly.
 *
 * Env:
 *   CLEARVOIANCE_ENGINE_URL   default 127.0.0.1:9100
 *   CLEARVOIANCE_API_KEY      default dev
 *   CLEARVOIANCE_SESSION_NAME default cron-basic
 */

import cron from "node-cron";

import { createClient } from "@clearvoiance/node";
import { captureCronJob } from "@clearvoiance/node/cron/node-cron";

const ENGINE_URL = process.env.CLEARVOIANCE_ENGINE_URL ?? "127.0.0.1:9100";
const API_KEY = process.env.CLEARVOIANCE_API_KEY ?? "dev";
const SESSION_NAME = process.env.CLEARVOIANCE_SESSION_NAME ?? "cron-basic";

async function main(): Promise<void> {
  const client = createClient({
    engine: { url: ENGINE_URL, apiKey: API_KEY },
    session: { name: SESSION_NAME },
  });

  console.log(`→ starting session against ${ENGINE_URL}`);
  const session = await client.start();
  console.log(`✓ session ${session.id}`);

  let flakyTick = 0;

  const heartbeat = captureCronJob(client, "heartbeat", async () => {
    // Pretend this does some work.
    await new Promise((r) => setTimeout(r, 5));
  });

  const flaky = captureCronJob(client, "flaky", async () => {
    flakyTick += 1;
    await new Promise((r) => setTimeout(r, 10));
    if (flakyTick % 3 === 0) throw new Error("every-third tick goes boom");
  });

  const h = cron.schedule("* * * * * *", heartbeat);
  const f = cron.schedule("*/2 * * * * *", flaky);

  console.log("✓ cron workers running (heartbeat + flaky)");

  const shutdown = async (signal: string): Promise<void> => {
    console.log(`→ ${signal} received, draining`);
    // node-cron v4: task.stop() halts new invocations
    h.stop();
    f.stop();
    const result = await client.stop({ flushTimeoutMs: 10_000 });
    console.log(`✓ session stopped: ${result.eventsCaptured} events captured`);
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("✗ example failed:", err);
  process.exit(1);
});
