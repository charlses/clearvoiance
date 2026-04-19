/**
 * Minimal Express app wired up with @clearvoiance/node.
 *
 * Two modes controlled by env:
 *
 *   Auto-session (default): `client.start()` opens a capture session
 *   on boot. Every inbound request is captured until the process
 *   exits. Good for local demos + the e2e smoke.
 *
 *   Remote control: set `CLEARVOIANCE_REMOTE_CLIENT=<name>`. The SDK
 *   subscribes to the engine's ControlService and waits idle. The
 *   dashboard's Monitors page drives Start / Stop. Matches how the
 *   production flow works — capture in short named windows whenever
 *   you want to record a snapshot.
 *
 * Env:
 *   CLEARVOIANCE_ENGINE_URL       default 127.0.0.1:9100
 *   CLEARVOIANCE_API_KEY          required (mint one in the dashboard)
 *   CLEARVOIANCE_TLS              "true" when the URL terminates TLS
 *   CLEARVOIANCE_REMOTE_CLIENT    set to enable remote mode; serves as
 *                                 the monitor's stable client_name
 *   CLEARVOIANCE_SESSION_NAME     default "express-basic" (auto-session only)
 *   CLEARVOIANCE_WAL_DIR          optional
 *   PORT                          default 4000
 */

import express from "express";

import { createClient } from "@clearvoiance/node";
import { captureHttp } from "@clearvoiance/node/http/express";

const ENGINE_URL = process.env.CLEARVOIANCE_ENGINE_URL ?? "127.0.0.1:9100";
const API_KEY = process.env.CLEARVOIANCE_API_KEY ?? "dev";
const SESSION_NAME = process.env.CLEARVOIANCE_SESSION_NAME ?? "express-basic";
const REMOTE_CLIENT = process.env.CLEARVOIANCE_REMOTE_CLIENT ?? "";
const TLS = (process.env.CLEARVOIANCE_TLS ?? "false") === "true";
const PORT = Number(process.env.PORT ?? 4000);

async function main(): Promise<void> {
  const client = createClient({
    engine: { url: ENGINE_URL, apiKey: API_KEY, tls: TLS },
    session: { name: SESSION_NAME },
    ...(REMOTE_CLIENT
      ? {
          remote: {
            clientName: REMOTE_CLIENT,
            displayName: `express-basic (${REMOTE_CLIENT})`,
            labels: { example: "express-basic" },
          },
        }
      : {}),
    ...(process.env.CLEARVOIANCE_WAL_DIR
      ? { wal: { dir: process.env.CLEARVOIANCE_WAL_DIR } }
      : {}),
  });

  if (REMOTE_CLIENT) {
    console.log(
      `→ subscribing as monitor "${REMOTE_CLIENT}" — waiting for the dashboard to start capture`,
    );
    await client.start();
    console.log(`✓ subscribed to ${ENGINE_URL}`);
  } else {
    console.log(`→ starting session against ${ENGINE_URL}`);
    const session = await client.start();
    console.log(`✓ session ${session?.id ?? "(remote)"}`);
  }

  const app = express();
  app.use(captureHttp(client));
  // Large limit so we can exercise the blob-upload path in the e2e smoke.
  app.use(express.json({ limit: "10mb" }));

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
    // Wait up to 10s for any in-flight blob uploads / sends to complete.
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
