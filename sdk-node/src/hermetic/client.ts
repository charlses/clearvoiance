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

import { credentials, type ClientReadableStream } from "@grpc/grpc-js";

import {
  HermeticServiceClient,
  type GetMockPackResponse as PbMockEntry,
} from "../generated/clearvoiance/v1/hermetic.js";

import {
  installHermetic,
  type HermeticHandle,
  type HermeticPolicy,
} from "./intercept.js";
import { MockStore } from "./mock-store.js";

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
}

/**
 * Reads the CLEARVOIANCE_HERMETIC env vars and activates when asked.
 * Returns null when hermetic is not requested, a handle otherwise.
 */
export async function maybeActivateHermetic(): Promise<HermeticHandle | null> {
  if (process.env.CLEARVOIANCE_HERMETIC !== "true") return null;

  const engineUrl = required("CLEARVOIANCE_ENGINE_URL");
  const apiKey = required("CLEARVOIANCE_API_KEY");
  const sourceSessionId = required("CLEARVOIANCE_SOURCE_SESSION_ID");
  const policy = (process.env.CLEARVOIANCE_HERMETIC_POLICY ?? "strict") as HermeticPolicy;

  return activateHermetic({ engineUrl, apiKey, sourceSessionId, policy });
}

/** Programmatic activation; fills the store and installs intercepts. */
export async function activateHermetic(opts: ActivateOptions): Promise<HermeticHandle> {
  const store = await fetchMockPack(opts);
  opts.onReady?.(store);
  return installHermetic({ store, policy: opts.policy ?? "strict" });
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
