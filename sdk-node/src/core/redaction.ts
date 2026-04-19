/**
 * Header redaction for Phase 1c.
 *
 * Body-path (JSONPath) redaction lands in Phase 1d. For now the SDK hides
 * credentials in headers; body redaction is the caller's responsibility until
 * we ship structured redaction.
 */

export type HeaderMatcher = string | RegExp;

/**
 * Default denylist: empty. The SDK captures full-fidelity headers
 * (including Authorization, Cookie, Set-Cookie, etc.) so captured
 * traffic can be replayed faithfully against the same SUT without
 * auth-strategy acrobatics.
 *
 * If you capture against a production environment and want to keep
 * credentials out of ClickHouse, opt into redaction at the adapter
 * level — e.g. with the Koa/Express/Fastify adapters:
 *
 *   captureKoa(client, {
 *     redactHeaders: [
 *       "authorization", "cookie", "set-cookie",
 *       "proxy-authorization", "x-api-key", "x-auth-token",
 *       /^x-secret-/i,
 *     ],
 *   })
 *
 * For dev/staging captures, the default is what you want: everything
 * gets captured, replay Just Works because the JWT/session cookie
 * flows through as-is.
 */
export const DEFAULT_HEADER_DENY: HeaderMatcher[] = [];

/**
 * Recommended redaction set for production captures. Exported so
 * operators can opt into "the sensible defaults" without typing out
 * every header name. Apply per-adapter:
 *
 *   import { RECOMMENDED_HEADER_DENY_PRODUCTION } from "@clearvoiance/node";
 *   captureKoa(client, { redactHeaders: RECOMMENDED_HEADER_DENY_PRODUCTION })
 */
export const RECOMMENDED_HEADER_DENY_PRODUCTION: HeaderMatcher[] = [
  "authorization",
  "cookie",
  "set-cookie",
  "proxy-authorization",
  "x-api-key",
  "x-auth-token",
  /^x-secret-/i,
];

export interface RedactionConfig {
  /** Header names or regexes; matches are replaced with [REDACTED]. */
  headers?: HeaderMatcher[];
}

export interface RedactionResult {
  /** Redacted header map with repeated values preserved. */
  headers: Record<string, { values: string[] }>;
  /** Names of redacted headers, for audit. */
  applied: string[];
}

const REDACTED = "[REDACTED]";

/**
 * Normalises raw Node headers into the protobuf HeaderValues shape and applies
 * the configured denylist. Accepts both Node's string-or-array header dict and
 * Express' res.getHeaders() output.
 */
export function redactHeaders(
  rawHeaders: Record<string, string | string[] | number | undefined>,
  cfg: RedactionConfig = {},
): RedactionResult {
  const matchers = cfg.headers ?? DEFAULT_HEADER_DENY;
  const headers: Record<string, { values: string[] }> = {};
  const applied = new Set<string>();

  for (const [name, raw] of Object.entries(rawHeaders)) {
    if (raw === undefined) continue;
    const lower = name.toLowerCase();
    const values = Array.isArray(raw)
      ? raw.map((v) => String(v))
      : [String(raw)];

    if (isRedacted(lower, matchers)) {
      headers[lower] = { values: values.map(() => REDACTED) };
      applied.add(`header:${lower}`);
    } else {
      headers[lower] = { values };
    }
  }

  return { headers, applied: [...applied] };
}

function isRedacted(lowerName: string, matchers: HeaderMatcher[]): boolean {
  for (const m of matchers) {
    if (typeof m === "string") {
      if (m.toLowerCase() === lowerName) return true;
    } else if (m.test(lowerName)) {
      return true;
    }
  }
  return false;
}
