import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { io as ioClient, type Socket as ClientSocket } from "socket.io-client";
import { Server as IoServer } from "socket.io";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Event as PbEvent } from "../../generated/clearvoiance/v1/event.js";
import { SocketEvent_SocketOp as SocketOp } from "../../generated/clearvoiance/v1/event.js";
import { captureSocketIO } from "./socketio.js";

class RecordingSink {
  public events: PbEvent[] = [];
  async sendBatch(events: PbEvent[]): Promise<void> {
    this.events.push(...events);
  }
}

function startServer(): Promise<{
  http: HttpServer;
  io: IoServer;
  url: string;
}> {
  return new Promise((resolve) => {
    const http = createServer();
    const io = new IoServer(http, { cors: { origin: "*" } });
    http.listen(0, "127.0.0.1", () => {
      const { port } = http.address() as AddressInfo;
      resolve({ http, io, url: `http://127.0.0.1:${port}` });
    });
  });
}

function closeServer(_http: HttpServer, io: IoServer): Promise<void> {
  // io.close() shuts down both engine.io and the attached http server; calling
  // http.close() afterwards fails with "Server is not running".
  return new Promise((resolve) => io.close(() => resolve()));
}

function waitForEvent<T>(
  sink: RecordingSink,
  predicate: (ev: PbEvent) => boolean,
  timeoutMs = 2000,
): Promise<PbEvent> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const check = (): void => {
      const match = sink.events.find(predicate);
      if (match) return resolve(match);
      if (Date.now() - start > timeoutMs) {
        return reject(
          new Error(
            `timeout waiting for event; saw ${JSON.stringify(
              sink.events.map((e) => ({
                op: e.socket?.op,
                name: e.socket?.eventName,
              })),
            )}`,
          ),
        );
      }
      setTimeout(check, 10);
    };
    check();
  });
}

describe("captureSocketIO", () => {
  let sink: RecordingSink;
  let http: HttpServer;
  let io: IoServer;
  let url: string;
  let client: ClientSocket;

  beforeEach(async () => {
    sink = new RecordingSink();
    const started = await startServer();
    http = started.http;
    io = started.io;
    url = started.url;
  });

  afterEach(async () => {
    client?.close();
    if (io && http) await closeServer(http, io);
  });

  it("captures a CONNECT event with handshake fields", async () => {
    captureSocketIO(io, sink);
    io.on("connection", () => {
      /* user handler is still called */
    });

    client = ioClient(url, { transports: ["websocket"] });
    await waitForEvent(sink, (ev) => ev.socket?.op === SocketOp.SOCKET_OP_CONNECT);

    const ev = sink.events.find(
      (e) => e.socket?.op === SocketOp.SOCKET_OP_CONNECT,
    )!;
    expect(ev.adapter).toBe("socket.io");
    expect(ev.socket?.socketId).toBeTruthy();
    expect(ev.socket?.namespace).toBe("/");
    expect(ev.socket?.handshake).toHaveProperty("url");
  });

  it("captures RECV_FROM_CLIENT + EMIT_TO_CLIENT in a round trip", async () => {
    captureSocketIO(io, sink);
    io.on("connection", (socket) => {
      socket.on("hello", (msg: string) => {
        socket.emit("hello:reply", { echo: msg, length: msg.length });
      });
    });

    client = ioClient(url, { transports: ["websocket"] });
    await new Promise<void>((resolve) => client.on("connect", () => resolve()));
    client.emit("hello", "world");

    const recv = await waitForEvent(
      sink,
      (e) => e.socket?.op === SocketOp.SOCKET_OP_RECV_FROM_CLIENT && e.socket.eventName === "hello",
    );
    expect(recv.socket?.eventName).toBe("hello");
    const recvPayload = JSON.parse(Buffer.from(recv.socket!.data!.inline!).toString("utf-8"));
    expect(recvPayload).toEqual(["world"]);

    const emit = await waitForEvent(
      sink,
      (e) => e.socket?.op === SocketOp.SOCKET_OP_EMIT_TO_CLIENT && e.socket.eventName === "hello:reply",
    );
    const emitPayload = JSON.parse(Buffer.from(emit.socket!.data!.inline!).toString("utf-8"));
    expect(emitPayload).toEqual([{ echo: "world", length: 5 }]);
  });

  it("captures DISCONNECT with the reason in eventName", async () => {
    captureSocketIO(io, sink);
    io.on("connection", () => { /* noop */ });

    client = ioClient(url, { transports: ["websocket"] });
    await new Promise<void>((resolve) => client.on("connect", () => resolve()));
    client.disconnect();

    const disc = await waitForEvent(sink, (e) => e.socket?.op === SocketOp.SOCKET_OP_DISCONNECT);
    expect(disc.socket?.eventName).toBeTruthy();
  });

  it("truncates payloads over maxPayloadInlineBytes and flags redaction", async () => {
    captureSocketIO(io, sink, { maxPayloadInlineBytes: 16 });
    io.on("connection", (socket) => {
      socket.on("big", () => {
        /* drop */
      });
    });

    client = ioClient(url, { transports: ["websocket"] });
    await new Promise<void>((resolve) => client.on("connect", () => resolve()));
    client.emit("big", "x".repeat(1000));

    const recv = await waitForEvent(
      sink,
      (e) => e.socket?.op === SocketOp.SOCKET_OP_RECV_FROM_CLIENT && e.socket.eventName === "big",
    );
    expect(recv.socket?.data?.inline?.length).toBe(16);
    expect(recv.socket?.data?.sizeBytes).toBeGreaterThan(16n);
    expect(recv.redactionsApplied).toContain("body:truncated");
  });

  it("runs userExtractor on every event", async () => {
    captureSocketIO(io, sink, {
      userExtractor: (socket) => (socket.handshake.auth as { uid?: string } | undefined)?.uid,
    });
    io.on("connection", (socket) => {
      socket.on("ping", () => socket.emit("pong", "ok"));
    });

    client = ioClient(url, {
      transports: ["websocket"],
      auth: { uid: "u-socket-42" },
    });
    await new Promise<void>((resolve) => client.on("connect", () => resolve()));
    client.emit("ping");
    await waitForEvent(sink, (e) => e.socket?.op === SocketOp.SOCKET_OP_EMIT_TO_CLIENT);

    for (const ev of sink.events) {
      expect(ev.socket?.userId).toBe("u-socket-42");
    }
  });

  it("covers namespaces created after captureSocketIO is called", async () => {
    captureSocketIO(io, sink);

    const chat = io.of("/chat");
    chat.on("connection", (socket) => {
      socket.on("say", (msg: string) => socket.emit("echo", msg));
    });

    client = ioClient(`${url}/chat`, { transports: ["websocket"] });
    await new Promise<void>((resolve) => client.on("connect", () => resolve()));
    client.emit("say", "hi");

    const recv = await waitForEvent(
      sink,
      (e) => e.socket?.op === SocketOp.SOCKET_OP_RECV_FROM_CLIENT && e.socket.namespace === "/chat",
    );
    expect(recv.socket?.namespace).toBe("/chat");
  });
});
