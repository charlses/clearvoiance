/**
 * Express HTTP capture adapter.
 *
 * Mount as early middleware (before `body-parser`/`express.json()`) so raw
 * bodies reach the tap before parsers consume the stream. The adapter buffers
 * bodies to either the inline cap (when no blob backend is wired up) or the
 * blob cap (when the client supports uploadBlob); at response-finish time the
 * body is finalized as inline bytes or uploaded to blob storage.
 *
 * ```ts
 * import express from "express";
 * import { createClient } from "@clearvoiance/node";
 * import { captureHttp } from "@clearvoiance/node/http/express";
 *
 * const client = createClient({ engine: {...}, session: {...} });
 * await client.start();
 *
 * const app = express();
 * app.use(captureHttp(client));
 * ```
 */

import type { NextFunction, Request, Response } from "express";

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

const ADAPTER_NAME = "http.express";

/**
 * Minimal shape this adapter needs from a client. `uploadBlob` is optional —
 * without it, large bodies get truncated to the inline cap.
 */
export interface EventSink {
  sendBatch(events: PbEvent[]): Promise<void>;
  uploadBlob?(data: Buffer, opts?: { contentType?: string }): Promise<BlobRef>;
  /**
   * Register a pending async op so `Client.stop()` drains it before closing.
   * If the sink is a test recorder without this method, the adapter
   * fire-and-forgets the IIFE (same as before, acceptable for tests).
   */
  track?<T>(p: Promise<T>): Promise<T>;
}

export interface CaptureHttpOptions {
  /** Sample rate (0–1). 1.0 = everything. */
  sampleRate?: number;

  /**
   * Bodies at or below this size are inlined in the event. Default 64 KB.
   * The Phase-4 DB observer and the UI both expect inline bodies to be small
   * enough to load into a detail pane without pagination, so the default is
   * conservative.
   */
  maxBodyInlineBytes?: number;

  /**
   * Bodies above the inline cap are buffered up to this size, then uploaded
   * to blob storage (if the client has `uploadBlob`). Past this ceiling the
   * body is truncated. Default 10 MB.
   */
  maxBodyBlobBytes?: number;

  /** Header denylist (strings compare case-insensitively, regexes match lowercased). */
  redactHeaders?: HeaderMatcher[];

  /** Extracts a user id from the request. */
  userExtractor?: (req: Request) => string | undefined;

  /**
   * Called with capture errors so they don't crash the app. Defaults to
   * console.warn.
   */
  onError?: (err: unknown) => void;
}

export function captureHttp(
  client: EventSink,
  opts: CaptureHttpOptions = {},
): (req: Request, res: Response, next: NextFunction) => void {
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

  return function clearvoianceHttpMiddleware(
    req: Request,
    res: Response,
    next: NextFunction,
  ): void {
    if (sampleRate < 1.0 && Math.random() >= sampleRate) {
      next();
      return;
    }

    const eventId = newEventId();
    const startHr = process.hrtime.bigint();
    const startWallNs = BigInt(Date.now()) * 1_000_000n;

    // --- Request body tap (observer; doesn't consume the stream). ---
    const reqBuf = new CappedBuffer(bufferCap);
    const onReqData = (chunk: Buffer | string): void => {
      reqBuf.push(toBuffer(chunk));
    };
    req.on("data", onReqData);
    req.on("end", () => req.removeListener("data", onReqData));
    req.on("error", () => req.removeListener("data", onReqData));

    // --- Response body tap. ---
    const resBuf = new CappedBuffer(bufferCap);
    const origWrite = res.write.bind(res);
    const origEnd = res.end.bind(res);

    res.write = function tappedWrite(chunk: unknown, ...args: unknown[]): boolean {
      if (chunk != null) resBuf.push(toBuffer(chunk as Buffer | string));
      return (origWrite as (...a: unknown[]) => boolean)(chunk, ...args);
    } as Response["write"];

    res.end = function tappedEnd(chunk?: unknown, ...args: unknown[]): Response {
      if (chunk != null) resBuf.push(toBuffer(chunk as Buffer | string));
      return (origEnd as (...a: unknown[]) => Response)(chunk, ...args);
    } as Response["end"];

    res.on("finish", () => {
      // Async IIFE: blob upload (if any) must complete before we build + send
      // the event. Registered with the client so stop()'s drain waits for it.
      const task = (async (): Promise<void> => {
        try {
          const reqFinal = await finalizeBody(reqBuf, {
            maxBodyInlineBytes: maxInline,
            contentType: headerString(req.headers["content-type"]),
            uploader,
            onBlobUploadError: onError,
          });
          const resFinal = await finalizeBody(resBuf, {
            maxBodyInlineBytes: maxInline,
            contentType: stringHeader(res.getHeader("content-type")),
            uploader,
            onBlobUploadError: onError,
          });

          const event = buildEvent({
            eventId,
            startWallNs,
            durationNs: process.hrtime.bigint() - startHr,
            req,
            res,
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

    runWithEvent({ eventId }, () => next());
  };
}

// --- helpers ---------------------------------------------------------------

interface BuildArgs {
  eventId: string;
  startWallNs: bigint;
  durationNs: bigint;
  req: Request;
  res: Response;
  reqBody: FinalizeResult;
  resBody: FinalizeResult;
  headerDeny: HeaderMatcher[];
  userExtractor?: (req: Request) => string | undefined;
}

function buildEvent(a: BuildArgs): PbEvent {
  const reqHeaders = redactHeaders(a.req.headers, { headers: a.headerDeny });
  const resHeaders = redactHeaders(a.res.getHeaders(), { headers: a.headerDeny });

  const routeTemplate =
    (a.req as Request & { route?: { path?: string } }).route?.path ?? "";

  const http: PbHttpEvent = {
    method: a.req.method,
    path: a.req.originalUrl || a.req.url,
    httpVersion: `HTTP/${a.req.httpVersion}`,
    headers: reqHeaders.headers,
    requestBody: a.reqBody.body,
    status: a.res.statusCode,
    responseHeaders: resHeaders.headers,
    responseBody: a.resBody.body,
    durationNs: a.durationNs,
    sourceIp: a.req.ip ?? a.req.socket?.remoteAddress ?? "",
    userId: a.userExtractor?.(a.req) ?? "",
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

function stringHeader(v: unknown): string | undefined {
  if (typeof v === "string") return v;
  if (Array.isArray(v) && typeof v[0] === "string") return v[0];
  return undefined;
}

function headerString(v: string | string[] | undefined): string | undefined {
  if (typeof v === "string") return v;
  if (Array.isArray(v) && typeof v[0] === "string") return v[0];
  return undefined;
}

function defaultOnError(err: unknown): void {
  // eslint-disable-next-line no-console
  console.warn("[clearvoiance] capture failed:", err);
}

export { currentEventId };
