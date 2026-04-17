/**
 * Koa HTTP capture adapter.
 *
 * Mount as early middleware (before `koa-bodyparser` or Strapi's body parser)
 * so the raw request body reaches the tap before parsers consume the stream.
 *
 * ```ts
 * import Koa from "koa";
 * import { createClient } from "@clearvoiance/node";
 * import { captureKoa } from "@clearvoiance/node/http/koa";
 *
 * const client = createClient({ engine: {...}, session: {...} });
 * await client.start();
 *
 * const app = new Koa();
 * app.use(captureKoa(client));
 * ```
 *
 * Strapi users: see `@clearvoiance/node/http/strapi` for a wrapper that
 * matches Strapi's middleware factory convention.
 */

import type { Context, Middleware, Next } from "koa";

import { currentEventId, newEventId, runWithEvent } from "../../core/event-context.js";
import { DEFAULT_HEADER_DENY, type HeaderMatcher, redactHeaders } from "../../core/redaction.js";
import type {
  Body as PbBody,
  Event as PbEvent,
  HttpEvent as PbHttpEvent,
} from "../../generated/clearvoiance/v1/event.js";
import { SDK_VERSION } from "../../version.js";

const ADAPTER_NAME = "http.koa";

/**
 * Minimal shape captureKoa needs from a client. Matches `Client.sendBatch` but
 * keeps the middleware decoupled so tests can pass a recorder.
 */
export interface EventSink {
  sendBatch(events: PbEvent[]): Promise<void>;
}

export interface CaptureKoaOptions {
  sampleRate?: number;
  maxBodyInlineBytes?: number;
  redactHeaders?: HeaderMatcher[];
  userExtractor?: (ctx: Context) => string | undefined;
  onError?: (err: unknown) => void;
}

export function captureKoa(client: EventSink, opts: CaptureKoaOptions = {}): Middleware {
  const sampleRate = opts.sampleRate ?? 1.0;
  const maxInline = opts.maxBodyInlineBytes ?? 64 * 1024;
  const headerDeny = opts.redactHeaders ?? DEFAULT_HEADER_DENY;
  const userExtractor = opts.userExtractor;
  const onError = opts.onError ?? defaultOnError;

  return async function clearvoianceKoaMiddleware(ctx: Context, next: Next): Promise<void> {
    if (sampleRate < 1.0 && Math.random() >= sampleRate) {
      await next();
      return;
    }

    const eventId = newEventId();
    const startHr = process.hrtime.bigint();
    const startWallNs = BigInt(Date.now()) * 1_000_000n;

    // --- Request body tap (observer — does not consume the stream). ---
    const reqBuf = new CappedBuffer(maxInline);
    const onReqData = (chunk: Buffer | string): void => {
      reqBuf.push(toBuffer(chunk));
    };
    ctx.req.on("data", onReqData);
    ctx.req.on("end", () => ctx.req.removeListener("data", onReqData));
    ctx.req.on("error", () => ctx.req.removeListener("data", onReqData));

    // --- Response body tap via ctx.res.write/end wrap. ---
    // ctx.body may be a string, Buffer, stream, or object; Koa internally
    // serialises it through ctx.res.write/end so patching those catches
    // every byte that actually goes on the wire.
    const resBuf = new CappedBuffer(maxInline);
    const res = ctx.res;
    const origWrite = res.write.bind(res);
    const origEnd = res.end.bind(res);

    res.write = function tappedWrite(chunk: unknown, ...args: unknown[]): boolean {
      if (chunk != null) resBuf.push(toBuffer(chunk as Buffer | string));
      return (origWrite as (...a: unknown[]) => boolean)(chunk, ...args);
    } as typeof res.write;

    res.end = function tappedEnd(chunk?: unknown, ...args: unknown[]): typeof res {
      if (chunk != null) resBuf.push(toBuffer(chunk as Buffer | string));
      return (origEnd as (...a: unknown[]) => typeof res)(chunk, ...args);
    } as typeof res.end;

    res.on("finish", () => {
      try {
        const event = buildEvent({
          eventId,
          startWallNs,
          durationNs: process.hrtime.bigint() - startHr,
          ctx,
          reqBody: reqBuf.result(headerString(ctx.request.header["content-type"])),
          resBody: resBuf.result(headerString(ctx.response.header["content-type"])),
          headerDeny,
          userExtractor,
        });
        client.sendBatch([event]).catch(onError);
      } catch (err) {
        onError(err);
      }
    });

    await runWithEvent({ eventId }, () => next());
  };
}

// --- helpers ---------------------------------------------------------------

interface BuildArgs {
  eventId: string;
  startWallNs: bigint;
  durationNs: bigint;
  ctx: Context;
  reqBody: { body: PbBody | undefined; redactions: string[] };
  resBody: { body: PbBody | undefined; redactions: string[] };
  headerDeny: HeaderMatcher[];
  userExtractor?: (ctx: Context) => string | undefined;
}

function buildEvent(a: BuildArgs): PbEvent {
  const reqHeaders = redactHeaders(
    a.ctx.request.header as Record<string, string | string[] | undefined>,
    { headers: a.headerDeny },
  );
  const resHeaders = redactHeaders(
    a.ctx.response.header as Record<string, string | string[] | undefined>,
    { headers: a.headerDeny },
  );

  // Koa's routing is handled by user middleware (koa-router/@koa/router), which
  // exposes the matched pattern via ctx._matchedRoute. Fall back to empty when
  // no router is mounted.
  const routeTemplate =
    (a.ctx as Context & { _matchedRoute?: string | RegExp })._matchedRoute?.toString() ?? "";

  const http: PbHttpEvent = {
    method: a.ctx.method,
    path: a.ctx.originalUrl || a.ctx.url,
    httpVersion: `HTTP/${a.ctx.req.httpVersion}`,
    headers: reqHeaders.headers,
    requestBody: a.reqBody.body,
    status: a.ctx.status,
    responseHeaders: resHeaders.headers,
    responseBody: a.resBody.body,
    durationNs: a.durationNs,
    sourceIp: a.ctx.ip ?? a.ctx.req.socket?.remoteAddress ?? "",
    userId: a.userExtractor?.(a.ctx) ?? "",
    routeTemplate,
  };

  const redactions = [
    ...reqHeaders.applied,
    ...resHeaders.applied,
    ...a.reqBody.redactions,
    ...a.resBody.redactions,
  ];

  return {
    id: a.eventId,
    sessionId: "",
    timestampNs: a.startWallNs,
    offsetNs: 0n,
    adapter: ADAPTER_NAME,
    sdkVersion: `@clearvoiance/node@${SDK_VERSION}`,
    metadata: {},
    redactionsApplied: redactions,
    http,
  };
}

class CappedBuffer {
  private readonly cap: number;
  private readonly chunks: Buffer[] = [];
  private size = 0;
  private _truncated = false;

  constructor(cap: number) {
    this.cap = cap;
  }

  push(buf: Buffer): void {
    if (this._truncated || buf.length === 0) return;
    if (this.size + buf.length <= this.cap) {
      this.chunks.push(buf);
      this.size += buf.length;
      return;
    }
    const take = this.cap - this.size;
    if (take > 0) this.chunks.push(buf.subarray(0, take));
    this.size = this.cap;
    this._truncated = true;
  }

  result(contentType: string | undefined): { body: PbBody | undefined; redactions: string[] } {
    if (this.size === 0) {
      return { body: undefined, redactions: [] };
    }
    const inline = Buffer.concat(this.chunks, this.size);
    const body: PbBody = {
      inline,
      contentType: contentType ?? "",
      sizeBytes: BigInt(this.size),
      encoding: inferEncoding(contentType),
    };
    return { body, redactions: this._truncated ? ["body:truncated"] : [] };
  }
}

function toBuffer(chunk: Buffer | string): Buffer {
  return Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
}

function headerString(v: unknown): string | undefined {
  if (typeof v === "string") return v;
  if (Array.isArray(v) && typeof v[0] === "string") return v[0];
  return undefined;
}

function inferEncoding(contentType: string | undefined): string {
  if (!contentType) return "binary";
  if (
    /charset=utf-8/i.test(contentType) ||
    /^(text\/|application\/(json|xml|javascript))/i.test(contentType)
  ) {
    return "utf-8";
  }
  return "binary";
}

function defaultOnError(err: unknown): void {
  // eslint-disable-next-line no-console
  console.warn("[clearvoiance] capture failed:", err);
}

export { currentEventId };
