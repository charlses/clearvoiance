// Small stats utilities shared by the Session and Replay detail pages.
// Everything is in-memory over whatever rows were returned for the
// current page — no claim to be cheap for huge sessions, just enough to
// turn a flat events list into something diagnostic.

export interface HTTPSample {
  method?: string;
  route?: string;
  path?: string;
  durationNs: number;
  status?: number;
}

export interface EndpointRollup {
  key: string;
  method: string;
  route: string;
  count: number;
  p50: number;
  p95: number;
  max: number;
  errorRate: number;
}

export function rollupByEndpoint(samples: HTTPSample[]): EndpointRollup[] {
  const groups = new Map<string, HTTPSample[]>();
  for (const s of samples) {
    const method = s.method ?? "-";
    const route = s.route || s.path || "-";
    // Skip non-HTTP rows (no method + no path).
    if (method === "-" && route === "-") continue;
    const key = `${method} ${route}`;
    const arr = groups.get(key);
    if (arr) arr.push(s);
    else groups.set(key, [s]);
  }
  const out: EndpointRollup[] = [];
  for (const [key, arr] of groups) {
    const durations = arr
      .map((s) => s.durationNs)
      .filter((n) => n > 0)
      .sort((a, b) => a - b);
    const [method, ...rest] = key.split(" ");
    const route = rest.join(" ");
    const errors = arr.filter((s) => (s.status ?? 0) >= 400).length;
    out.push({
      key,
      method,
      route,
      count: arr.length,
      p50: pct(durations, 0.5),
      p95: pct(durations, 0.95),
      max: durations[durations.length - 1] ?? 0,
      errorRate: arr.length === 0 ? 0 : errors / arr.length,
    });
  }
  out.sort((a, b) => b.count - a.count || b.p95 - a.p95);
  return out;
}

export function pct(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
  return sorted[idx];
}

/** Top-N slowest requests by duration_ns. Non-HTTP rows are filtered out. */
export function topSlow(samples: HTTPSample[], n = 10): HTTPSample[] {
  return samples
    .filter((s) => s.durationNs > 0 && (s.method || s.route || s.path))
    .sort((a, b) => b.durationNs - a.durationNs)
    .slice(0, n);
}

export interface EndpointComparison {
  key: string;
  method: string;
  route: string;
  captureCount: number;
  capturedP95: number;
  replayCount: number;
  replayedP95: number;
  /** null when either side has no data. */
  deltaPct: number | null;
}

/**
 * Join capture + replay rollups on (method, route) so the UI can show
 * "was this route slower under replay?". Routes only present on one
 * side get deltaPct=null — they're still surfaced so we don't hide
 * capture routes that didn't replay (or vice versa).
 */
export function compareCaptureVsReplay(
  captured: HTTPSample[],
  replayed: HTTPSample[],
): EndpointComparison[] {
  const capKey = new Map<string, HTTPSample[]>();
  for (const s of captured) {
    const method = s.method ?? "-";
    const route = s.route || s.path || "-";
    const k = `${method} ${route}`;
    const arr = capKey.get(k);
    if (arr) arr.push(s);
    else capKey.set(k, [s]);
  }
  const repKey = new Map<string, HTTPSample[]>();
  for (const s of replayed) {
    const method = s.method ?? "-";
    const route = s.route || s.path || "-";
    const k = `${method} ${route}`;
    const arr = repKey.get(k);
    if (arr) arr.push(s);
    else repKey.set(k, [s]);
  }

  const keys = new Set<string>([...capKey.keys(), ...repKey.keys()]);
  const out: EndpointComparison[] = [];
  for (const key of keys) {
    const cap = capKey.get(key) ?? [];
    const rep = repKey.get(key) ?? [];
    const [method, ...rest] = key.split(" ");
    const route = rest.join(" ");
    const capDurs = cap
      .map((s) => s.durationNs)
      .filter((n) => n > 0)
      .sort((a, b) => a - b);
    const repDurs = rep
      .map((s) => s.durationNs)
      .filter((n) => n > 0)
      .sort((a, b) => a - b);
    const capP95 = pct(capDurs, 0.95);
    const repP95 = pct(repDurs, 0.95);
    let deltaPct: number | null = null;
    if (capP95 > 0 && repP95 > 0) {
      deltaPct = ((repP95 - capP95) / capP95) * 100;
    }
    out.push({
      key,
      method,
      route,
      captureCount: cap.length,
      capturedP95: capP95,
      replayCount: rep.length,
      replayedP95: repP95,
      deltaPct,
    });
  }
  // Biggest regressions first; then routes only present on one side;
  // then by count desc.
  out.sort((a, b) => {
    const aD = a.deltaPct ?? -Infinity;
    const bD = b.deltaPct ?? -Infinity;
    if (aD !== bD) return bD - aD;
    return b.replayCount + b.captureCount - (a.replayCount + a.captureCount);
  });
  return out;
}
