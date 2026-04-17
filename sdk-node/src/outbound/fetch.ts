/**
 * Outbound capture for the global `fetch` API (Node 22+). Node uses undici
 * internally for fetch, so this patch covers calls made via `fetch()` or any
 * library built on top of it (node-fetch@3+, ky, ofetch, etc).
 *
 * Like the http patch, this only records outbounds fired from within a
 * capture scope (`currentEventId()` set by an inbound adapter). Outside that
 * scope, fetch passes through untouched.
 */

import { createHash } from "node:crypto";

import { currentEventId, newEventId } from "../core/event-context.js";
import {
  CappedBuffer,
  finalizeBody,
  type BlobUploader,
} from "../core/http-body.js";
import {
  DEFAULT_HEADER_DENY,
  redactHeaders,
  type HeaderMatcher,
} from "../core/redaction.js";
import type {
  Event as PbEvent,
  HttpEvent as PbHttpEvent,
  OutboundEvent as PbOutboundEvent,
} from "../generated/clearvoiance/v1/event.js";
import { SDK_VERSION } from "../version.js";

import type { OutboundSink, PatchHandle } from "./http.js";
import { targetFromHost } from "./http.js";

const ADAPTER_NAME = "outbound.fetch";

export interface PatchFetchOptions {
  maxBodyInlineBytes?: number;
  maxBodyBlobBytes?: number;
  redactHeaders?: HeaderMatcher[];
  onError?: (err: unknown) => void;
  skipHosts?: string[];
}

/**
 * Installs a global-fetch wrapper that records outbound calls. Returns a
 * handle that restores the original fetch on uninstall.
 */
export function patchFetch(
  client: OutboundSink,
  opts: PatchFetchOptions = {},
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

  const originalFetch = globalThis.fetch;
  if (typeof originalFetch !== "function") {
    throw new Error("global fetch is not available; requires Node 22+");
  }

  const patched: typeof fetch = async function patchedFetch(
    input,
    init,
  ): Promise<Response> {
    const causedBy = currentEventId();
    if (!causedBy) return originalFetch(input, init);

    // Resolve the URL + method up front for the skip-host decision.
    let url: URL;
    let method: string;
    if (typeof input === "string") {
      url = new URL(input);
      method = (init?.method ?? "GET").toUpperCase();
    } else if (input instanceof URL) {
      url = input;
      method = (init?.method ?? "GET").toUpperCase();
    } else {
      // Request object
      url = new URL(input.url);
      method = (init?.method ?? input.method ?? "GET").toUpperCase();
    }

    const host = url.host.toLowerCase();
    if (skipHosts.has(url.hostname.toLowerCase())) {
      return originalFetch(input, init);
    }

    const startHr = process.hrtime.bigint();
    const startWallNs = BigInt(Date.now()) * 1_000_000n;

    // Capture request body BEFORE fetch consumes it.
    const reqBuf = new CappedBuffer(bufferCap);
    const reqHeaders = mergedRequestHeaders(input, init);
    const reqContentType = reqHeaders["content-type"];

    if (init?.body != null) {
      const bodyBuf = await readRequestBody(init.body);
      reqBuf.push(bodyBuf);
      if (bodyBuf.length > 0) init.body = bodyBuf;
    } else if (input instanceof Request && input.body != null) {
      // Clone so the downstream fetch still has a readable body.
      const reqClone = input.clone();
      const bodyBuf = Buffer.from(await reqClone.arrayBuffer());
      reqBuf.push(bodyBuf);
    }

    const response = await originalFetch(input, init);

    // Clone for body capture — the original response is returned to the caller
    // untouched so their downstream logic is unaffected.
    const responseClone = response.clone();

    const task = (async (): Promise<void> => {
      try {
        const resBuf = new CappedBuffer(bufferCap);
        // arrayBuffer() reads the whole thing; that's fine for outbound
        // capture since the clone is disposable.
        const resBytes = Buffer.from(await responseClone.arrayBuffer());
        resBuf.push(resBytes);

        const resHeadersRaw = responseHeadersToRecord(response.headers);
        const resContentType = stringHeader(
          resHeadersRaw["content-type"],
        );

        const reqFinal = await finalizeBody(reqBuf, {
          maxBodyInlineBytes: maxInline,
          contentType: stringHeader(reqContentType),
          uploader,
          onBlobUploadError: onError,
        });
        const resFinal = await finalizeBody(resBuf, {
          maxBodyInlineBytes: maxInline,
          contentType: resContentType,
          uploader,
          onBlobUploadError: onError,
        });

        const reqHdr = redactHeaders(reqHeaders, { headers: headerDeny });
        const resHdr = redactHeaders(resHeadersRaw, { headers: headerDeny });

        const http: PbHttpEvent = {
          method,
          path: `${url.pathname}${url.search}`,
          httpVersion: "HTTP/1.1",
          headers: reqHdr.headers,
          requestBody: reqFinal.body,
          status: response.status,
          responseHeaders: resHdr.headers,
          responseBody: resFinal.body,
          durationNs: process.hrtime.bigint() - startHr,
          sourceIp: "",
          userId: "",
          routeTemplate: "",
        };

        const outbound: PbOutboundEvent = {
          target: targetFromHost(url.hostname),
          http,
          causedByEventId: causedBy,
          responseHash: sha256(resBytes),
        };

        const event: PbEvent = {
          id: newEventId(),
          sessionId: "",
          timestampNs: startWallNs,
          offsetNs: 0n,
          adapter: ADAPTER_NAME,
          sdkVersion: `@clearvoiance/node@${SDK_VERSION}`,
          metadata: { host, scheme: url.protocol.replace(":", "") },
          redactionsApplied: [
            ...reqHdr.applied,
            ...resHdr.applied,
            ...reqFinal.redactions,
            ...resFinal.redactions,
          ],
          outbound,
        };

        await client.sendBatch([event]);
      } catch (err) {
        onError(err);
      }
    })();

    if (client.track) void client.track(task);

    return response;
  };

  globalThis.fetch = patched;

  return {
    uninstall() {
      globalThis.fetch = originalFetch;
    },
  };
}

// --- helpers ---------------------------------------------------------------

async function readRequestBody(body: unknown): Promise<Buffer> {
  if (body == null) return Buffer.alloc(0);
  if (typeof body === "string") return Buffer.from(body);
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  if (ArrayBuffer.isView(body)) {
    return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  }
  if (body instanceof URLSearchParams) {
    return Buffer.from(body.toString());
  }
  if (body instanceof Blob) {
    return Buffer.from(await body.arrayBuffer());
  }
  if (body instanceof FormData) {
    // Serialize FormData as a string approximation; exact multipart is
    // noisy and not round-trippable. Good enough for a capture record.
    const parts: string[] = [];
    for (const [k, v] of body.entries()) {
      parts.push(`${k}=${typeof v === "string" ? v : "[file]"}`);
    }
    return Buffer.from(parts.join("&"));
  }
  if (body instanceof ReadableStream) {
    const chunks: Buffer[] = [];
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }
  return Buffer.alloc(0);
}

function mergedRequestHeaders(
  input: string | URL | Request,
  init: RequestInit | undefined,
): Record<string, string | string[] | number | undefined> {
  const out: Record<string, string | string[] | number | undefined> = {};
  if (input instanceof Request) {
    for (const [k, v] of input.headers) out[k.toLowerCase()] = v;
  }
  if (init?.headers) {
    if (init.headers instanceof Headers) {
      for (const [k, v] of init.headers) out[k.toLowerCase()] = v;
    } else if (Array.isArray(init.headers)) {
      for (const pair of init.headers) {
        if (Array.isArray(pair) && pair.length === 2) {
          out[String(pair[0]).toLowerCase()] = String(pair[1]);
        }
      }
    } else {
      for (const [k, v] of Object.entries(init.headers)) {
        if (v != null) out[k.toLowerCase()] = v as string;
      }
    }
  }
  return out;
}

function responseHeadersToRecord(
  h: Headers,
): Record<string, string | string[] | number | undefined> {
  const out: Record<string, string | string[] | number | undefined> = {};
  for (const [k, v] of h) out[k.toLowerCase()] = v;
  return out;
}

function stringHeader(v: unknown): string | undefined {
  if (typeof v === "string") return v;
  if (Array.isArray(v) && typeof v[0] === "string") return v[0];
  return undefined;
}

function sha256(buf: Buffer): Buffer {
  return createHash("sha256").update(buf).digest();
}

function defaultOnError(err: unknown): void {
  // eslint-disable-next-line no-console
  console.warn("[clearvoiance] outbound fetch capture failed:", err);
}
