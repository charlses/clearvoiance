/**
 * Fastify HTTP capture adapter. Registers onRequest + onSend hooks on the
 * instance to capture request/response metadata; preparses the raw body via
 * a `preParsing` hook so the stream reaches the tap before any Fastify
 * body parser consumes it.
 *
 * ```ts
 * import Fastify from "fastify";
 * import { createClient } from "@clearvoiance/node";
 * import { registerCapture } from "@clearvoiance/node/http/fastify";
 *
 * const app = Fastify();
 * const client = createClient({ engine: {...}, session: {...} });
 * await client.start();
 * await registerCapture(app, client);
 * ```
 *
 * Mount this BEFORE any route-level preHandlers that consume the body, and
 * ideally before any other plugins that tap Fastify lifecycle hooks.
 */

import { currentEventId, newEventId, runWithEvent } from "../../core/event-context.js";
import {
  CappedBuffer,
  finalizeBody,
  type BlobUploader,
  type FinalizeResult,
} from "../../core/http-body.js";
import { DEFAULT_HEADER_DENY, type HeaderMatcher, redactHeaders } from "../../core/redaction.js";
import type {
  BlobRef,
  Event as PbEvent,
  HttpEvent as PbHttpEvent,
} from "../../generated/clearvoiance/v1/event.js";
import { SDK_VERSION } from "../../version.js";

const ADAPTER_NAME = "http.fastify";

// Narrow subset of Fastify's public shape so we don't take a hard import on
// the fastify package (keeps it a peer dep).
interface FastifyLike {
  addHook(name: "onRequest", handler: (req: FastifyRequestLike, reply: unknown, done: () => void) => void): unknown;
  addHook(name: "preParsing", handler: (req: FastifyRequestLike, reply: unknown, payload: unknown, done: (err?: unknown, payload?: unknown) => void) => void): unknown;
  addHook(name: "onSend", handler: (req: FastifyRequestLike, reply: FastifyReplyLike, payload: unknown, done: (err?: unknown, payload?: unknown) => void) => void): unknown;
  addHook(name: "onResponse", handler: (req: FastifyRequestLike, reply: FastifyReplyLike, done: () => void) => void): unknown;
}

interface FastifyRequestLike {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  ip?: string;
  routerPath?: string;
  routeOptions?: { url?: string };
}

interface FastifyReplyLike {
  statusCode: number;
  getHeaders(): Record<string, string | string[] | number | undefined>;
}

export interface EventSink {
  sendBatch(events: PbEvent[]): Promise<void>;
  uploadBlob?(data: Buffer, opts?: { contentType?: string }): Promise<BlobRef>;
  track?<T>(p: Promise<T>): Promise<T>;
}

export interface CaptureFastifyOptions {
  sampleRate?: number;
  maxBodyInlineBytes?: number;
  maxBodyBlobBytes?: number;
  redactHeaders?: HeaderMatcher[];
  userExtractor?: (req: FastifyRequestLike) => string | undefined;
  onError?: (err: unknown) => void;
}

// Per-request state tracked outside Fastify's decorators so we don't need
// to ask users to register them. Keyed by the request object identity.
interface RequestState {
  eventId: string;
  startHr: bigint;
  startWallNs: bigint;
  reqBuf: CappedBuffer;
  resBuf: CappedBuffer;
  reqContentType?: string;
}

/**
 * Registers capture hooks on a Fastify instance. Call BEFORE `app.listen()`.
 * Returns a promise that resolves once the hooks are registered.
 */
export function registerCapture(
  fastify: FastifyLike,
  client: EventSink,
  opts: CaptureFastifyOptions = {},
): void {
  const sampleRate = opts.sampleRate ?? 1.0;
  const maxInline = opts.maxBodyInlineBytes ?? 64 * 1024;
  const maxBlob = opts.maxBodyBlobBytes ?? 10 * 1024 * 1024;
  const headerDeny = opts.redactHeaders ?? DEFAULT_HEADER_DENY;
  const onError = opts.onError ?? defaultOnError;

  const uploader: BlobUploader | undefined = client.uploadBlob
    ? { uploadBlob: client.uploadBlob.bind(client) }
    : undefined;
  const bufferCap = uploader ? maxBlob : maxInline;

  const state = new WeakMap<FastifyRequestLike, RequestState>();

  fastify.addHook("onRequest", (req, _reply, done) => {
    if (sampleRate < 1.0 && Math.random() >= sampleRate) {
      done();
      return;
    }
    state.set(req, {
      eventId: newEventId(),
      startHr: process.hrtime.bigint(),
      startWallNs: BigInt(Date.now()) * 1_000_000n,
      reqBuf: new CappedBuffer(bufferCap),
      resBuf: new CappedBuffer(bufferCap),
      reqContentType: stringHeader(req.headers["content-type"]),
    });
    // Seed the AsyncLocalStorage so outbound + db adapters see the event id.
    // Fastify's hook runs inside its own async context; runWithEvent(..., fn)
    // propagates the ctx for the rest of the request's async chain via
    // the done() callback.
    runWithEvent({ eventId: state.get(req)!.eventId }, () => done());
  });

  fastify.addHook("preParsing", (req, _reply, payload, done) => {
    const s = state.get(req);
    if (!s) {
      done(null, payload);
      return;
    }
    const stream = payload as NodeJS.ReadableStream | null;
    if (!stream || typeof stream.on !== "function") {
      done(null, payload);
      return;
    }
    stream.on("data", (chunk: Buffer | string) => s.reqBuf.push(toBuffer(chunk)));
    done(null, payload);
  });

  fastify.addHook("onSend", (req, _reply, payload, done) => {
    const s = state.get(req);
    if (!s) {
      done(null, payload);
      return;
    }
    if (payload != null) {
      // payload may be a string, Buffer, or a stream. Buffer/string are
      // observable synchronously; stream would need a tee which is more
      // invasive — skip and fall back to size from response headers.
      if (Buffer.isBuffer(payload) || typeof payload === "string") {
        s.resBuf.push(toBuffer(payload as Buffer | string));
      }
    }
    done(null, payload);
  });

  fastify.addHook("onResponse", (req, reply, done) => {
    const s = state.get(req);
    if (!s) {
      done();
      return;
    }
    state.delete(req);

    const task = (async (): Promise<void> => {
      try {
        const reqFinal = await finalizeBody(s.reqBuf, {
          maxBodyInlineBytes: maxInline,
          contentType: s.reqContentType,
          uploader,
          onBlobUploadError: onError,
        });
        const resFinal = await finalizeBody(s.resBuf, {
          maxBodyInlineBytes: maxInline,
          contentType: stringHeader(reply.getHeaders()["content-type"]),
          uploader,
          onBlobUploadError: onError,
        });

        const event = buildEvent({
          eventId: s.eventId,
          startWallNs: s.startWallNs,
          durationNs: process.hrtime.bigint() - s.startHr,
          req,
          reply,
          reqBody: reqFinal,
          resBody: resFinal,
          headerDeny,
          userExtractor: opts.userExtractor,
        });
        await client.sendBatch([event]);
      } catch (err) {
        onError(err);
      }
    })();
    if (client.track) void client.track(task);

    done();
  });
}

interface BuildArgs {
  eventId: string;
  startWallNs: bigint;
  durationNs: bigint;
  req: FastifyRequestLike;
  reply: FastifyReplyLike;
  reqBody: FinalizeResult;
  resBody: FinalizeResult;
  headerDeny: HeaderMatcher[];
  userExtractor?: (req: FastifyRequestLike) => string | undefined;
}

function buildEvent(a: BuildArgs): PbEvent {
  const reqHdr = redactHeaders(a.req.headers, { headers: a.headerDeny });
  const resHdr = redactHeaders(a.reply.getHeaders(), { headers: a.headerDeny });

  const routeTemplate = a.req.routeOptions?.url ?? a.req.routerPath ?? "";

  const http: PbHttpEvent = {
    method: a.req.method,
    path: a.req.url,
    httpVersion: "HTTP/1.1",
    headers: reqHdr.headers,
    requestBody: a.reqBody.body,
    status: a.reply.statusCode,
    responseHeaders: resHdr.headers,
    responseBody: a.resBody.body,
    durationNs: a.durationNs,
    sourceIp: a.req.ip ?? "",
    userId: a.userExtractor?.(a.req) ?? "",
    routeTemplate,
  };

  return {
    id: a.eventId,
    sessionId: "",
    timestampNs: a.startWallNs,
    offsetNs: 0n,
    adapter: ADAPTER_NAME,
    sdkVersion: `@clearvoiance/node@${SDK_VERSION}`,
    metadata: {},
    redactionsApplied: [
      ...reqHdr.applied,
      ...resHdr.applied,
      ...a.reqBody.redactions,
      ...a.resBody.redactions,
    ],
    http,
  };
}

function toBuffer(chunk: Buffer | string): Buffer {
  return Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
}

function stringHeader(v: unknown): string | undefined {
  if (typeof v === "string") return v;
  if (Array.isArray(v) && typeof v[0] === "string") return v[0];
  if (typeof v === "number") return String(v);
  return undefined;
}

function defaultOnError(err: unknown): void {
  // eslint-disable-next-line no-console
  console.warn("[clearvoiance] fastify capture failed:", err);
}

export { currentEventId };
