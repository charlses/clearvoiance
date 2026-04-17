/**
 * Canonical signatures for outbound requests. The signature is what hermetic
 * mode uses to match a live outbound against a captured mock: same method +
 * host + path + canonicalized body → same signature → same mock.
 *
 * Canonicalization is intentionally lossy in known-volatile places (timestamps,
 * nonces, request ids) so minor replay-time drift doesn't nuke the match.
 * The operator opts in via `canonicalize.ignoreJsonPaths` + `ignoreHeaders`.
 */

import { createHash } from "node:crypto";

export interface CanonicalizeConfig {
  /** Top-level JSON keys to drop before hashing (flat; dot-notation not yet supported). */
  ignoreJsonKeys?: string[];
  /** Query-string params to drop. */
  ignoreQueryParams?: string[];
}

export interface SignatureInput {
  method: string;
  host: string;
  path: string;
  body: Buffer | undefined;
  contentType: string | undefined;
}

/**
 * Canonical signature for an outbound. Hex-encoded sha256 so it's cheap to
 * key a Map with.
 */
export function signatureOf(
  input: SignatureInput,
  cfg: CanonicalizeConfig = {},
): string {
  const parts: string[] = [];
  parts.push(input.method.toUpperCase());
  parts.push(input.host.toLowerCase());
  parts.push(canonicalPath(input.path, cfg.ignoreQueryParams ?? []));
  parts.push(canonicalBody(input.body, input.contentType, cfg.ignoreJsonKeys ?? []));
  return createHash("sha256").update(parts.join("|")).digest("hex");
}

function canonicalPath(path: string, ignoreParams: string[]): string {
  const qIdx = path.indexOf("?");
  if (qIdx < 0 || ignoreParams.length === 0) return path;

  const base = path.slice(0, qIdx);
  const qs = new URLSearchParams(path.slice(qIdx + 1));
  for (const k of ignoreParams) qs.delete(k);
  qs.sort();
  const rebuilt = qs.toString();
  return rebuilt ? `${base}?${rebuilt}` : base;
}

function canonicalBody(
  body: Buffer | undefined,
  contentType: string | undefined,
  ignoreKeys: string[],
): string {
  if (!body || body.length === 0) return "";
  const isJson = (contentType ?? "").toLowerCase().includes("json");
  if (!isJson) return sha256Hex(body);
  try {
    const parsed = JSON.parse(body.toString("utf-8")) as unknown;
    // Always key-sort JSON bodies so `{a,b}` and `{b,a}` match. Strip
    // ignored keys on top when configured.
    const stripped =
      ignoreKeys.length > 0 ? stripKeys(parsed, new Set(ignoreKeys)) : parsed;
    return sha256Hex(Buffer.from(stableStringify(stripped)));
  } catch {
    // Non-parsable — fall back to raw hash so a signature still exists.
    return sha256Hex(body);
  }
}

function stripKeys(value: unknown, keys: Set<string>): unknown {
  if (Array.isArray(value)) return value.map((v) => stripKeys(v, keys));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (keys.has(k)) continue;
      out[k] = stripKeys(v, keys);
    }
    return out;
  }
  return value;
}

/** Deterministic JSON.stringify — sorts object keys so {a,b} and {b,a} hash the same. */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    return `{${keys
      .map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256Hex(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}
