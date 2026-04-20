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
 */

import type { Context, Middleware, Next } from "koa";

import { currentEventId, extractReplayId, newEventId, runWithEvent } from "../../core/event-context.js";
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

const ADAPTER_NAME = "http.koa";

export interface EventSink {
  sendBatch(events: PbEvent[]): Promise<void>;
  uploadBlob?(data: Buffer, opts?: { contentType?: string }): Promise<BlobRef>;
  track?<T>(p: Promise<T>): Promise<T>;
}

export interface CaptureKoaOptions {
  sampleRate?: number;
  maxBodyInlineBytes?: number;
  maxBodyBlobBytes?: number;
  redactHeaders?: HeaderMatcher[];
  userExtractor?: (ctx: Context) => string | undefined;
  onError?: (err: unknown) => void;
}

export function captureKoa(client: EventSink, opts: CaptureKoaOptions = {}): Middleware {
  const sampleRate = opts.sampleRate ?? 1.0;
  const maxInline = opts.maxBodyInlineBytes ?? 64 * 1024;
  const maxBlob = opts.maxBodyBlobBytes ?? 10 * 1024 * 1024;
  const headerDeny = opts.redactHeaders ?? DEFAULT_HEADER_DENY;
  const userExtractor = opts.userExtractor;
  const onError = opts.onError ?? defaultOnError;

  const uploader: BlobUploader | undefined = client.uploadBlob
    ? { uploadBlob: client.uploadBlob.bind(client) }
    : undefined;
  const bufferCap = uploader ? maxBlob : maxInline;

  return async function clearvoianceKoaMiddleware(ctx: Context, next: Next): Promise<void> {
    if (sampleRate < 1.0 && Math.random() >= sampleRate) {
      await next();
      return;
    }

    const eventId = newEventId();
    const replayId = extractReplayId(ctx.req.headers);
    const startHr = process.hrtime.bigint();
    const startWallNs = BigInt(Date.now()) * 1_000_000n;

    const reqBuf = new CappedBuffer(bufferCap);
    const onReqData = (chunk: Buffer | string): void => {
      reqBuf.push(toBuffer(chunk));
    };
    ctx.req.on("data", onReqData);
    ctx.req.on("end", () => ctx.req.removeListener("data", onReqData));
    ctx.req.on("error", () => ctx.req.removeListener("data", onReqData));

    const resBuf = new CappedBuffer(bufferCap);
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
      const task = (async (): Promise<void> => {
        try {
          const reqFinal = await finalizeBody(reqBuf, {
            maxBodyInlineBytes: maxInline,
            contentType: headerString(ctx.request.header["content-type"]),
            uploader,
            onBlobUploadError: onError,
          });
          const resFinal = await finalizeBody(resBuf, {
            maxBodyInlineBytes: maxInline,
            contentType: headerString(ctx.response.header["content-type"]),
            uploader,
            onBlobUploadError: onError,
          });

          const event = buildEvent({
            eventId,
            startWallNs,
            durationNs: process.hrtime.bigint() - startHr,
            ctx,
            reqBody: reqFinal,
            resBody: resFinal,
            headerDeny,
            userExtractor,
          });

          await client.sendBatch([event]);
        } catch (err) {
          onError(err);
        }
      })();
      if (client.track) void client.track(task);
    });

    await runWithEvent({ eventId, replayId }, () => next());
  };
}

// --- helpers ---------------------------------------------------------------

interface BuildArgs {
  eventId: string;
  startWallNs: bigint;
  durationNs: bigint;
  ctx: Context;
  reqBody: FinalizeResult;
  resBody: FinalizeResult;
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

function toBuffer(chunk: Buffer | string): Buffer {
  return Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
}

function headerString(v: unknown): string | undefined {
  if (typeof v === "string") return v;
  if (Array.isArray(v) && typeof v[0] === "string") return v[0];
  return undefined;
}

function defaultOnError(err: unknown): void {
  // eslint-disable-next-line no-console
  console.warn("[clearvoiance] capture failed:", err);
}

export { currentEventId };
