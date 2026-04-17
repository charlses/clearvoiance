/**
 * Hermetic intercept layer. Replaces `http.request`, `https.request`, and
 * global `fetch` with versions that look up responses in a MockStore keyed by
 * `(currentEventId, signature)`. Strict policy throws on unmocked outbounds;
 * loose serves a synthetic 200 {}.
 *
 * This is the SDK-side companion to the engine's mock-pack delivery. See
 * hermetic/client.ts for the orchestrator that fetches the pack and installs
 * the patches.
 */

import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createRequire } from "node:module";
import type * as http from "node:http";
import type * as https from "node:https";
import type { ClientRequest, IncomingMessage, RequestOptions } from "node:http";

import { currentEventId } from "../core/event-context.js";
import { signatureOf, type CanonicalizeConfig } from "../outbound/signature.js";

import { MockStore, type MockEntry } from "./mock-store.js";

const nodeRequire = createRequire(import.meta.url);
const httpModule = nodeRequire("node:http") as typeof http;
const httpsModule = nodeRequire("node:https") as typeof https;

export type HermeticPolicy = "strict" | "loose";

export interface UnmockedInfo {
  protocol: string;
  method: string;
  host: string;
  path: string;
  eventId: string;
  signature: string;
}

export interface HermeticOptions {
  store: MockStore;
  /**
   * strict: throw on unmocked outbound (default). Use this in CI so replay
   *         immediately fails if the SUT emits a new call that wasn't
   *         captured — signals real SUT-side drift, not a capture gap.
   * loose:  serve a 200 {} for unmocked outbounds. Use during development
   *         when you're OK with "good enough" replay and don't want a new
   *         API call to abort the whole run.
   */
  policy?: HermeticPolicy;
  /** Hook fired on every unmocked outbound; runs before policy enforcement. */
  onUnmocked?: (info: UnmockedInfo) => void;
  /** Canonicalization applied when computing signatures. */
  canonicalize?: CanonicalizeConfig;
}

export interface HermeticHandle {
  uninstall(): void;
}

/** Installs the hermetic intercepts on http/https/fetch. */
export function installHermetic(opts: HermeticOptions): HermeticHandle {
  const policy: HermeticPolicy = opts.policy ?? "strict";
  const store = opts.store;
  const canon = opts.canonicalize ?? {};
  const onUnmocked = opts.onUnmocked;

  const originals = {
    httpRequest: httpModule.request,
    httpsRequest: httpsModule.request,
    httpGet: httpModule.get,
    httpsGet: httpsModule.get,
    fetch: globalThis.fetch,
  };

  const makeRequestShim = (defaultProtocol: "http:" | "https:") => {
    return function hermeticRequest(
      ...args: unknown[]
    ): ClientRequest {
      const { options, protocol, callback } = normalizeRequestArgs(
        args,
        defaultProtocol,
      );
      const causedBy = currentEventId();
      if (!causedBy) {
        // Never mock calls that aren't tied to a captured event (e.g. SDK's
        // own plumbing). Pass through to the original function.
        const orig = defaultProtocol === "http:" ? originals.httpRequest : originals.httpsRequest;
        return (orig as unknown as Function).apply(
          defaultProtocol === "http:" ? httpModule : httpsModule,
          args,
        ) as ClientRequest;
      }

      const req = buildHermeticRequest({
        options,
        protocol,
        causedBy,
        store,
        canon,
        policy,
        onUnmocked,
      });
      // Node's http.request(options, cb) auto-attaches cb as a 'response'
      // listener. Replicate that so callers using the callback form work.
      if (callback) {
        (req as unknown as EventEmitter).on("response", callback);
      }
      return req;
    };
  };

  httpModule.request = makeRequestShim("http:") as typeof httpModule.request;
  httpsModule.request = makeRequestShim("https:") as typeof httpsModule.request;
  httpModule.get = function hermeticHttpGet(...args: Parameters<typeof http.get>) {
    const req = (httpModule.request as unknown as Function).apply(httpModule, args);
    (req as ClientRequest).end();
    return req as ClientRequest;
  } as typeof http.get;
  httpsModule.get = function hermeticHttpsGet(...args: Parameters<typeof https.get>) {
    const req = (httpsModule.request as unknown as Function).apply(httpsModule, args);
    (req as ClientRequest).end();
    return req as ClientRequest;
  } as typeof https.get;

  // fetch intercept: much simpler — just return a synthetic Response.
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async function hermeticFetch(
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> {
    const causedBy = currentEventId();
    if (!causedBy) return originalFetch(input, init);

    const { url, method, body, contentType } = await extractFetchCall(input, init);
    const sig = signatureOf({
      method,
      host: url.host,
      path: `${url.pathname}${url.search}`,
      body,
      contentType,
    }, canon);

    const entry = store.take(causedBy, sig);
    if (!entry) {
      const info: UnmockedInfo = {
        protocol: url.protocol,
        method,
        host: url.host,
        path: `${url.pathname}${url.search}`,
        eventId: causedBy,
        signature: sig,
      };
      onUnmocked?.(info);
      if (policy === "strict") {
        throw new Error(
          `clearvoiance hermetic: unmocked outbound ${method} ${url.host}${url.pathname} ` +
            `(event=${causedBy}, sig=${sig.slice(0, 12)}…)`,
        );
      }
      return new Response("{}", {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    return new Response(entry.responseBody, {
      status: entry.status,
      headers: flatHeadersForResponse(entry.responseHeaders),
    });
  }) as typeof fetch;

  return {
    uninstall() {
      httpModule.request = originals.httpRequest;
      httpsModule.request = originals.httpsRequest;
      httpModule.get = originals.httpGet;
      httpsModule.get = originals.httpsGet;
      globalThis.fetch = originals.fetch;
    },
  };
}

// --- http request shim -----------------------------------------------------

interface BuildHermeticReqArgs {
  options: RequestOptions & { path?: string };
  protocol: string;
  causedBy: string;
  store: MockStore;
  canon: CanonicalizeConfig;
  policy: HermeticPolicy;
  onUnmocked?: (info: UnmockedInfo) => void;
}

/**
 * Builds a ClientRequest-like object that buffers write/end, then on end:
 *   1. Computes signature
 *   2. Looks up mock → emits 'response' with a fake IncomingMessage, OR
 *   3. Strict → emits 'error' / Loose → emits synthetic 200 {}
 *
 * Covers the common consumer patterns: callback, `on('response', ...)`,
 * reading the body via `on('data')` / `on('end')`. Does NOT support async
 * iteration on the response (documented limitation).
 */
function buildHermeticRequest(a: BuildHermeticReqArgs): ClientRequest {
  const req = new EventEmitter() as unknown as ClientRequest & {
    write(chunk: unknown, ...rest: unknown[]): boolean;
    end(chunk?: unknown, ...rest: unknown[]): ClientRequest;
    setHeader(name: string, value: unknown): ClientRequest;
    getHeader(name: string): unknown;
    abort(): void;
    destroy(err?: Error): ClientRequest;
  };

  const host = String(a.options.hostname ?? a.options.host ?? "localhost").toLowerCase();
  const port = a.options.port ? `:${a.options.port}` : "";
  const method = String(a.options.method ?? "GET").toUpperCase();
  const path = String(a.options.path ?? "/");
  const reqChunks: Buffer[] = [];
  let ended = false;

  req.write = function hermeticWrite(chunk: unknown, ..._rest: unknown[]): boolean {
    if (chunk != null) reqChunks.push(toBuffer(chunk));
    return true;
  };

  req.end = function hermeticEnd(chunk?: unknown, ..._rest: unknown[]): ClientRequest {
    if (ended) return req;
    ended = true;
    if (chunk != null) reqChunks.push(toBuffer(chunk));

    const body = Buffer.concat(reqChunks);
    const contentType = firstHeader(a.options.headers, "content-type");

    const sig = signatureOf(
      { method, host: `${host}${port}`, path, body, contentType },
      a.canon,
    );
    const entry = a.store.take(a.causedBy, sig);

    // Defer emission so listeners attached after req.end() still fire.
    if (entry) {
      queueMicrotask(() => emitResponse(req, entry));
      return req;
    }

    const info: UnmockedInfo = {
      protocol: a.protocol,
      method,
      host: `${host}${port}`,
      path,
      eventId: a.causedBy,
      signature: sig,
    };
    a.onUnmocked?.(info);

    if (a.policy === "strict") {
      const err = new Error(
        `clearvoiance hermetic: unmocked outbound ${method} ${host}${port}${path} ` +
          `(event=${a.causedBy}, sig=${sig.slice(0, 12)}…)`,
      );
      queueMicrotask(() => req.emit("error", err));
      return req;
    }

    queueMicrotask(() =>
      emitResponse(req, {
        eventId: a.causedBy,
        signature: sig,
        status: 200,
        responseHeaders: { "content-type": ["application/json"] },
        responseBody: Buffer.from("{}"),
        responseContentType: "application/json",
      }),
    );
    return req;
  };

  req.setHeader = () => req;
  req.getHeader = () => undefined;
  req.abort = () => {
    /* no-op for the shim */
  };
  req.destroy = () => req;

  return req;
}

function emitResponse(
  req: ClientRequest & EventEmitter,
  entry: MockEntry,
): void {
  const res = new PassThrough() as unknown as IncomingMessage & PassThrough;
  (res as unknown as { statusCode: number }).statusCode = entry.status;
  (res as unknown as { statusMessage: string }).statusMessage = defaultStatusMessage(entry.status);
  (res as unknown as { headers: Record<string, string | string[]> }).headers =
    flattenHeadersForIncoming(entry.responseHeaders);
  (res as unknown as { httpVersion: string }).httpVersion = "1.1";
  (res as unknown as { httpVersionMajor: number }).httpVersionMajor = 1;
  (res as unknown as { httpVersionMinor: number }).httpVersionMinor = 1;

  req.emit("response", res);
  // Defer the body write so listeners attached synchronously in the
  // 'response' handler see the data/end events.
  queueMicrotask(() => {
    (res as unknown as PassThrough).end(entry.responseBody);
  });
}

// --- fetch helpers ---------------------------------------------------------

interface ExtractedFetchCall {
  url: URL;
  method: string;
  body: Buffer | undefined;
  contentType: string | undefined;
}

async function extractFetchCall(
  input: string | URL | Request,
  init: RequestInit | undefined,
): Promise<ExtractedFetchCall> {
  let url: URL;
  let method: string;
  let body: Buffer | undefined;
  let contentType: string | undefined;

  if (typeof input === "string") {
    url = new URL(input);
    method = (init?.method ?? "GET").toUpperCase();
    body = init?.body != null ? await readBody(init.body) : undefined;
    contentType = headerString(init?.headers, "content-type");
  } else if (input instanceof URL) {
    url = input;
    method = (init?.method ?? "GET").toUpperCase();
    body = init?.body != null ? await readBody(init.body) : undefined;
    contentType = headerString(init?.headers, "content-type");
  } else {
    url = new URL(input.url);
    method = (init?.method ?? input.method ?? "GET").toUpperCase();
    if (init?.body != null) {
      body = await readBody(init.body);
    } else if (input.body != null) {
      const clone = input.clone();
      body = Buffer.from(await clone.arrayBuffer());
    }
    contentType =
      headerString(init?.headers, "content-type") ??
      input.headers.get("content-type") ??
      undefined;
  }

  return { url, method, body, contentType };
}

async function readBody(body: unknown): Promise<Buffer> {
  if (typeof body === "string") return Buffer.from(body);
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  if (ArrayBuffer.isView(body)) {
    return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  }
  if (body instanceof URLSearchParams) return Buffer.from(body.toString());
  if (body instanceof Blob) return Buffer.from(await body.arrayBuffer());
  return Buffer.alloc(0);
}

function headerString(
  headers: unknown,
  name: string,
): string | undefined {
  if (!headers) return undefined;
  const target = name.toLowerCase();
  if (headers instanceof Headers) return headers.get(target) ?? undefined;
  if (Array.isArray(headers)) {
    for (const pair of headers) {
      if (Array.isArray(pair) && String(pair[0]).toLowerCase() === target) {
        return String(pair[1]);
      }
    }
    return undefined;
  }
  if (typeof headers === "object") {
    for (const [k, v] of Object.entries(headers as Record<string, unknown>)) {
      if (k.toLowerCase() === target) return String(v);
    }
  }
  return undefined;
}

// --- shared helpers --------------------------------------------------------

interface NormalizedArgs {
  options: RequestOptions & { path?: string };
  protocol: string;
  callback?: (res: IncomingMessage) => void;
}

function normalizeRequestArgs(
  args: unknown[],
  defaultProtocol: "http:" | "https:",
): NormalizedArgs {
  let options: RequestOptions & { path?: string } = {};
  let protocol: string = defaultProtocol;
  let callback: ((res: IncomingMessage) => void) | undefined;
  let cursor = 0;
  const first = args[cursor];

  if (typeof first === "string" || first instanceof URL) {
    const url = first instanceof URL ? first : new URL(first);
    options = {
      protocol: url.protocol as "http:" | "https:",
      hostname: url.hostname,
      port: url.port || undefined,
      path: `${url.pathname}${url.search}`,
    };
    protocol = url.protocol;
    cursor++;
  }

  const next = args[cursor];
  if (next && typeof next === "object" && !(next instanceof URL)) {
    options = { ...options, ...(next as RequestOptions & { path?: string }) };
    if (typeof options.protocol === "string") protocol = options.protocol;
    cursor++;
  }

  const maybeCb = args[cursor];
  if (typeof maybeCb === "function") {
    callback = maybeCb as (res: IncomingMessage) => void;
  }

  return { options, protocol, callback };
}

function toBuffer(chunk: unknown): Buffer {
  if (Buffer.isBuffer(chunk)) return chunk;
  if (typeof chunk === "string") return Buffer.from(chunk);
  if (chunk instanceof Uint8Array) return Buffer.from(chunk);
  return Buffer.alloc(0);
}

function firstHeader(
  headers: http.OutgoingHttpHeaders | readonly string[] | undefined,
  name: string,
): string | undefined {
  if (!headers) return undefined;
  const target = name.toLowerCase();
  if (Array.isArray(headers)) {
    for (let i = 0; i + 1 < headers.length; i += 2) {
      if (headers[i]!.toLowerCase() === target) return headers[i + 1];
    }
    return undefined;
  }
  for (const [k, v] of Object.entries(headers as http.OutgoingHttpHeaders)) {
    if (k.toLowerCase() === target) {
      if (Array.isArray(v)) return v[0];
      if (typeof v === "number") return String(v);
      return v;
    }
  }
  return undefined;
}

function flattenHeadersForIncoming(
  h: Record<string, string[]>,
): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [k, vs] of Object.entries(h)) {
    if (vs.length === 0) continue;
    out[k.toLowerCase()] = vs.length === 1 ? vs[0]! : vs;
  }
  return out;
}

function flatHeadersForResponse(h: Record<string, string[]>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, vs] of Object.entries(h)) {
    if (vs.length > 0) out[k] = vs[0]!;
  }
  return out;
}

function defaultStatusMessage(status: number): string {
  const map: Record<number, string> = {
    200: "OK",
    201: "Created",
    204: "No Content",
    301: "Moved Permanently",
    302: "Found",
    400: "Bad Request",
    401: "Unauthorized",
    403: "Forbidden",
    404: "Not Found",
    429: "Too Many Requests",
    500: "Internal Server Error",
    502: "Bad Gateway",
    503: "Service Unavailable",
  };
  return map[status] ?? "";
}
