/**
 * Auto-detect mode. Inspects an `app` object (or the caller's `node_modules`)
 * and installs any clearvoiance adapters whose peer dep is present. Meant
 * for prototypes / dev — production code should wire adapters explicitly
 * so the installed set is obvious from the imports.
 *
 * ```ts
 * import { createClient } from "@clearvoiance/node";
 * import { autoInstrument } from "@clearvoiance/node/auto";
 *
 * const app = express();
 * const client = createClient({...});
 * await client.start();
 * autoInstrument(client, { app });  // detects Express, installs captureHttp
 * ```
 *
 * Also patches global outbound surfaces (http/https + fetch) unconditionally
 * since those aren't framework-dependent.
 */

import type {
  BlobRef,
  Event as PbEvent,
} from "./generated/clearvoiance/v1/event.js";
import { patchHttp, patchFetch, type PatchHandle } from "./outbound/index.js";

// Narrow shape every HTTP adapter's sink expects.
export interface EventSink {
  sendBatch(events: PbEvent[]): Promise<void>;
  uploadBlob?(data: Buffer, opts?: { contentType?: string }): Promise<BlobRef>;
  track?<T>(p: Promise<T>): Promise<T>;
}

export interface AutoInstrumentOptions {
  /**
   * The HTTP framework's app instance. Used both to decide which adapter
   * to use AND (for Express/Koa/Fastify) as the target to install on.
   * Omit when you only want outbound + DB patches.
   */
  app?: unknown;
  /** Skip installing outbound HTTP + fetch patches. Default false. */
  skipOutbound?: boolean;
}

export interface AutoInstrumentHandle {
  detected: string[];
  uninstall(): void;
}

/**
 * Best-effort adapter installer. Never throws; returns a handle listing
 * what was detected so callers can log + assert during dev.
 */
export async function autoInstrument(
  client: EventSink,
  opts: AutoInstrumentOptions = {},
): Promise<AutoInstrumentHandle> {
  const detected: string[] = [];
  const handles: Array<() => void> = [];

  if (opts.app) {
    if (isExpress(opts.app)) {
      const mod = await import("./adapters/http/express.js");
      (opts.app as { use: (fn: unknown) => unknown }).use(mod.captureHttp(client));
      detected.push("http.express");
    } else if (isKoa(opts.app)) {
      const mod = await import("./adapters/http/koa.js");
      (opts.app as { use: (fn: unknown) => unknown }).use(mod.captureKoa(client));
      detected.push("http.koa");
    } else if (isFastify(opts.app)) {
      const mod = await import("./adapters/http/fastify.js");
      mod.registerCapture(opts.app as never, client);
      detected.push("http.fastify");
    }
  }

  if (!opts.skipOutbound) {
    let outboundHandle: PatchHandle | null = null;
    try {
      outboundHandle = patchHttp(client);
      handles.push(() => outboundHandle?.uninstall());
      detected.push("outbound.http");
    } catch {
      /* ignore — falls back to unpatched */
    }
    if (typeof globalThis.fetch === "function") {
      try {
        const fh = patchFetch(client);
        handles.push(() => fh.uninstall());
        detected.push("outbound.fetch");
      } catch {
        /* ignore */
      }
    }
  }

  return {
    detected,
    uninstall() {
      for (const fn of handles.reverse()) fn();
    },
  };
}

// --- framework duck-typing -------------------------------------------

function isExpress(app: unknown): boolean {
  // Express apps are callable functions with attached methods (the function
  // body IS the request handler). Koa and Fastify apps are plain objects.
  // This shape check disambiguates cleanly without probing Express-internal
  // fields that move around between majors.
  if (typeof app !== "function") return false;
  const a = app as {
    use?: unknown;
    get?: unknown;
    set?: unknown;
    engines?: unknown;
  };
  return (
    typeof a.use === "function" &&
    typeof a.get === "function" &&
    typeof a.set === "function" &&
    typeof a.engines === "object"
  );
}

function isKoa(app: unknown): boolean {
  if (!app || typeof app !== "object") return false;
  const a = app as { use?: unknown; callback?: unknown; context?: unknown; middleware?: unknown };
  // Koa apps have both `.context` and `.middleware` arrays; that's enough
  // to disambiguate from Express which has neither.
  return typeof a.use === "function" && "context" in a && "middleware" in a;
}

function isFastify(app: unknown): boolean {
  if (!app || typeof app !== "object") return false;
  const a = app as { addHook?: unknown; server?: unknown; hasPlugin?: unknown };
  return typeof a.addHook === "function" && "server" in a;
}
