/**
 * Outbound HTTP capture — monkey-patches `http.request` and `https.request`
 * so every outbound call fired from within a capture scope (`currentEventId`
 * set by an inbound adapter) is recorded as an OutboundEvent.
 *
 * Only outbounds with a live inbound scope are recorded; otherwise the call
 * passes through untouched. This prevents recording the SDK's own gRPC
 * traffic, engine health checks, and other noise that happens outside a
 * request handler.
 *
 * `http.get` / `https.get` are thin wrappers around `.request()` in Node, so
 * patching `.request` covers both. `fetch` bypasses `http.request` — see
 * `outbound/fetch.ts` for that.
 */

import * as http from "node:http";
import * as https from "node:https";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import type { ClientRequest, IncomingMessage, RequestOptions } from "node:http";

// The ESM namespace for node:http is frozen — we can't reassign `http.request`
// on that view. createRequire hands us the real CJS module.exports, which IS
// mutable, and all of Node's internal callers resolve through that object.
const nodeRequire = createRequire(import.meta.url);
const httpModule = nodeRequire("node:http") as typeof http;
const httpsModule = nodeRequire("node:https") as typeof https;

import { currentEventId, newEventId } from "../core/event-context.js";
import {
  CappedBuffer,
  finalizeBody,
  type BlobUploader,
  type FinalizeResult,
} from "../core/http-body.js";
import {
  DEFAULT_HEADER_DENY,
  redactHeaders,
  type HeaderMatcher,
} from "../core/redaction.js";
import type {
  BlobRef,
  Event as PbEvent,
  HttpEvent as PbHttpEvent,
  OutboundEvent as PbOutboundEvent,
} from "../generated/clearvoiance/v1/event.js";
import { SDK_VERSION } from "../version.js";

const ADAPTER_NAME = "outbound.http";

export interface OutboundSink {
  sendBatch(events: PbEvent[]): Promise<void>;
  uploadBlob?(data: Buffer, opts?: { contentType?: string }): Promise<BlobRef>;
  track?<T>(p: Promise<T>): Promise<T>;
}

export interface PatchHttpOptions {
  /** Inline size cap. Default 64 KB. */
  maxBodyInlineBytes?: number;
  /** Blob size cap. Default 10 MB. */
  maxBodyBlobBytes?: number;
  /** Header matchers to replace with [REDACTED]. Defaults to DEFAULT_HEADER_DENY. */
  redactHeaders?: HeaderMatcher[];
  /** Error sink; defaults to console.warn. */
  onError?: (err: unknown) => void;
  /**
   * Hostnames whose outbound calls should NEVER be captured — typically the
   * engine's own gRPC host, so we don't create an infinite recording loop
   * if anything in this library's network path is http-based.
   */
  skipHosts?: string[];
}

export interface PatchHandle {
  uninstall(): void;
}

type RequestFn = typeof http.request;

interface NormalizedArgs {
  options: RequestOptions & { path?: string };
  callback: ((res: IncomingMessage) => void) | undefined;
  protocol: string;
}

/** Installs the outbound HTTP patch. Returns a handle to uninstall (used in tests). */
export function patchHttp(
  client: OutboundSink,
  opts: PatchHttpOptions = {},
): PatchHandle {
  const maxInline = opts.maxBodyInlineBytes ?? 64 * 1024;
  const maxBlob = opts.maxBodyBlobBytes ?? 10 * 1024 * 1024;
  const headerDeny = opts.redactHeaders ?? DEFAULT_HEADER_DENY;
  const onError = opts.onError ?? defaultOnError;
  const skipHosts = new Set(
    (opts.skipHosts ?? []).map((h) => h.toLowerCase()),
  );

  const uploader: BlobUploader | undefined = client.uploadBlob
    ? { uploadBlob: client.uploadBlob.bind(client) }
    : undefined;
  const bufferCap = uploader ? maxBlob : maxInline;

  const originals = {
    httpRequest: httpModule.request,
    httpsRequest: httpsModule.request,
    httpGet: httpModule.get,
    httpsGet: httpsModule.get,
  };

  const wrapRequest = (
    original: RequestFn,
    defaultProtocol: "http:" | "https:",
    thisArg: typeof http | typeof https,
  ): RequestFn => {
    return function patchedRequest(
      this: unknown,
      ...args: unknown[]
    ): ClientRequest {
      const { options, callback, protocol } = normalizeRequestArgs(
        args,
        defaultProtocol,
      );

      const host = String(
        options.hostname ?? options.host ?? "localhost",
      ).toLowerCase();
      const causedBy = currentEventId();

      // Pass-through: not inside a capture scope, or host is denylisted.
      if (!causedBy || skipHosts.has(host)) {
        return (original as unknown as Function).apply(
          thisArg,
          args,
        ) as ClientRequest;
      }

      const method = String(options.method ?? "GET").toUpperCase();
      const pathStr = String(options.path ?? "/");
      const startHr = process.hrtime.bigint();
      const startWallNs = BigInt(Date.now()) * 1_000_000n;

      const reqBuf = new CappedBuffer(bufferCap);
      const resBuf = new CappedBuffer(bufferCap);

      const clientReq = (original as unknown as Function).apply(
        thisArg,
        args,
      ) as ClientRequest;

      // --- Request body tap (intercept .write/.end chunks as the caller writes them) ---
      const origWrite = clientReq.write.bind(clientReq);
      const origEnd = clientReq.end.bind(clientReq);
      clientReq.write = function tappedWrite(
        chunk: unknown,
        ...rest: unknown[]
      ): boolean {
        if (chunk != null) reqBuf.push(toBuffer(chunk));
        return (origWrite as (...a: unknown[]) => boolean)(chunk, ...rest);
      } as ClientRequest["write"];
      clientReq.end = function tappedEnd(
        chunk?: unknown,
        ...rest: unknown[]
      ): ClientRequest {
        if (chunk != null) reqBuf.push(toBuffer(chunk));
        return (origEnd as (...a: unknown[]) => ClientRequest)(chunk, ...rest);
      } as ClientRequest["end"];

      // --- Response capture ---
      let responseStatus = 0;
      let responseHeaders: http.IncomingHttpHeaders = {};
      let httpVersionStr = "HTTP/1.1";
      let emitted = false;

      const finish = (errored: boolean): void => {
        if (emitted) return;
        emitted = true;

        const task = (async (): Promise<void> => {
          try {
            const reqFinal = await finalizeBody(reqBuf, {
              maxBodyInlineBytes: maxInline,
              contentType: stringHeader(
                lookupOutgoingHeader(options.headers, "content-type"),
              ),
              uploader,
              onBlobUploadError: onError,
            });
            const resFinal = await finalizeBody(resBuf, {
              maxBodyInlineBytes: maxInline,
              contentType: stringHeader(responseHeaders["content-type"]),
              uploader,
              onBlobUploadError: onError,
            });

            const reqHdr = redactHeaders(outgoingHeadersToRecord(options.headers), {
              headers: headerDeny,
            });
            const resHdr = redactHeaders(
              incomingHeadersToRecord(responseHeaders),
              { headers: headerDeny },
            );

            const event = buildEvent({
              eventId: newEventId(),
              startWallNs,
              durationNs: process.hrtime.bigint() - startHr,
              host,
              protocol,
              method,
              path: pathStr,
              httpVersion: httpVersionStr,
              status: errored ? 0 : responseStatus,
              reqHeaders: reqHdr.headers,
              resHeaders: resHdr.headers,
              reqBody: reqFinal,
              resBody: resFinal,
              causedBy,
              responseHash: sha256(resBuf.toBuffer()),
              appliedRedactions: [
                ...reqHdr.applied,
                ...resHdr.applied,
                ...reqFinal.redactions,
                ...resFinal.redactions,
              ],
            });

            await client.sendBatch([event]);
          } catch (err) {
            onError(err);
          }
        })();
        if (client.track) void client.track(task);
      };

      clientReq.on("response", (res: IncomingMessage) => {
        responseStatus = res.statusCode ?? 0;
        responseHeaders = res.headers;
        httpVersionStr = `HTTP/${res.httpVersion ?? "1.1"}`;

        // Listener is observational — users adding their own 'data'/'end'
        // handlers still receive chunks. Starts flowing mode on nextTick,
        // which is safe for the idiomatic callback/event patterns.
        // Async-iteration (`for await`) on the response is NOT safe: it
        // drains via an internal reader that conflicts with our listener.
        // Documented limitation for the core slice.
        const onData = (chunk: Buffer | string): void => {
          resBuf.push(toBuffer(chunk));
        };
        res.on("data", onData);
        res.once("end", () => {
          res.removeListener("data", onData);
          finish(false);
        });
        res.once("error", () => {
          res.removeListener("data", onData);
          finish(true);
        });
      });

      clientReq.once("error", () => finish(true));

      return clientReq;
    } as RequestFn;
  };

  httpModule.request = wrapRequest(originals.httpRequest, "http:", httpModule);
  httpsModule.request = wrapRequest(originals.httpsRequest, "https:", httpsModule);

  // .get is just .request() + req.end(). Rewire so it uses our patched
  // .request transparently (otherwise it would hold the original reference).
  httpModule.get = function patchedHttpGet(...args: Parameters<typeof http.get>) {
    const req = (httpModule.request as unknown as Function).apply(httpModule, args);
    (req as ClientRequest).end();
    return req as ClientRequest;
  } as typeof http.get;
  httpsModule.get = function patchedHttpsGet(...args: Parameters<typeof https.get>) {
    const req = (httpsModule.request as unknown as Function).apply(httpsModule, args);
    (req as ClientRequest).end();
    return req as ClientRequest;
  } as typeof https.get;

  return {
    uninstall() {
      httpModule.request = originals.httpRequest;
      httpsModule.request = originals.httpsRequest;
      httpModule.get = originals.httpGet;
      httpsModule.get = originals.httpsGet;
    },
  };
}

// --- helpers ---------------------------------------------------------------

interface BuildOutboundArgs {
  eventId: string;
  startWallNs: bigint;
  durationNs: bigint;
  host: string;
  protocol: string;
  method: string;
  path: string;
  httpVersion: string;
  status: number;
  reqHeaders: Record<string, { values: string[] }>;
  resHeaders: Record<string, { values: string[] }>;
  reqBody: FinalizeResult;
  resBody: FinalizeResult;
  causedBy: string;
  responseHash: Buffer;
  appliedRedactions: string[];
}

function buildEvent(a: BuildOutboundArgs): PbEvent {
  const http: PbHttpEvent = {
    method: a.method,
    path: a.path,
    httpVersion: a.httpVersion,
    headers: a.reqHeaders,
    requestBody: a.reqBody.body,
    status: a.status,
    responseHeaders: a.resHeaders,
    responseBody: a.resBody.body,
    durationNs: a.durationNs,
    sourceIp: "",
    userId: "",
    routeTemplate: "",
  };

  const outbound: PbOutboundEvent = {
    target: targetFromHost(a.host),
    http,
    causedByEventId: a.causedBy,
    responseHash: a.responseHash,
  };

  return {
    id: a.eventId,
    sessionId: "",
    timestampNs: a.startWallNs,
    offsetNs: 0n,
    adapter: ADAPTER_NAME,
    sdkVersion: `@clearvoiance/node@${SDK_VERSION}`,
    metadata: { host: a.host, scheme: a.protocol.replace(":", "") },
    redactionsApplied: a.appliedRedactions,
    outbound,
  };
}

/**
 * Normalises the polymorphic http.request signatures:
 *   request(url)
 *   request(url, cb)
 *   request(url, options)
 *   request(url, options, cb)
 *   request(options)
 *   request(options, cb)
 */
function normalizeRequestArgs(
  args: unknown[],
  defaultProtocol: "http:" | "https:",
): NormalizedArgs {
  let options: RequestOptions & { path?: string } = {};
  let callback: ((res: IncomingMessage) => void) | undefined;
  let protocol = defaultProtocol;

  let cursor = 0;
  const first = args[cursor];

  if (typeof first === "string" || first instanceof URL) {
    const url = first instanceof URL ? first : new URL(first);
    options = {
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || undefined,
      path: `${url.pathname}${url.search}`,
    };
    protocol = url.protocol as "http:" | "https:";
    cursor++;
  }

  const next = args[cursor];
  if (next && typeof next === "object" && !(next instanceof URL)) {
    options = { ...options, ...(next as RequestOptions & { path?: string }) };
    if (typeof options.protocol === "string") {
      protocol = options.protocol as "http:" | "https:";
    }
    cursor++;
  }

  const maybeCb = args[cursor];
  if (typeof maybeCb === "function") {
    callback = maybeCb as (res: IncomingMessage) => void;
  }

  return { options, callback, protocol };
}

function toBuffer(chunk: unknown): Buffer {
  if (Buffer.isBuffer(chunk)) return chunk;
  if (typeof chunk === "string") return Buffer.from(chunk);
  if (chunk instanceof Uint8Array) return Buffer.from(chunk);
  return Buffer.alloc(0);
}

function stringHeader(v: unknown): string | undefined {
  if (typeof v === "string") return v;
  if (Array.isArray(v) && typeof v[0] === "string") return v[0];
  if (typeof v === "number") return String(v);
  return undefined;
}

function outgoingHeadersToRecord(
  h: http.OutgoingHttpHeaders | readonly string[] | undefined,
): Record<string, string | string[] | number | undefined> {
  if (!h) return {};
  // Raw-headers array form: ["Content-Type", "application/json", ...].
  // Rare (set via `headers: [k, v, k, v]`) but supported by Node.
  if (Array.isArray(h)) {
    const out: Record<string, string | string[] | number | undefined> = {};
    for (let i = 0; i + 1 < h.length; i += 2) {
      out[h[i]!] = h[i + 1]!;
    }
    return out;
  }
  const out: Record<string, string | string[] | number | undefined> = {};
  for (const [k, v] of Object.entries(h)) {
    if (v === undefined) continue;
    if (Array.isArray(v)) {
      out[k] = v.map((x) => String(x));
    } else {
      out[k] = v as string | number;
    }
  }
  return out;
}

function lookupOutgoingHeader(
  h: http.OutgoingHttpHeaders | readonly string[] | undefined,
  name: string,
): string | string[] | number | undefined {
  if (!h) return undefined;
  if (Array.isArray(h)) {
    const target = name.toLowerCase();
    for (let i = 0; i + 1 < h.length; i += 2) {
      if (h[i]!.toLowerCase() === target) return h[i + 1];
    }
    return undefined;
  }
  const direct = (h as http.OutgoingHttpHeaders)[name];
  if (direct !== undefined) return direct;
  const target = name.toLowerCase();
  for (const [k, v] of Object.entries(h as http.OutgoingHttpHeaders)) {
    if (k.toLowerCase() === target) return v;
  }
  return undefined;
}

function incomingHeadersToRecord(
  h: http.IncomingHttpHeaders,
): Record<string, string | string[] | number | undefined> {
  const out: Record<string, string | string[] | number | undefined> = {};
  for (const [k, v] of Object.entries(h)) {
    if (v === undefined) continue;
    out[k] = v as string | string[];
  }
  return out;
}

/** "api.telegram.org" → "telegram.api" (short, recognizable, not DNS-ish). */
export function targetFromHost(host: string): string {
  const parts = host.split(".").filter(Boolean);
  if (parts.length <= 1) return host;
  if (parts[0] === "api") return `${parts[1]}.api`;
  if (parts[parts.length - 1] === "local") return host;
  return parts.slice(-2).join(".");
}

function sha256(buf: Buffer): Buffer {
  return createHash("sha256").update(buf).digest();
}

function defaultOnError(err: unknown): void {
  // eslint-disable-next-line no-console
  console.warn("[clearvoiance] outbound capture failed:", err);
}
