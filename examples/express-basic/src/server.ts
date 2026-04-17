/**
 * Minimal Express app wired up with @clearvoiance/node.
 *
 * Every inbound request is captured and streamed to the engine. Stop the
 * process with SIGINT/SIGTERM — the client flushes and closes its session
 * before exit.
 *
 * Env:
 *   CLEARVOIANCE_ENGINE_URL  default 127.0.0.1:9100
 *   CLEARVOIANCE_API_KEY     default dev
 *   CLEARVOIANCE_SESSION_NAME default express-basic
 *   PORT                     default 4000
 */

import express from "express";

import { createClient } from "@clearvoiance/node";
import { captureHttp } from "@clearvoiance/node/http/express";

const ENGINE_URL = process.env.CLEARVOIANCE_ENGINE_URL ?? "127.0.0.1:9100";
const API_KEY = process.env.CLEARVOIANCE_API_KEY ?? "dev";
const SESSION_NAME = process.env.CLEARVOIANCE_SESSION_NAME ?? "express-basic";
const PORT = Number(process.env.PORT ?? 4000);

async function main(): Promise<void> {
  const client = createClient({
    engine: { url: ENGINE_URL, apiKey: API_KEY },
    session: { name: SESSION_NAME },
  });

  console.log(`→ starting session against ${ENGINE_URL}`);
  const session = await client.start();
  console.log(`✓ session ${session.id}`);

  const app = express();
  app.use(captureHttp(client));
  app.use(express.json());

  app.get("/health", (_req, res) => {
    res.json({ ok: true });
  });

  app.get("/users/:id", (req, res) => {
    res.json({ id: req.params.id, name: `user ${req.params.id}` });
  });

  app.post("/echo", (req, res) => {
    res.json({ received: req.body });
  });

  const server = app.listen(PORT, () => {
    console.log(`✓ listening on http://127.0.0.1:${PORT}`);
  });

  const shutdown = async (signal: string): Promise<void> => {
    console.log(`→ ${signal} received, draining`);
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    const result = await client.stop();
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
