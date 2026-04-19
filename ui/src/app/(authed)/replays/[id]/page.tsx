"use client";

import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { use, useMemo } from "react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Code } from "@/components/ui/code";
import { PageHeader } from "@/components/page-header";
import { StatusPill } from "@/components/ui/status-pill";
import { Table, TD, TH, THead, TRow } from "@/components/ui/table";
import { useWsTopic } from "@/lib/hooks/use-ws-topic";
import { api, type EventView, type Replay } from "@/lib/api";
import {
  compareCaptureVsReplay,
  rollupByEndpoint,
  topSlow,
  type HTTPSample,
} from "@/lib/stats";
import { cn, nsToMs, relativeTime } from "@/lib/utils";

interface ProgressSnapshot {
  status: string;
  events_dispatched: number;
  events_failed: number;
  events_backpressured: number;
  observed_at_ns: number;
}

export default function ReplayDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const qc = useQueryClient();

  const replay = useQuery({
    queryKey: ["replay", id],
    queryFn: () => api.getReplay(id),
    // Refetch eagerly while running, slow down once finished.
    refetchInterval: (q) => {
      const s = q.state.data?.status;
      if (s === "running" || s === "pending") return 2_000;
      return false;
    },
  });

  const events = useQuery({
    queryKey: ["replay-events", id],
    // Fetch a big page so the timeline + rollups cover every replayed
    // request. ClickHouse reads here are cheap and the panel caps
    // rendering internally.
    queryFn: () => api.replayEvents(id, 5_000),
    refetchInterval: (q) => {
      const status = replay.data?.status;
      if (status === "running" || status === "pending") return 2_000;
      const seen = q.state.data?.count ?? 0;
      const dispatched = replay.data?.events_dispatched ?? 0;
      if (status === "completed" && seen < dispatched) return 2_000;
      return false;
    },
  });

  // Source session's captured events — needed for the capture-vs-replay
  // regression comparison + feeds into the event drawer when drilling
  // down. Scoped to the source session on the replay row; only fetched
  // once we know which session it is.
  const sourceId = replay.data?.source_session_id;
  const capturedEvents = useQuery({
    queryKey: ["session-events", sourceId],
    queryFn: () => api.sessionEvents(sourceId!, 5_000),
    enabled: !!sourceId,
  });

  // Live progress via the hub. Only subscribe to `replay.<id>.progress`
  // while the replay might still be live.
  const liveTopic =
    replay.data?.status === "running" || replay.data?.status === "pending"
      ? `replay.${id}.progress`
      : null;
  const progress = useWsTopic<ProgressSnapshot>(liveTopic);

  const cancel = useMutation({
    mutationFn: () => api.cancelReplay(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["replay", id] }),
  });

  // Prefer the live snapshot's counters over the last REST fetch while the
  // replay is running. The scheduler pushes every 250ms so the UI stays
  // under the "live view: < 1s latency" bar.
  const counters = useMemo(() => {
    if (progress && progress.status !== "finished") {
      return {
        dispatched: progress.events_dispatched,
        failed: progress.events_failed,
        backpressured: progress.events_backpressured,
      };
    }
    if (replay.data) {
      return {
        dispatched: replay.data.events_dispatched,
        failed: replay.data.events_failed,
        backpressured: replay.data.events_backpressured,
      };
    }
    return { dispatched: 0, failed: 0, backpressured: 0 };
  }, [progress, replay.data]);

  const r = replay.data;
  return (
    <>
      <PageHeader
        title={r?.label || r?.id || id}
        description={<span>Replay of session {r ? r.source_session_id : "…"}</span> as unknown as string}
        actions={
          r && (r.status === "running" || r.status === "pending") ? (
            <Button
              variant="danger"
              size="sm"
              onClick={() => cancel.mutate()}
              disabled={cancel.isPending}
            >
              {cancel.isPending ? "Cancelling…" : "Cancel"}
            </Button>
          ) : null
        }
      />
      <div className="space-y-4 p-6">
        {replay.isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : !r ? (
          <p className="text-sm text-danger">Replay not found.</p>
        ) : (
          <>
            <div className="grid gap-3 md:grid-cols-4">
              <Stat label="Status">
                <div className="flex items-center gap-2">
                  <StatusPill status={r.status} />
                  {progress ? (
                    <span className="text-xs text-muted-foreground">live</span>
                  ) : null}
                </div>
              </Stat>
              <Stat label="Dispatched" value={counters.dispatched.toLocaleString()} />
              <Stat label="Failed" value={counters.failed.toLocaleString()} />
              <Stat
                label="Backpressured"
                value={counters.backpressured.toLocaleString()}
              />
            </div>
            <div className="grid gap-3 md:grid-cols-4">
              <Stat label="Speedup" value={`${r.speedup}×`} />
              <Stat label="Target" value={r.target_url} />
              <Stat
                label="p95"
                value={r.p95_latency_ms != null ? `${r.p95_latency_ms.toFixed(1)} ms` : "—"}
              />
              <Stat
                label="Max lag"
                value={r.max_lag_ms != null ? `${r.max_lag_ms.toFixed(1)} ms` : "—"}
              />
            </div>

            <Card>
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-semibold">Meta</h2>
                <Link
                  href={`/replays/${id}/db`}
                  className="text-xs text-accent hover:underline"
                >
                  DB observations →
                </Link>
              </div>
              <div className="mt-3 grid gap-y-2 text-sm md:grid-cols-2">
                <MetaRow label="ID" value={<Code>{r.id}</Code>} />
                <MetaRow label="Source session" value={<Link className="hover:underline" href={`/sessions/${r.source_session_id}`}>{r.source_session_id}</Link>} />
                <MetaRow label="Started" value={relativeTime(r.started_at)} />
                <MetaRow
                  label="Finished"
                  value={r.finished_at ? relativeTime(r.finished_at) : "—"}
                />
                {r.error_message ? (
                  <MetaRow
                    label="Error"
                    value={<span className="text-danger">{r.error_message}</span>}
                  />
                ) : null}
              </div>
            </Card>

            <TimelinePanel
              events={events.data?.events ?? []}
              replay={r}
            />
            <ByEndpointPanel rows={events.data?.events ?? []} />
            <CaptureVsReplayPanel
              captured={capturedEvents.data?.events ?? []}
              replayed={events.data?.events ?? []}
              sourceId={r.source_session_id}
            />
            <SlowestPanel rows={events.data?.events ?? []} />
            <EventsPanel rows={events.data?.events ?? []} note={events.data?.note} />
          </>
        )}
      </div>
    </>
  );
}

function Stat({ label, value, children }: { label: string; value?: string; children?: React.ReactNode }) {
  return (
    <Card>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 truncate text-lg font-semibold">{children ?? value}</div>
    </Card>
  );
}

function MetaRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-baseline gap-3">
      <span className="w-32 shrink-0 text-xs uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      <span className="min-w-0 break-all font-mono text-xs">{value}</span>
    </div>
  );
}

// Convert a replay event row to the shared HTTPSample shape used by stats.ts.
type ReplayEventRow = {
  EventID: string;
  HTTPMethod: string;
  HTTPPath: string;
  HTTPRoute: string;
  ResponseStatus: number;
  ResponseDurationNs: number;
  ActualFireNs: number;
  LagNs: number;
  ErrorCode: string;
};
function replayToSample(r: ReplayEventRow): HTTPSample {
  return {
    method: r.HTTPMethod,
    route: r.HTTPRoute,
    path: r.HTTPPath,
    durationNs: r.ResponseDurationNs,
    status: r.ResponseStatus,
  };
}

/**
 * Timeline panel. Buckets events by ActualFireNs across the replay
 * window and renders p95 duration per bucket as a sparkline, overlaid
 * with an error-rate heatband. Gives you "requests were fast at the
 * start, then p95 spiked around 2:30" at a glance.
 */
function TimelinePanel({
  events,
  replay: r,
}: {
  events: ReplayEventRow[];
  replay: Replay;
}) {
  const buckets = useMemo(() => {
    if (events.length === 0) return [];
    const ns = events
      .map((e) => e.ActualFireNs)
      .filter((n) => n > 0);
    if (ns.length === 0) return [];
    const minNs = Math.min(...ns);
    const maxNs = Math.max(...ns);
    const spanNs = Math.max(maxNs - minNs, 1);
    const n = Math.min(40, Math.max(8, Math.floor(events.length / 10)));
    const bucketNs = spanNs / n;
    type Bucket = {
      index: number;
      fromNs: number;
      count: number;
      errors: number;
      durations: number[];
    };
    const arr: Bucket[] = Array.from({ length: n }, (_, i) => ({
      index: i,
      fromNs: minNs + i * bucketNs,
      count: 0,
      errors: 0,
      durations: [],
    }));
    for (const e of events) {
      if (!e.ActualFireNs) continue;
      const idx = Math.min(
        n - 1,
        Math.floor((e.ActualFireNs - minNs) / bucketNs),
      );
      arr[idx].count++;
      if (e.ResponseStatus >= 400 || e.ErrorCode) arr[idx].errors++;
      if (e.ResponseDurationNs > 0) arr[idx].durations.push(e.ResponseDurationNs);
    }
    return arr.map((b) => {
      const sorted = b.durations.sort((a, b) => a - b);
      const p95 =
        sorted.length > 0
          ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))]
          : 0;
      const max = sorted.length > 0 ? sorted[sorted.length - 1] : 0;
      return {
        ...b,
        p95,
        max,
        errorRate: b.count === 0 ? 0 : b.errors / b.count,
        offsetSec: (b.fromNs - minNs) / 1e9,
      };
    });
  }, [events]);

  if (buckets.length === 0) {
    return null;
  }
  const maxP95 = Math.max(...buckets.map((b) => b.p95), 1);
  const totalSec =
    (buckets[buckets.length - 1].offsetSec || 0) +
    (buckets.length > 1
      ? buckets[1].offsetSec - buckets[0].offsetSec
      : 0);
  return (
    <Card>
      <div className="mb-3 flex items-baseline justify-between">
        <div>
          <h2 className="text-sm font-semibold">Timeline</h2>
          <p className="text-xs text-muted-foreground">
            p95 response time per {r.speedup}× compressed bucket.
            Hover a bar to see bucket stats.
          </p>
        </div>
        <div className="text-xs text-muted-foreground">
          {totalSec > 0 ? `${totalSec.toFixed(1)}s total` : ""} ·{" "}
          {events.length} events
        </div>
      </div>
      <div className="flex h-32 items-end gap-0.5">
        {buckets.map((b) => {
          const height = maxP95 > 0 ? (b.p95 / maxP95) * 100 : 0;
          const errorBand = b.errorRate * 100;
          return (
            <div
              key={b.index}
              className="group relative flex flex-1 flex-col-reverse"
              title={`+${b.offsetSec.toFixed(1)}s · ${b.count} req · p95 ${nsToMs(b.p95)} · err ${(b.errorRate * 100).toFixed(0)}%`}
            >
              <div
                className="w-full rounded-sm bg-accent/60 transition group-hover:bg-accent"
                style={{ height: `${height}%` }}
              />
              {b.errorRate > 0 && (
                <div
                  className="w-full rounded-sm bg-danger/70"
                  style={{ height: `${Math.min(errorBand, 15)}%` }}
                />
              )}
            </div>
          );
        })}
      </div>
      <div className="mt-2 flex items-center justify-between text-xs text-muted-foreground">
        <span>t=0s</span>
        <span>
          max p95 in window:{" "}
          <span className="font-mono text-foreground">
            {nsToMs(maxP95)}
          </span>
        </span>
        <span>
          t=
          {totalSec > 0 ? `${totalSec.toFixed(1)}s` : "?"}
        </span>
      </div>
    </Card>
  );
}

function ByEndpointPanel({ rows }: { rows: ReplayEventRow[] }) {
  const rollup = useMemo(
    () => rollupByEndpoint(rows.map(replayToSample)),
    [rows],
  );
  if (rollup.length === 0) return null;
  return (
    <div>
      <h2 className="mb-2 text-sm font-semibold">By endpoint</h2>
      <Table>
        <THead>
          <TRow>
            <TH>Method</TH>
            <TH>Route</TH>
            <TH className="text-right">Count</TH>
            <TH className="text-right">p50</TH>
            <TH className="text-right">p95</TH>
            <TH className="text-right">Max</TH>
            <TH className="text-right">Error rate</TH>
          </TRow>
        </THead>
        <tbody>
          {rollup.map((r) => (
            <TRow key={r.key}>
              <TD className="font-mono">{r.method}</TD>
              <TD className="max-w-[300px] truncate font-mono text-xs">
                {r.route}
              </TD>
              <TD className="text-right font-mono">{r.count}</TD>
              <TD className="text-right font-mono">
                {r.p50 ? nsToMs(r.p50) : "—"}
              </TD>
              <TD className="text-right font-mono">
                {r.p95 ? nsToMs(r.p95) : "—"}
              </TD>
              <TD className="text-right font-mono">
                {r.max ? nsToMs(r.max) : "—"}
              </TD>
              <TD
                className={cn(
                  "text-right font-mono",
                  r.errorRate > 0 ? "text-danger" : "",
                )}
              >
                {r.errorRate === 0
                  ? "—"
                  : `${(r.errorRate * 100).toFixed(0)}%`}
              </TD>
            </TRow>
          ))}
        </tbody>
      </Table>
    </div>
  );
}

function CaptureVsReplayPanel({
  captured,
  replayed,
  sourceId,
}: {
  captured: EventView[];
  replayed: ReplayEventRow[];
  sourceId: string;
}) {
  const rows = useMemo(() => {
    const capSamples: HTTPSample[] = captured.map((e) => ({
      method: e.http_method,
      route: e.http_route,
      path: e.http_path,
      durationNs: e.duration_ns ?? 0,
      status: e.http_status,
    }));
    const repSamples = replayed.map(replayToSample);
    return compareCaptureVsReplay(capSamples, repSamples);
  }, [captured, replayed]);

  if (rows.length === 0) return null;

  return (
    <div>
      <div className="mb-2 flex items-baseline justify-between">
        <h2 className="text-sm font-semibold">Capture vs replay</h2>
        <Link
          href={`/sessions/${sourceId}`}
          className="text-xs text-accent hover:underline"
        >
          Source session →
        </Link>
      </div>
      <p className="mb-2 text-xs text-muted-foreground">
        Per-route p95 at capture time vs at replay time. Positive ∆ means
        the route got slower under replay load.
      </p>
      <Table>
        <THead>
          <TRow>
            <TH>Method</TH>
            <TH>Route</TH>
            <TH className="text-right">Capture</TH>
            <TH className="text-right">Replay</TH>
            <TH className="text-right">∆ p95</TH>
            <TH className="text-right">Count (cap/rep)</TH>
          </TRow>
        </THead>
        <tbody>
          {rows.slice(0, 30).map((r) => (
            <TRow key={r.key}>
              <TD className="font-mono">{r.method}</TD>
              <TD className="max-w-[280px] truncate font-mono text-xs">
                {r.route}
              </TD>
              <TD className="text-right font-mono">
                {r.capturedP95 ? nsToMs(r.capturedP95) : "—"}
              </TD>
              <TD className="text-right font-mono">
                {r.replayedP95 ? nsToMs(r.replayedP95) : "—"}
              </TD>
              <TD
                className={cn(
                  "text-right font-mono",
                  r.deltaPct === null
                    ? "text-muted-foreground"
                    : r.deltaPct > 20
                    ? "text-danger"
                    : r.deltaPct > 5
                    ? "text-warning"
                    : r.deltaPct < -5
                    ? "text-success"
                    : "text-muted-foreground",
                )}
              >
                {r.deltaPct === null
                  ? "—"
                  : `${r.deltaPct >= 0 ? "+" : ""}${r.deltaPct.toFixed(0)}%`}
              </TD>
              <TD className="text-right font-mono text-muted-foreground">
                {r.captureCount}/{r.replayCount}
              </TD>
            </TRow>
          ))}
        </tbody>
      </Table>
    </div>
  );
}

function SlowestPanel({ rows }: { rows: ReplayEventRow[] }) {
  const top = useMemo(() => topSlow(rows.map(replayToSample), 10), [rows]);
  if (top.length === 0) return null;
  return (
    <div>
      <h2 className="mb-2 text-sm font-semibold">Top 10 slowest</h2>
      <Table>
        <THead>
          <TRow>
            <TH>#</TH>
            <TH>Method</TH>
            <TH>Route</TH>
            <TH className="text-right">Status</TH>
            <TH className="text-right">Duration</TH>
          </TRow>
        </THead>
        <tbody>
          {top.map((s, i) => (
            <TRow key={i}>
              <TD className="font-mono text-muted-foreground">{i + 1}</TD>
              <TD className="font-mono">{s.method ?? "—"}</TD>
              <TD className="max-w-[300px] truncate font-mono text-xs">
                {s.route || s.path || "—"}
              </TD>
              <TD
                className={cn(
                  "text-right font-mono",
                  (s.status ?? 0) >= 400 ? "text-danger" : "",
                )}
              >
                {s.status ?? "—"}
              </TD>
              <TD className="text-right font-mono">{nsToMs(s.durationNs)}</TD>
            </TRow>
          ))}
        </tbody>
      </Table>
    </div>
  );
}

function EventsPanel({
  rows,
  note,
}: {
  rows: ReplayEventRow[];
  note?: string;
}) {
  return (
    <div>
      <h2 className="mb-2 text-sm font-semibold">Per-event results (latest {rows.length})</h2>
      {note ? <p className="mb-2 text-xs text-muted-foreground">{note}</p> : null}
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No per-event rows yet — the engine writes these once the replay has started.
        </p>
      ) : (
        <Table>
          <THead>
            <TRow>
              <TH>Method</TH>
              <TH>Route</TH>
              <TH className="text-right">Status</TH>
              <TH className="text-right">Duration</TH>
              <TH className="text-right">Lag</TH>
              <TH>Error</TH>
            </TRow>
          </THead>
          <tbody>
            {rows.map((r) => (
              <TRow key={r.EventID}>
                <TD className="font-mono">{r.HTTPMethod}</TD>
                <TD className="max-w-[240px] truncate font-mono text-xs">
                  {r.HTTPRoute || r.HTTPPath}
                </TD>
                <TD className="text-right font-mono">{r.ResponseStatus}</TD>
                <TD className="text-right font-mono">{nsToMs(r.ResponseDurationNs)}</TD>
                <TD className="text-right font-mono">{nsToMs(r.LagNs)}</TD>
                <TD className="font-mono text-xs text-danger">{r.ErrorCode}</TD>
              </TRow>
            ))}
          </tbody>
        </Table>
      )}
    </div>
  );
}
