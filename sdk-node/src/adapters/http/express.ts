/**
 * Express HTTP capture adapter.
 *
 * Mount as early middleware (before `body-parser`/`express.json()`) so raw
 * bodies reach the tap before parsers consume the stream. The adapter is
 * non-blocking: it buffers bodies as bytes stream past and sends the
 * constructed Event after the response finishes.
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
import { SDK_VERSION } from "../../version.js";
import { DEFAULT_HEADER_DENY, type HeaderMatcher, redactHeaders } from "../../core/redaction.js";
import type {
  Body as PbBody,
  Event as PbEvent,
  HttpEvent as PbHttpEvent,
} from "../../generated/clearvoiance/v1/event.js";

const ADAPTER_NAME = "http.express";

/**
 * Minimal shape this adapter needs from a client. Matches {@link Client} but
 * keeps the middleware decoupled so tests can pass a recorder without a real
 * gRPC connection.
 */
export interface EventSink {
  sendBatch(events: PbEvent[]): Promise<void>;
}

export interface CaptureHttpOptions {
  /**
   * Rate to sample at. 1.0 = everything, 0.1 = 10%. Defaults to 1.0; at
   * production scale you'll want to lower this.
   */
  sampleRate?: number;

  /**
   * Inline body cap. Bodies larger than this are truncated for the inline
   * protobuf payload; the full body lands in blob storage in Phase 1e.
   * Defaults to 64KB.
   */
  maxBodyInlineBytes?: number;

  /**
   * Header denylist. Strings compare case-insensitively; regexes match the
   * lowercased header name. Overrides the built-in default — include the
   * defaults explicitly if you want them alongside your additions.
   */
  redactHeaders?: HeaderMatcher[];

  /**
   * Extract the user id from the request. Runs after Express has populated
   * req (so `(req as any).user` is available if your auth middleware is
   * mounted before this one).
   */
  userExtractor?: (req: Request) => string | undefined;

  /**
   * Called with capture errors so they don't crash the app. Defaults to a
   * single console.warn per failure.
   */
  onError?: (err: unknown) => void;
}

export function captureHttp(
  client: EventSink,
  opts: CaptureHttpOptions = {},
): (req: Request, res: Response, next: NextFunction) => void {
  const sampleRate = opts.sampleRate ?? 1.0;
  const maxInline = opts.maxBodyInlineBytes ?? 64 * 1024;
  const headerDeny = opts.redactHeaders ?? DEFAULT_HEADER_DENY;
  const userExtractor = opts.userExtractor;
  const onError = opts.onError ?? defaultOnError;

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

    // --- Request body tap ---
    // Attaching a 'data' listener does NOT consume the stream for downstream
    // parsers — it's just an observer. Body-parser will still see every chunk.
    const reqBuf = new CappedBuffer(maxInline);
    const onReqData = (chunk: Buffer | string): void => {
      reqBuf.push(toBuffer(chunk));
    };
    req.on("data", onReqData);
    req.on("end", () => req.removeListener("data", onReqData));
    req.on("error", () => req.removeListener("data", onReqData));

    // --- Response body tap ---
    const resBuf = new CappedBuffer(maxInline);
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

    // --- Send event on finish ---
    res.on("finish", () => {
      try {
        const event = buildEvent({
          eventId,
          startWallNs,
          durationNs: process.hrtime.bigint() - startHr,
          req,
          res,
          reqBody: reqBuf.result(req.headers["content-type"]),
          resBody: resBuf.result(stringHeader(res.getHeader("content-type"))),
          headerDeny,
          userExtractor,
        });
        // sendBatch is async; swallow rejections so a broken connection to the
        // engine doesn't surface as an unhandled promise rejection.
        client.sendBatch([event]).catch(onError);
      } catch (err) {
        onError(err);
      }
    });

    // Install the event context so downstream middleware / handlers can attach
    // DB application_name or outbound captures to this event id (Phase 4).
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
  reqBody: { body: PbBody | undefined; redactions: string[] };
  resBody: { body: PbBody | undefined; redactions: string[] };
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
    sessionId: "", // Client stamps this when sending.
    timestampNs: a.startWallNs,
    offsetNs: 0n, // Client fills this when sending (offset within session).
    adapter: ADAPTER_NAME,
    sdkVersion: `@clearvoiance/node@${SDK_VERSION}`,
    metadata: {},
    redactionsApplied: redactions,
    http,
  };
}

/** Accumulates up to `cap` bytes; silently drops the rest and flags truncation. */
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

  get truncated(): boolean {
    return this._truncated;
  }

  get totalBytes(): number {
    return this.size;
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
    const redactions = this._truncated ? ["body:truncated"] : [];
    return { body, redactions };
  }
}

function toBuffer(chunk: Buffer | string): Buffer {
  return Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
}

function stringHeader(v: unknown): string | undefined {
  if (typeof v === "string") return v;
  if (Array.isArray(v) && typeof v[0] === "string") return v[0];
  return undefined;
}

function inferEncoding(contentType: string | undefined): string {
  if (!contentType) return "binary";
  if (/charset=utf-8/i.test(contentType) || /^(text\/|application\/(json|xml|javascript))/i.test(contentType)) {
    return "utf-8";
  }
  return "binary";
}

function defaultOnError(err: unknown): void {
  // eslint-disable-next-line no-console
  console.warn("[clearvoiance] capture failed:", err);
}

// Re-export the context helper so handlers can read their own event id if
// they want to correlate logs / traces.
export { currentEventId };
