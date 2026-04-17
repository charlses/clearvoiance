/**
 * Smoke client used by scripts/e2e-smoke-socketio.sh.
 *
 * Connects to the example server, exercises:
 *   - default namespace: ping/pong + a broadcast
 *   - /chat namespace:   say/echo
 * Then disconnects cleanly.
 */
import { io as ioClient } from "socket.io-client";

const SERVER_URL = process.env.SMOKE_SERVER_URL ?? "http://127.0.0.1:4100";

async function main(): Promise<void> {
  console.log(`→ connecting to ${SERVER_URL}`);

  const root = ioClient(SERVER_URL, {
    transports: ["websocket"],
    auth: { uid: "u-smoke-42" },
  });
  await new Promise<void>((resolve, reject) => {
    root.on("connect", () => resolve());
    root.on("connect_error", (err) => reject(err));
    setTimeout(() => reject(new Error("connect timeout")), 5000);
  });

  const pong = new Promise<unknown>((resolve) => root.once("pong", resolve));
  root.emit("ping", "hello");
  console.log("✓ pong received:", await pong);

  // Broadcast echoes itself back via io.emit, so the client will see it too.
  const fanout = new Promise<unknown>((resolve) => root.once("broadcast:fanout", resolve));
  root.emit("broadcast", "to everyone");
  console.log("✓ broadcast fanout:", await fanout);

  const chat = ioClient(`${SERVER_URL}/chat`, {
    transports: ["websocket"],
    auth: { uid: "u-smoke-42" },
  });
  await new Promise<void>((resolve, reject) => {
    chat.on("connect", () => resolve());
    chat.on("connect_error", (err) => reject(err));
    setTimeout(() => reject(new Error("chat connect timeout")), 5000);
  });

  const echo = new Promise<unknown>((resolve) => chat.once("echo", resolve));
  chat.emit("say", "hi chat");
  console.log("✓ echo received:", await echo);

  root.disconnect();
  chat.disconnect();
  console.log("✓ smoke client done");
}

main().catch((err) => {
  console.error("✗ smoke client failed:", err);
  process.exit(1);
});
