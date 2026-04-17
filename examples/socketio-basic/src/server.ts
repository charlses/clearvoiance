/**
 * Minimal Socket.io server wired up with @clearvoiance/node.
 *
 * Every connection, emit, and incoming event is captured and streamed to the
 * engine. Stop the process with SIGINT/SIGTERM — the client flushes and
 * closes its session before exit.
 *
 * Env:
 *   CLEARVOIANCE_ENGINE_URL  default 127.0.0.1:9100
 *   CLEARVOIANCE_API_KEY     default dev
 *   CLEARVOIANCE_SESSION_NAME default socketio-basic
 *   PORT                     default 4100
 */

import { createServer } from "node:http";
import { Server } from "socket.io";

import { createClient } from "@clearvoiance/node";
import { captureSocketIO } from "@clearvoiance/node/socket/socketio";

const ENGINE_URL = process.env.CLEARVOIANCE_ENGINE_URL ?? "127.0.0.1:9100";
const API_KEY = process.env.CLEARVOIANCE_API_KEY ?? "dev";
const SESSION_NAME = process.env.CLEARVOIANCE_SESSION_NAME ?? "socketio-basic";
const PORT = Number(process.env.PORT ?? 4100);

async function main(): Promise<void> {
  const client = createClient({
    engine: { url: ENGINE_URL, apiKey: API_KEY },
    session: { name: SESSION_NAME },
  });

  console.log(`→ starting session against ${ENGINE_URL}`);
  const session = await client.start();
  console.log(`✓ session ${session.id}`);

  const http = createServer();
  const io = new Server(http, { cors: { origin: "*" } });

  captureSocketIO(io, client, {
    userExtractor: (socket) =>
      (socket.handshake.auth as { uid?: string } | undefined)?.uid,
  });

  // Default namespace: echo.
  io.on("connection", (socket) => {
    socket.on("ping", (msg: unknown) => {
      socket.emit("pong", { echo: msg, ts: Date.now() });
    });
    socket.on("broadcast", (msg: string) => {
      io.emit("broadcast:fanout", msg);
    });
  });

  // A second namespace to exercise the io.of() interception path.
  io.of("/chat").on("connection", (socket) => {
    socket.on("say", (msg: string) => {
      socket.emit("echo", `chat:${msg}`);
    });
  });

  http.listen(PORT, () => {
    console.log(`✓ listening on http://127.0.0.1:${PORT}`);
  });

  const shutdown = async (signal: string): Promise<void> => {
    console.log(`→ ${signal} received, draining`);
    await new Promise<void>((resolve) => io.close(() => resolve()));
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
