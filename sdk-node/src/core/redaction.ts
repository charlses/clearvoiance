/**
 * Header redaction for Phase 1c.
 *
 * Body-path (JSONPath) redaction lands in Phase 1d. For now the SDK hides
 * credentials in headers; body redaction is the caller's responsibility until
 * we ship structured redaction.
 */

export type HeaderMatcher = string | RegExp;

/**
 * Default denylist applied to every captured HTTP request/response unless the
 * operator explicitly overrides it. Covers the common auth-carrying headers.
 * All comparisons are case-insensitive — HTTP headers are case-insensitive
 * per RFC 7230 §3.2.
 */
export const DEFAULT_HEADER_DENY: HeaderMatcher[] = [
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
