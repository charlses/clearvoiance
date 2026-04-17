/**
 * Socket.io HTTP capture adapter.
 *
 * Wraps an existing Socket.io Server so every connection, incoming event,
 * outgoing emit, and disconnect becomes a captured Event. Uses the stable
 * Socket.io v4 `onAny` / `onAnyOutgoing` hooks — no monkey-patching of
 * internal methods.
 *
 * ```ts
 * import { Server } from "socket.io";
 * import { createClient } from "@clearvoiance/node";
 * import { captureSocketIO } from "@clearvoiance/node/socket/socketio";
 *
 * const client = createClient({ engine: {...}, session: {...} });
 * await client.start();
 *
 * const io = new Server(httpServer);
 * captureSocketIO(io, client);
 * ```
 */

import type { Namespace, Server, Socket } from "socket.io";

import { currentEventId, newEventId, runWithEvent } from "../../core/event-context.js";
import type {
  BlobRef,
  Event as PbEvent,
  SocketEvent as PbSocketEvent,
  SocketEvent_SocketOp,
} from "../../generated/clearvoiance/v1/event.js";
import { SocketEvent_SocketOp as SocketOp } from "../../generated/clearvoiance/v1/event.js";
import { SDK_VERSION } from "../../version.js";

const ADAPTER_NAME = "socket.io";

/**
 * Minimal client contract for this adapter. Mirrors the HTTP adapters so
 * `track()` can drain sends before the app exits.
 */
export interface EventSink {
  sendBatch(events: PbEvent[]): Promise<void>;
  uploadBlob?(data: Buffer, opts?: { contentType?: string }): Promise<BlobRef>;
  track?<T>(p: Promise<T>): Promise<T>;
}

export interface CaptureSocketIOOptions {
  /**
   * Sample rate (0–1) applied per socket connection. Once a connection is
   * sampled in, every event from it is captured.
   */
  sampleRate?: number;

  /**
   * Cap on any single event's payload. Args larger than this are truncated
   * and the event is flagged with `body:truncated`. Default 64 KB.
   */
  maxPayloadInlineBytes?: number;

  /**
   * Extracts a user id from the socket (commonly from `socket.handshake.auth`
   * or `socket.data`). Applied on each event so it survives disconnects.
   */
  userExtractor?: (socket: Socket) => string | undefined;

  /**
   * Called on capture errors so a broken engine connection doesn't break the
   * user's app. Defaults to console.warn.
   */
  onError?: (err: unknown) => void;
}

/**
 * Installs capture hooks on every namespace of `io`, including any registered
 * later via `io.of(...)`. Existing namespaces that already have listeners are
 * fine — our `connection` handler is registered at the end of the chain.
 */
export function captureSocketIO(
  io: Server,
  client: EventSink,
  opts: CaptureSocketIOOptions = {},
): void {
  const sampleRate = opts.sampleRate ?? 1.0;
  const maxPayload = opts.maxPayloadInlineBytes ?? 64 * 1024;
  const userExtractor = opts.userExtractor;
  const onError = opts.onError ?? defaultOnError;

  // Track which namespaces we've already wired so we don't double-hook.
  const wired = new WeakSet<Namespace>();

  const wire = (nsp: Namespace): void => {
    if (wired.has(nsp)) return;
    wired.add(nsp);

    nsp.on("connection", (socket: Socket) => {
      if (sampleRate < 1.0 && Math.random() >= sampleRate) return;
      installSocketHooks(socket, nsp, client, {
        maxPayload,
        userExtractor,
        onError,
      });
    });
  };

  // Wire existing namespaces and intercept future `io.of(...)` calls.
  // Socket.io exposes `_nsps` (a Map) for the currently-registered namespaces
  // in v4; we iterate it via the public `Namespace` instances returned from
  // `io.of('/')` etc.
  wire(io.of("/"));

  const origOf = io.of.bind(io);
  (io as unknown as { of: typeof io.of }).of = ((name: string | RegExp | ((...a: unknown[]) => unknown), ...rest: unknown[]) => {
    const nsp = (origOf as (...a: unknown[]) => Namespace)(name, ...rest);
    wire(nsp);
    return nsp;
  }) as typeof io.of;
}

// --- helpers ---------------------------------------------------------------

interface HookOptions {
  maxPayload: number;
  userExtractor?: (socket: Socket) => string | undefined;
  onError: (err: unknown) => void;
}

function installSocketHooks(
  socket: Socket,
  nsp: Namespace,
  client: EventSink,
  opts: HookOptions,
): void {
  emitSocketEvent(client, nsp, socket, opts, {
    op: SocketOp.SOCKET_OP_CONNECT,
    handshake: handshakeToMap(socket),
  });

  socket.onAny((eventName: string, ...args: unknown[]) => {
    emitSocketEvent(client, nsp, socket, opts, {
      op: SocketOp.SOCKET_OP_RECV_FROM_CLIENT,
      eventName,
      args,
    });
  });

  socket.onAnyOutgoing((eventName: string, ...args: unknown[]) => {
    emitSocketEvent(client, nsp, socket, opts, {
      op: SocketOp.SOCKET_OP_EMIT_TO_CLIENT,
      eventName,
      args,
    });
  });

  socket.on("disconnect", (reason: string) => {
    emitSocketEvent(client, nsp, socket, opts, {
      op: SocketOp.SOCKET_OP_DISCONNECT,
      eventName: reason,
    });
  });
}

interface EmitArgs {
  op: SocketEvent_SocketOp;
  eventName?: string;
  args?: unknown[];
  handshake?: Record<string, string>;
}

function emitSocketEvent(
  client: EventSink,
  nsp: Namespace,
  socket: Socket,
  opts: HookOptions,
  ev: EmitArgs,
): void {
  try {
    const eventId = newEventId();
    const timestampNs = BigInt(Date.now()) * 1_000_000n;

    const payloadBytes = ev.args !== undefined ? serializeArgs(ev.args) : undefined;
    const redactionsApplied: string[] = [];

    let body: PbSocketEvent["data"] | undefined;
    if (payloadBytes) {
      const truncated = payloadBytes.length > opts.maxPayload;
      const inline = truncated ? payloadBytes.subarray(0, opts.maxPayload) : payloadBytes;
      if (truncated) redactionsApplied.push("body:truncated");
      body = {
        inline,
        contentType: "application/json",
        sizeBytes: BigInt(payloadBytes.length),
        encoding: "utf-8",
      };
    }

    const socketEv: PbSocketEvent = {
      socketId: socket.id,
      op: ev.op,
      namespace: nsp.name,
      eventName: ev.eventName ?? "",
      data: body,
      handshake: ev.handshake ?? {},
      userId: opts.userExtractor?.(socket) ?? "",
      durationNs: 0n,
    };

    const event: PbEvent = {
      id: eventId,
      sessionId: "",
      timestampNs,
      offsetNs: 0n,
      adapter: ADAPTER_NAME,
      sdkVersion: `@clearvoiance/node@${SDK_VERSION}`,
      metadata: {},
      redactionsApplied,
      socket: socketEv,
    };

    const task = runWithEvent({ eventId }, () => client.sendBatch([event])).catch(opts.onError);
    if (client.track) void client.track(task);
  } catch (err) {
    opts.onError(err);
  }
}

function handshakeToMap(socket: Socket): Record<string, string> {
  const hs = socket.handshake;
  const out: Record<string, string> = {
    address: hs.address ?? "",
    time: String(hs.time ?? ""),
    issued: String(hs.issued ?? ""),
    xdomain: String(Boolean(hs.xdomain)),
    secure: String(Boolean(hs.secure)),
    url: hs.url ?? "",
  };
  // Stringify a few flat fields; deeper structures (auth, headers) land in
  // metadata in a later phase when we have a richer handshake schema.
  if (hs.auth && typeof hs.auth === "object") {
    try {
      out.auth = JSON.stringify(hs.auth);
    } catch {
      // ignore unserializable auth
    }
  }
  return out;
}

function serializeArgs(args: unknown[]): Buffer {
  // JSON by default; binary chunks (Buffer / Uint8Array) are stringified with
  // base64 so the wire shape stays JSON. Phase 1g+ can add msgpack support
  // alongside the binary adapter option in Socket.io's parser.
  return Buffer.from(
    JSON.stringify(args, (_key, value) => {
      if (Buffer.isBuffer(value)) {
        return { __type: "Buffer", base64: value.toString("base64") };
      }
      if (value instanceof Uint8Array) {
        return { __type: "Uint8Array", base64: Buffer.from(value).toString("base64") };
      }
      return value;
    }),
  );
}

function defaultOnError(err: unknown): void {
  // eslint-disable-next-line no-console
  console.warn("[clearvoiance] socket.io capture failed:", err);
}

export { currentEventId };
