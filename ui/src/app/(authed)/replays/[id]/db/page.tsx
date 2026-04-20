"use client";

import { useQuery } from "@tanstack/react-query";
import { useMemo, useState, use } from "react";

import { Card, CardTitle } from "@/components/ui/card";
import { Code } from "@/components/ui/code";
import { PageHeader } from "@/components/page-header";
import { Table, TD, TH, THead, TRow } from "@/components/ui/table";
import { api, type RuntimePoint } from "@/lib/api";

export default function ReplayDbPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toggle = (key: string): void => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const topSlow = useQuery({
    queryKey: ["db-top-slow", id],
    queryFn: () => api.dbTopSlow(id, 20),
    retry: 1,
  });
  const byEndpoint = useQuery({
    queryKey: ["db-by-endpoint", id],
    queryFn: () => api.dbByEndpoint(id, 20),
    retry: 1,
  });
  const deadlocks = useQuery({
    queryKey: ["db-deadlocks", id],
    queryFn: () => api.dbDeadlocks(id, 20),
    retry: 1,
  });
  const runtime = useQuery({
    queryKey: ["runtime-summary", id],
    queryFn: () => api.runtimeSummary(id),
    retry: 1,
  });
  const runtimeSamples = useQuery({
    queryKey: ["runtime-samples", id],
    queryFn: () => api.runtimeSamples(id),
    retry: 1,
  });

  const unavailable =
    topSlow.error || byEndpoint.error || deadlocks.error ? true : false;

  return (
    <>
      <PageHeader
        title="DB observations"
        description={`Slow queries + lock waits captured during replay ${id}`}
      />
      <div className="space-y-4 p-6">
        {unavailable ? (
          <Card>
            <CardTitle>DB observer unavailable</CardTitle>
            <p className="mt-2 text-sm text-muted-foreground">
              The engine reported no ClickHouse DSN (or no observations are
              present for this replay yet). Start the observer with
              <Code>{" clearvoiance-observer run --clickhouse-dsn "}</Code>
              and make sure the SUT&apos;s Postgres driver is wrapped with
              <Code>{" instrumentPg "}</Code> so queries carry
              <Code>{"clv:<event_id>"}</Code> in <code>application_name</code>.
            </p>
          </Card>
        ) : null}

        {runtime.data && runtime.data.samples > 0 ? (
          <section>
            <h2 className="mb-2 text-sm font-semibold">Runtime</h2>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <StatCard
                label="Peak RSS"
                value={formatBytes(runtime.data.mem_rss_peak)}
                hint={`min ${formatBytes(runtime.data.mem_rss_min)}`}
              />
              <StatCard
                label="Event loop p99 peak"
                value={`${runtime.data.event_loop_p99_peak_ms.toFixed(1)} ms`}
                hint={runtime.data.event_loop_p99_peak_ms > 100 ? "starved" : "healthy"}
              />
              <StatCard
                label="Pool saturated"
                value={`${runtime.data.pool_saturated_sec.toFixed(1)} s`}
                hint={
                  runtime.data.pool_max > 0
                    ? `max ${runtime.data.pool_max} conns`
                    : "pool stats unavailable"
                }
              />
              <StatCard
                label="GC pause total"
                value={`${runtime.data.gc_total_pause_ms.toFixed(0)} ms`}
                hint={`${runtime.data.samples} samples`}
              />
            </div>
            {runtimeSamples.data && runtimeSamples.data.points.length > 1 ? (
              <RuntimeCharts points={runtimeSamples.data.points} />
            ) : null}
          </section>
        ) : null}

        <section>
          <h2 className="mb-2 text-sm font-semibold">Top slow queries</h2>
          {topSlow.data && topSlow.data.rows.length > 0 ? (
            <Table>
              <THead>
                <TRow>
                  <TH className="w-6"></TH>
                  <TH>Type</TH>
                  <TH>Fingerprint</TH>
                  <TH className="max-w-[360px]">Query</TH>
                  <TH className="text-right">Count</TH>
                  <TH className="text-right">Avg ms</TH>
                  <TH className="text-right">p95 ms</TH>
                  <TH className="text-right">Max ms</TH>
                </TRow>
              </THead>
              <tbody>
                {topSlow.data.rows.map((r) => {
                  const key = r.query_fingerprint + r.observation_type;
                  const open = expanded.has(key);
                  return (
                    <>
                      <TRow
                        key={key}
                        onClick={() => toggle(key)}
                        className="cursor-pointer hover:bg-muted/40"
                      >
                        <TD className="text-muted-foreground">{open ? "▾" : "▸"}</TD>
                        <TD className="capitalize text-muted-foreground">
                          {r.observation_type.replace("_", " ")}
                        </TD>
                        <TD className="font-mono text-xs">
                          {r.query_fingerprint.slice(0, 10)}
                        </TD>
                        <TD className="max-w-[360px] truncate font-mono text-xs text-muted-foreground">
                          {r.query_text}
                        </TD>
                        <TD className="text-right font-mono">{r.occurrences}</TD>
                        <TD className="text-right font-mono">{r.avg_ms.toFixed(1)}</TD>
                        <TD className="text-right font-mono">{r.p95_ms.toFixed(1)}</TD>
                        <TD className="text-right font-mono">{r.max_ms.toFixed(1)}</TD>
                      </TRow>
                      {open ? (
                        <TRow key={`${key}-details`} className="bg-muted/20">
                          <TD colSpan={8}>
                            <div className="space-y-2 py-2">
                              <div>
                                <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
                                  Full query
                                </p>
                                <pre className="mt-1 overflow-x-auto whitespace-pre-wrap break-all rounded border bg-background p-3 font-mono text-xs">
                                  {r.query_text}
                                </pre>
                              </div>
                              <div className="flex flex-wrap gap-4 text-xs text-muted-foreground">
                                <span>
                                  Fingerprint{" "}
                                  <span className="font-mono">{r.query_fingerprint}</span>
                                </span>
                                <span>
                                  First example event{" "}
                                  <span className="font-mono">{r.event_id}</span>
                                </span>
                                <span>
                                  First observed{" "}
                                  <span className="font-mono">
                                    {new Date(r.first_observed_at).toLocaleString()}
                                  </span>
                                </span>
                              </div>
                            </div>
                          </TD>
                        </TRow>
                      ) : null}
                    </>
                  );
                })}
              </tbody>
            </Table>
          ) : (
            <p className="text-sm text-muted-foreground">No slow queries observed.</p>
          )}
        </section>

        <section>
          <h2 className="mb-2 text-sm font-semibold">DB time by endpoint</h2>
          {byEndpoint.data && byEndpoint.data.rows.length > 0 ? (
            <Table>
              <THead>
                <TRow>
                  <TH>Method</TH>
                  <TH>Route</TH>
                  <TH className="text-right">Observations</TH>
                  <TH className="text-right">Total DB ms</TH>
                  <TH className="text-right">Avg ms</TH>
                  <TH className="text-right">Max ms</TH>
                </TRow>
              </THead>
              <tbody>
                {byEndpoint.data.rows.map((r, i) => (
                  <TRow key={i}>
                    <TD className="font-mono">{r.http_method}</TD>
                    <TD className="font-mono text-xs">{r.http_route}</TD>
                    <TD className="text-right font-mono">{r.observations}</TD>
                    <TD className="text-right font-mono">{r.total_db_ms.toFixed(1)}</TD>
                    <TD className="text-right font-mono">{r.avg_ms.toFixed(1)}</TD>
                    <TD className="text-right font-mono">{r.max_ms.toFixed(1)}</TD>
                  </TRow>
                ))}
              </tbody>
            </Table>
          ) : (
            <p className="text-sm text-muted-foreground">
              No endpoint rollup available — usually means the observer hasn&apos;t
              seen correlated events for this replay yet.
            </p>
          )}
        </section>

        <section>
          <h2 className="mb-2 text-sm font-semibold">Lock waits</h2>
          {deadlocks.data?.note ? (
            <p className="mb-2 text-xs text-muted-foreground">{deadlocks.data.note}</p>
          ) : null}
          {deadlocks.data && deadlocks.data.rows.length > 0 ? (
            <Table>
              <THead>
                <TRow>
                  <TH>Fingerprint</TH>
                  <TH>Wait event</TH>
                  <TH className="max-w-[360px]">Query</TH>
                  <TH className="text-right">Count</TH>
                  <TH className="text-right">Avg ms</TH>
                  <TH className="text-right">Max ms</TH>
                </TRow>
              </THead>
              <tbody>
                {deadlocks.data.rows.map((r, i) => (
                  <TRow key={i}>
                    <TD className="font-mono text-xs">
                      {r.query_fingerprint.slice(0, 10)}
                    </TD>
                    <TD className="font-mono text-xs">
                      {r.wait_event_type}:{r.wait_event}
                    </TD>
                    <TD className="max-w-[360px] truncate font-mono text-xs text-muted-foreground">
                      {r.query_text}
                    </TD>
                    <TD className="text-right font-mono">{r.occurrences}</TD>
                    <TD className="text-right font-mono">{r.avg_ms.toFixed(1)}</TD>
                    <TD className="text-right font-mono">{r.max_ms.toFixed(1)}</TD>
                  </TRow>
                ))}
              </tbody>
            </Table>
          ) : (
            <p className="text-sm text-muted-foreground">No lock waits observed.</p>
          )}
        </section>
      </div>
    </>
  );
}

function StatCard({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <div className="rounded-md border bg-card px-3 py-2">
      <p className="text-xs uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="mt-1 font-mono text-lg">{value}</p>
      {hint ? (
        <p className="text-xs text-muted-foreground">{hint}</p>
      ) : null}
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (!bytes) return "—";
  const units = ["B", "KB", "MB", "GB"];
  let v = bytes;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u += 1;
  }
  return `${v.toFixed(v >= 10 ? 0 : 1)} ${units[u]}`;
}

/**
 * Three stacked sparklines from the per-tick runtime samples: RSS (bytes),
 * event-loop p99 (ns), DB pool utilisation (%). Hand-rolled SVG so we don't
 * pull a charting lib for one page.
 */
function RuntimeCharts({ points }: { points: RuntimePoint[] }): React.ReactElement {
  const series = useMemo(() => {
    const rss = points.map((p) => p.mem_rss);
    const heap = points.map((p) => p.mem_heap_used);
    const ell = points.map((p) => p.event_loop_p99_ns);
    const poolPct = points.map((p) =>
      p.db_pool_max > 0 ? (p.db_pool_used / p.db_pool_max) * 100 : 0,
    );
    const poolPending = points.map((p) => p.db_pool_pending);
    return { rss, heap, ell, poolPct, poolPending };
  }, [points]);

  return (
    <div className="mt-3 grid gap-3 lg:grid-cols-3">
      <Chart
        title="Memory (RSS / heap)"
        unit="MB"
        primary={series.rss}
        secondary={series.heap}
        primaryLabel="RSS"
        secondaryLabel="heap used"
        format={(v) => `${(v / 1024 / 1024).toFixed(0)} MB`}
      />
      <Chart
        title="Event loop p99 lag"
        unit="ms"
        primary={series.ell}
        primaryLabel="p99"
        format={(v) => `${(v / 1e6).toFixed(1)} ms`}
        warnThreshold={100_000_000}
      />
      <Chart
        title="DB pool usage"
        unit="%"
        primary={series.poolPct}
        secondary={series.poolPending.map((n) => Math.min(n * 10, 100))}
        primaryLabel="used %"
        secondaryLabel="pending (×10)"
        format={(v) => `${v.toFixed(0)}%`}
        warnThreshold={90}
      />
    </div>
  );
}

function Chart({
  title,
  primary,
  secondary,
  primaryLabel,
  secondaryLabel,
  format,
  warnThreshold,
}: {
  title: string;
  unit: string;
  primary: number[];
  secondary?: number[];
  primaryLabel: string;
  secondaryLabel?: string;
  format: (v: number) => string;
  warnThreshold?: number;
}): React.ReactElement {
  const peak = Math.max(...primary, ...(secondary ?? [0]), 1);
  const latest = primary[primary.length - 1] ?? 0;
  const w = 100;
  const h = 40;
  const toPath = (vals: number[]): string => {
    if (vals.length === 0) return "";
    return vals
      .map((v, i) => {
        const x = (i / Math.max(vals.length - 1, 1)) * w;
        const y = h - (v / peak) * h;
        return `${i === 0 ? "M" : "L"}${x.toFixed(2)},${y.toFixed(2)}`;
      })
      .join(" ");
  };
  const warn = warnThreshold !== undefined && peak >= warnThreshold;

  return (
    <div className="rounded-md border bg-card p-3">
      <div className="flex items-center justify-between">
        <p className="text-xs font-semibold">{title}</p>
        <p
          className={`font-mono text-xs ${warn ? "text-danger" : "text-muted-foreground"}`}
        >
          now {format(latest)} · peak {format(peak)}
        </p>
      </div>
      <svg viewBox={`0 0 ${w} ${h}`} className="mt-2 h-16 w-full" preserveAspectRatio="none">
        {secondary ? (
          <path
            d={toPath(secondary)}
            fill="none"
            stroke="currentColor"
            strokeOpacity={0.35}
            strokeWidth={0.8}
            vectorEffect="non-scaling-stroke"
          />
        ) : null}
        <path
          d={toPath(primary)}
          fill="none"
          stroke={warn ? "var(--danger)" : "var(--accent)"}
          strokeWidth={1.2}
          vectorEffect="non-scaling-stroke"
        />
      </svg>
      <p className="mt-1 text-[10px] text-muted-foreground">
        {primaryLabel}
        {secondaryLabel ? ` · ${secondaryLabel} (faint)` : ""}
      </p>
    </div>
  );
}
