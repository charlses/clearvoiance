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
import { api } from "@/lib/api";
import { nsToMs, relativeTime } from "@/lib/utils";

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
    queryFn: () => api.replayEvents(id, 50),
    // Refresh on transition out of running.
    enabled: replay.data?.status !== "pending",
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

function EventsPanel({
  rows,
  note,
}: {
  rows: Array<{
    EventID: string;
    HTTPMethod: string;
    HTTPPath: string;
    HTTPRoute: string;
    ResponseStatus: number;
    ResponseDurationNs: number;
    LagNs: number;
    ErrorCode: string;
  }>;
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
