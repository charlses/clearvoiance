/**
 * Tiny SQL fingerprint. Drops literals, collapses whitespace, lowercases
 * keywords. Enough to group "SELECT * FROM leads WHERE id = 1" and
 * "SELECT * FROM leads WHERE id = 2" into one bucket without pulling in
 * a full SQL parser. Perfect accuracy isn't the goal — grouping in the
 * dashboard's slow-query rollup is.
 *
 * Mirrors the shape the Go db-observer's Fingerprint() produces so the
 * same fingerprint rolls up observer + SDK rows in ClickHouse.
 */

export function sqlFingerprint(sql: string): string {
  if (!sql) return "";
  let s = sql;
  // Drop trailing semicolons/whitespace.
  s = s.trim().replace(/;\s*$/g, "");
  // Collapse quoted strings and numbers to placeholders so literal
  // values don't fragment the bucket.
  s = s.replace(/'([^']|'')*'/g, "?");   // 'literal'
  s = s.replace(/"(?:[^"\\]|\\.)*"/g, "?"); // "ident-with-spaces"  keeps pg identifiers broken; accept false pos
  s = s.replace(/\b\d+\b/g, "?");
  // Normalise whitespace.
  s = s.replace(/\s+/g, " ").trim();
  // Cap — fingerprint is a grouping key, not evidence.
  if (s.length > 200) s = s.slice(0, 200);
  return s;
}
