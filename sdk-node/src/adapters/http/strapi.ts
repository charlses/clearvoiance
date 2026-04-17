/**
 * Strapi HTTP capture adapter.
 *
 * Strapi is Koa under the hood but its middleware system uses a factory
 * convention: you export `(config, { strapi }) => koaMiddleware`. This module
 * wraps the Koa adapter in that shape.
 *
 * Drop this file (or a thin wrapper that imports it) into `src/middlewares/`:
 *
 * ```ts
 * // src/middlewares/clearvoiance.ts
 * import { createClient } from "@clearvoiance/node";
 * import { clearvoianceStrapiMiddleware } from "@clearvoiance/node/http/strapi";
 *
 * const client = createClient({
 *   engine: { url: process.env.CLEARVOIANCE_ENGINE_URL!, apiKey: process.env.CLEARVOIANCE_API_KEY! },
 *   session: { name: "strapi" },
 * });
 * // Top-level await works in Strapi's ESM config — otherwise wrap in an IIFE.
 * await client.start();
 *
 * export default () => clearvoianceStrapiMiddleware(client, {
 *   userExtractor: (ctx) => ctx.state?.user?.id,
 * });
 * ```
 *
 * Then register it in `config/middlewares.ts` before any body parser.
 */

import type { Middleware } from "koa";

import { captureKoa, type CaptureKoaOptions, type EventSink } from "./koa.js";

/**
 * Factory for a Strapi-compatible middleware. The returned value matches
 * Strapi's `(config, { strapi }) => middleware` signature; both arguments are
 * ignored because the client is passed in explicitly — avoids depending on
 * Strapi's runtime type at SDK build time.
 */
export function clearvoianceStrapiMiddleware(
  client: EventSink,
  opts: CaptureKoaOptions = {},
): (_config: unknown, _strapi?: unknown) => Middleware {
  const middleware = captureKoa(client, opts);
  return (_config: unknown, _strapi?: unknown): Middleware => middleware;
}

// Re-export options type so users can import both in one spot.
export type { CaptureKoaOptions, EventSink };
