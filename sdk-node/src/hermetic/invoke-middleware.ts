/**
 * Optional mount point for SUTs that prefer to expose the invoke endpoint on
 * their own HTTP server rather than running a second port. The middleware is
 * framework-agnostic: it sniffs req/res for the POST /__clearvoiance/cron/invoke
 * route and forwards anything else via `next()`.
 *
 * ```ts
 * // Express
 * import { invokeMiddleware } from "@clearvoiance/node/hermetic";
 * app.use(invokeMiddleware({ token: process.env.CLEARVOIANCE_INVOKE_TOKEN }));
 * ```
 *
 * Koa users should use koa's `mount` or wrap the returned callable in a Koa
 * middleware — the shape matches Node's raw (req, res, next) convention.
 */

import type { IncomingMessage, ServerResponse } from "node:http";

import { cronRegistry } from "./cron-killer.js";
import { INVOKE_PATH } from "./invoke-server.js";

export interface InvokeMiddlewareOptions {
  /** Optional Bearer token; required on every request if set. */
  token?: string;
  /** Called when a registered handler throws. */
  onError?: (err: unknown) => void;
}

type Next = (err?: unknown) => void;
type MiddlewareFn = (req: IncomingMessage, res: ServerResponse, next: Next) => void;

/**
 * Framework-agnostic invoke middleware. Call `next()` for any non-matching
 * request so the host app keeps handling its own routes.
 */
export function invokeMiddleware(
  opts: InvokeMiddlewareOptions = {},
): MiddlewareFn {
  const token = opts.token;
  const onError = opts.onError ?? defaultOnError;

  return function clearvoianceInvokeMiddleware(req, res, next): void {
    if (req.method !== "POST" || !isInvokePath(req.url)) {
      next();
      return;
    }

    if (token && req.headers.authorization !== `Bearer ${token}`) {
      res.statusCode = 401;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }

    let raw = "";
    req.on("data", (c) => (raw += c.toString()));
    req.on("end", () => {
      let body: Record<string, unknown> = {};
      try {
        body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      } catch (err) {
        res.statusCode = 400;
        res.end(
          JSON.stringify({
            error: "malformed body",
            detail: err instanceof Error ? err.message : String(err),
          }),
        );
        return;
      }

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
      void (async (): Promise<void> => {
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
      })();
    });
  };
}

function isInvokePath(url: string | undefined): boolean {
  if (!url) return false;
  // Ignore querystring; match the canonical path.
  const path = url.split("?")[0] ?? "";
  return path === INVOKE_PATH;
}

function decodeArgs(body: Record<string, unknown>): unknown {
  const b64 = body.args_base64;
  if (typeof b64 !== "string" || b64.length === 0) return body.args;
  const raw = Buffer.from(b64, "base64").toString("utf-8");
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function defaultOnError(err: unknown): void {
  // eslint-disable-next-line no-console
  console.warn("[clearvoiance] invoke middleware handler failed:", err);
}
