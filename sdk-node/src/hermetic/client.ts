/**
 * Hermetic-mode orchestrator. Activated when CLEARVOIANCE_HERMETIC=true is
 * set in the SUT's environment at boot; the SDK connects to the engine,
 * streams the mock pack for CLEARVOIANCE_SOURCE_SESSION_ID into an in-memory
 * MockStore, then installs the hermetic intercept.
 *
 * Usage (inside the SUT's entry point):
 *   ```ts
 *   import { maybeActivateHermetic } from "@clearvoiance/node/hermetic";
 *   await maybeActivateHermetic();          // reads env, no-op if not set
 *   // ... rest of app boot
 *   ```
 *
 * Env vars:
 *   CLEARVOIANCE_HERMETIC            "true" → activate
 *   CLEARVOIANCE_ENGINE_URL          gRPC target, e.g. 127.0.0.1:9100
 *   CLEARVOIANCE_API_KEY             required (dev-open accepts any value)
 *   CLEARVOIANCE_SOURCE_SESSION_ID   session to replay from
 *   CLEARVOIANCE_HERMETIC_POLICY     "strict" (default) | "loose"
 */

import { createRequire } from "node:module";
import { credentials, type ClientReadableStream } from "@grpc/grpc-js";

import { runOutsideEvent } from "../core/event-context.js";
import {
  HermeticServiceClient,
  type GetMockPackResponse as PbMockEntry,
} from "../generated/clearvoiance/v1/hermetic.js";
import type { CanonicalizeConfig } from "../outbound/signature.js";

const nodeRequire = createRequire(import.meta.url);

import { patchCron } from "./cron-killer.js";
import {
  installHermetic,
  type HermeticHandle,
  type HermeticPolicy,
  type UnmockedInfo,
} from "./intercept.js";
import { MockStore } from "./mock-store.js";
import {
  startInvokeServer,
  type InvokeServerHandle,
  type InvokeServerOptions,
} from "./invoke-server.js";

export interface ActivateOptions {
  engineUrl: string;
  apiKey: string;
  sourceSessionId: string;
  policy?: HermeticPolicy;
  tls?: boolean;
  /** Time cap for the mock-pack stream. Default 30s. */
  fetchTimeoutMs?: number;
  /** Surface the populated MockStore for tests / diagnostics. */
  onReady?: (store: MockStore) => void;
  /**
   * Canonicalization config forwarded to the intercept layer. Set
   * `ignoreJsonKeys` / `ignoreQueryParams` for known-volatile fields
   * (timestamps, nonces, request ids) so minor drift doesn't miss the mock.
   */
  canonicalize?: CanonicalizeConfig;
  /** Fires on every unmocked outbound before policy is enforced. */
  onUnmocked?: (info: UnmockedInfo) => void;
  /**
   * When true, unmocked outbounds are also logged to the engine's
   * unmocked-log endpoint so operators can review what's missing. The SDK
   * posts the UnmockedInfo as JSON and does not wait on the response —
   * logging failure never affects the policy decision. Default false.
   */
  recordUnmocked?: boolean;
  /**
   * Kill the SUT's native cron scheduler so only replay-driven invocations
   * fire. Default true when hermetic is activated.
   */
  killCron?: boolean;
  /**
   * Start the invoke server on a loopback port so the engine's cron
   * dispatcher can POST to SUT handlers. Default undefined (server not
   * started); pass `{}` for defaults (127.0.0.1:7777) or specific opts.
   */
  invokeServer?: InvokeServerOptions;
}

/**
 * Aggregate handle returned by `activateHermetic` — uninstalling tears down
 * intercepts, cron killer, and invoke server in the correct order.
 */
export interface FullHermeticHandle extends HermeticHandle {
  invokeServer: InvokeServerHandle | null;
}

/**
 * Reads the CLEARVOIANCE_HERMETIC env vars and activates when asked.
 * Returns null when hermetic is not requested, a handle otherwise.
 *
 * Env surface:
 *   CLEARVOIANCE_HERMETIC             "true" → activate
 *   CLEARVOIANCE_ENGINE_URL           gRPC target, e.g. 127.0.0.1:9100
 *   CLEARVOIANCE_API_KEY              api key
 *   CLEARVOIANCE_SOURCE_SESSION_ID    captured session to replay from
 *   CLEARVOIANCE_HERMETIC_POLICY      "strict" (default) | "loose"
 *   CLEARVOIANCE_HERMETIC_KILL_CRON   "false" to keep native cron running
 *   CLEARVOIANCE_HERMETIC_INVOKE_PORT when set, starts the invoke server
 *   CLEARVOIANCE_HERMETIC_INVOKE_TOKEN optional Bearer token for invoke
 *   CLEARVOIANCE_HERMETIC_RECORD_UNMOCKED "true" to POST unmocked info
 */
export async function maybeActivateHermetic(): Promise<FullHermeticHandle | null> {
  if (process.env.CLEARVOIANCE_HERMETIC !== "true") return null;

  const engineUrl = required("CLEARVOIANCE_ENGINE_URL");
  const apiKey = required("CLEARVOIANCE_API_KEY");
  const sourceSessionId = required("CLEARVOIANCE_SOURCE_SESSION_ID");
  const policy = (process.env.CLEARVOIANCE_HERMETIC_POLICY ?? "strict") as HermeticPolicy;
  const killCron = process.env.CLEARVOIANCE_HERMETIC_KILL_CRON !== "false";
  const recordUnmocked =
    process.env.CLEARVOIANCE_HERMETIC_RECORD_UNMOCKED === "true";
  const invokePort = Number(process.env.CLEARVOIANCE_HERMETIC_INVOKE_PORT ?? "0");
  const invokeServer = invokePort
    ? {
        port: invokePort,
        token: process.env.CLEARVOIANCE_HERMETIC_INVOKE_TOKEN,
      }
    : undefined;

  return activateHermetic({
    engineUrl,
    apiKey,
    sourceSessionId,
    policy,
    killCron,
    recordUnmocked,
    invokeServer,
  });
}

/** Programmatic activation; fills the store, installs intercepts, kills cron, starts invoke server. */
export async function activateHermetic(
  opts: ActivateOptions,
): Promise<FullHermeticHandle> {
  const store = await fetchMockPack(opts);
  opts.onReady?.(store);

  const cleanups: Array<() => void | Promise<void>> = [];

  // Kill native cron (default true) so SUT scheduler doesn't fire on its own.
  if (opts.killCron !== false) {
    const cronHandle = patchCron();
    cleanups.push(cronHandle.uninstall);
  }

  // Start invoke server if requested.
  let invokeServer: InvokeServerHandle | null = null;
  if (opts.invokeServer) {
    invokeServer = await startInvokeServer(opts.invokeServer);
    cleanups.push(() => invokeServer?.stop());
  }

  // Wire the unmocked callback: user hook first, then optional engine log.
  // The log fires OUTSIDE the current event scope so its own HTTP call
  // isn't re-caught by the hermetic intercept (which would re-throw under
  // strict policy and mask the original unmocked-outbound error).
  const onUnmocked = (info: UnmockedInfo): void => {
    opts.onUnmocked?.(info);
    if (opts.recordUnmocked) runOutsideEvent(() => postUnmocked(opts, info));
  };

  const interceptHandle = installHermetic({
    store,
    policy: opts.policy ?? "strict",
    canonicalize: opts.canonicalize,
    onUnmocked,
  });

  return {
    invokeServer,
    uninstall(): void {
      interceptHandle.uninstall();
      // Reverse order so cron killer undoes before invoke server stops.
      for (const fn of cleanups.reverse()) {
        void fn();
      }
    },
  };
}

/**
 * POSTs an UnmockedInfo record to the engine's unmocked-log endpoint.
 * Called from `runOutsideEvent` so the intercept layer doesn't re-catch
 * this request.
 */
function postUnmocked(opts: ActivateOptions, info: UnmockedInfo): void {
  const rawHttp = nodeRequire("node:http") as typeof import("node:http");
  const [host, port] = opts.engineUrl.split(":");
  const body = JSON.stringify({
    source_session_id: opts.sourceSessionId,
    ...info,
  });
  try {
    const req = rawHttp.request({
      host,
      port: port ? Number(port) : 80,
      path: "/hermetic/unmocked",
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": String(Buffer.byteLength(body)),
      },
    });
    req.on("error", () => {
      /* silent — logging must never block replay */
    });
    req.end(body);
  } catch {
    /* silent */
  }
}

/** Streams the mock pack from the engine into a fresh MockStore. */
export async function fetchMockPack(opts: ActivateOptions): Promise<MockStore> {
  const timeoutMs = opts.fetchTimeoutMs ?? 30_000;
  const creds = opts.tls ? credentials.createSsl() : credentials.createInsecure();
  const client = new HermeticServiceClient(opts.engineUrl, creds);

  const store = new MockStore();
  const stream: ClientReadableStream<PbMockEntry> = client.getMockPack({
    sourceSessionId: opts.sourceSessionId,
    apiKey: opts.apiKey,
  });

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      stream.cancel();
      reject(
        new Error(
          `clearvoiance hermetic: mock-pack stream timed out after ${timeoutMs}ms`,
        ),
      );
    }, timeoutMs);

    stream.on("data", (entry: PbMockEntry) => {
      store.add({
        eventId: entry.causedByEventId,
        signature: entry.signature,
        status: entry.status,
        responseHeaders: mapHeaderValues(entry.responseHeaders),
        responseBody: Buffer.from(entry.responseBody),
        responseContentType: entry.responseContentType,
      });
    });
    stream.on("end", () => {
      clearTimeout(timer);
      resolve();
    });
    stream.on("error", (err: Error) => {
      clearTimeout(timer);
      reject(err);
    });
  });

  // gRPC client leaves a background HTTP/2 connection; close it so callers
  // that short-lived the client don't hang on exit.
  client.close();

  return store;
}

function required(name: string): string {
  const v = process.env[name];
  if (!v) {
    throw new Error(
      `clearvoiance hermetic: ${name} is required when CLEARVOIANCE_HERMETIC=true`,
    );
  }
  return v;
}

function mapHeaderValues(
  h: Record<string, { values: string[] }> | undefined,
): Record<string, string[]> {
  if (!h) return {};
  const out: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(h)) out[k] = v.values ?? [];
  return out;
}
