/**
 * Invoke server. Listens on loopback by default so the engine's cron
 * dispatcher can trigger the SUT's registered handlers directly instead of
 * waiting for the native scheduler to fire (which has been killed by
 * `patchCron`).
 *
 * The endpoint the engine expects is POST /__clearvoiance/cron/invoke with a
 * JSON body `{ name, scheduler, trigger_source, vu, args_base64 }`. We look
 * up `name` in the cron registry and invoke it with `args_base64` decoded
 * and parsed (or raw bytes if non-JSON).
 *
 * For SUTs that already expose an HTTP server, prefer `createInvokeMiddleware`
 * (invoke-middleware.ts) so you don't need to open a second port.
 */

import * as http from "node:http";
import type { AddressInfo } from "node:net";

import { cronRegistry } from "./cron-killer.js";

export const INVOKE_PATH = "/__clearvoiance/cron/invoke";

export interface InvokeServerOptions {
  /** Default 7777. Pass 0 to get an OS-assigned port (useful in tests). */
  port?: number;
  /** Default "127.0.0.1". Use "0.0.0.0" for cross-container engines. */
  host?: string;
  /** Optional Bearer token; required on every request if set. */
  token?: string;
  /** Called on every error while executing a registered handler. */
  onError?: (err: unknown) => void;
}

export interface InvokeServerHandle {
  /** The port the server bound to (resolved even when options.port was 0). */
  port: number;
  /** Stops the server and drains open connections. */
  stop(): Promise<void>;
}

/** Starts the invoke server. Resolves once the socket is bound. */
export async function startInvokeServer(
  opts: InvokeServerOptions = {},
): Promise<InvokeServerHandle> {
  const host = opts.host ?? "127.0.0.1";
  const port = opts.port ?? 7777;
  const token = opts.token;
  const onError = opts.onError ?? defaultOnError;

  const server = http.createServer(async (req, res) => {
    // Auth
    if (token) {
      const auth = req.headers.authorization;
      if (auth !== `Bearer ${token}`) {
        res.statusCode = 401;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
    }

    if (req.method !== "POST" || req.url !== INVOKE_PATH) {
      res.statusCode = 404;
      res.end();
      return;
    }

    let raw = "";
    req.on("data", (c) => (raw += c.toString()));
    req.on("end", async () => {
      try {
        const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
        const name = String(body.name ?? "");
        if (!name) {
          res.statusCode = 400;
          res.end(JSON.stringify({ error: "name is required" }));
          return;
        }

        const handler = cronRegistry.get(name);
        if (!handler) {
          res.statusCode = 404;
          res.end(JSON.stringify({ error: `unknown handler: ${name}` }));
          return;
        }

        const args = decodeArgs(body);
        try {
          const started = process.hrtime.bigint();
          await handler(args);
          const duration = Number(process.hrtime.bigint() - started) / 1_000_000;
          res.statusCode = 200;
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ ok: true, duration_ms: duration }));
        } catch (err) {
          onError(err);
          res.statusCode = 500;
          res.setHeader("content-type", "application/json");
          res.end(
            JSON.stringify({
              ok: false,
              error: err instanceof Error ? err.message : String(err),
            }),
          );
        }
      } catch (parseErr) {
        res.statusCode = 400;
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            error: "malformed body",
            detail: parseErr instanceof Error ? parseErr.message : String(parseErr),
          }),
        );
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const bound = (server.address() as AddressInfo | null)?.port ?? port;

  return {
    port: bound,
    stop(): Promise<void> {
      return new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}

/**
 * Decodes args from the request body. The engine's cron dispatcher sends
 * `args_base64`; we base64-decode it and try JSON-parse as a convenience,
 * falling back to the raw string, falling back to undefined.
 */
function decodeArgs(body: Record<string, unknown>): unknown {
  const b64 = body.args_base64;
  if (typeof b64 !== "string" || b64.length === 0) {
    // Allow inline args too, for callers that don't base64-encode.
    return body.args;
  }
  const raw = Buffer.from(b64, "base64").toString("utf-8");
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function defaultOnError(err: unknown): void {
  // eslint-disable-next-line no-console
  console.warn("[clearvoiance] invoke handler failed:", err);
}
