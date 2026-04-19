"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { PlayCircle } from "lucide-react";
import React, { use, useState } from "react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Code } from "@/components/ui/code";
import { PageHeader } from "@/components/page-header";
import { StatusPill } from "@/components/ui/status-pill";
import { Table, TD, TH, THead, TRow } from "@/components/ui/table";
import { api } from "@/lib/api";
import { cn, fmtBytes, nsToMs, relativeTime } from "@/lib/utils";

export default function SessionDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const qc = useQueryClient();

  const session = useQuery({
    queryKey: ["session", id],
    queryFn: () => api.getSession(id),
    refetchInterval: (q) =>
      q.state.data?.status === "active" ? 2_000 : false,
  });

  const events = useQuery({
    queryKey: ["session-events", id],
    queryFn: () => api.sessionEvents(id, 50),
  });

  const stop = useMutation({
    mutationFn: () => api.stopSession(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["session", id] }),
  });

  const s = session.data;
  return (
    <>
      <PageHeader
        title={s?.name ?? id}
        description={<Code>{id}</Code> as unknown as string}
        actions={
          s?.status === "active" ? (
            <Button
              variant="danger"
              size="sm"
              onClick={() => stop.mutate()}
              disabled={stop.isPending}
            >
              {stop.isPending ? "Stopping…" : "Stop capture"}
            </Button>
          ) : s?.status === "stopped" ? (
            <Link href={`/replays/new?source=${id}`}>
              <Button size="sm">
                <PlayCircle className="mr-1 h-4 w-4" /> Replay
              </Button>
            </Link>
          ) : null
        }
      />
      <div className="space-y-4 p-6">
        {session.isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : !s ? (
          <p className="text-sm text-danger">Session not found.</p>
        ) : (
          <>
            <div className="grid gap-3 md:grid-cols-4">
              <Stat label="Status">
                <StatusPill status={s.status} />
              </Stat>
              <Stat label="Events" value={s.events_captured.toLocaleString()} />
              <Stat label="Bytes" value={fmtBytes(s.bytes_captured)} />
              <Stat label="Started" value={relativeTime(s.started_at)} />
            </div>
            {Object.keys(s.labels).length > 0 && (
              <Card>
                <div className="text-xs text-muted-foreground">Labels</div>
                <div className="mt-2 flex flex-wrap gap-2">
                  {Object.entries(s.labels).map(([k, v]) => (
                    <Code key={k}>
                      {k}={v}
                    </Code>
                  ))}
                </div>
              </Card>
            )}
            <EventsPanel events={events.data?.events ?? []} note={events.data?.note} />
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
      <div className="mt-1 text-lg font-semibold">{children ?? value}</div>
    </Card>
  );
}

interface CapturedEvent {
  id: string;
  event_type: string;
  http_method?: string;
  http_path?: string;
  http_route?: string;
  http_status?: number;
  timestamp_ns: number;
  duration_ns?: number;
  request_headers?: Record<string, string[]>;
  response_headers?: Record<string, string[]>;
  request_body_preview?: string;
  request_body_size?: number;
  request_body_truncated?: boolean;
  response_body_preview?: string;
  response_body_size?: number;
  response_body_truncated?: boolean;
  source_ip?: string;
  user_id?: string;
}

function EventsPanel({
  events,
  note,
}: {
  events: CapturedEvent[];
  note?: string;
}) {
  const [view, setView] = useState<"list" | "by-endpoint">("list");
  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-sm font-semibold">
          Events (latest {events.length})
        </h2>
        {events.length > 0 && (
          <div className="flex gap-1 text-xs">
            <button
              type="button"
              onClick={() => setView("list")}
              className={cn(
                "rounded-md border px-2 py-1 transition",
                view === "list"
                  ? "border-accent/40 bg-accent/10 text-accent"
                  : "border-border text-muted-foreground hover:text-foreground",
              )}
            >
              List
            </button>
            <button
              type="button"
              onClick={() => setView("by-endpoint")}
              className={cn(
                "rounded-md border px-2 py-1 transition",
                view === "by-endpoint"
                  ? "border-accent/40 bg-accent/10 text-accent"
                  : "border-border text-muted-foreground hover:text-foreground",
              )}
            >
              By endpoint
            </button>
          </div>
        )}
      </div>
      {note ? (
        <p className="mb-2 text-xs text-muted-foreground">{note}</p>
      ) : null}
      {events.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No events yet, or the event store doesn&apos;t support reads (Noop mode).
        </p>
      ) : view === "list" ? (
        <EventsList events={events} />
      ) : (
        <EventsByEndpoint events={events} />
      )}
    </div>
  );
}

function EventsList({ events }: { events: CapturedEvent[] }) {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  return (
    <Table>
      <THead>
        <TRow>
          <TH />
          <TH>Type</TH>
          <TH>Method</TH>
          <TH>Path</TH>
          <TH className="text-right">Status</TH>
          <TH className="text-right">Duration</TH>
          <TH>ID</TH>
        </TRow>
      </THead>
      <tbody>
        {events.map((e) => {
          const open = expandedId === e.id;
          const toggle = () => setExpandedId(open ? null : e.id);
          return (
            <React.Fragment key={e.id}>
              <TRow
                className="cursor-pointer hover:bg-muted/30"
                onClick={toggle}
              >
                <TD className="w-6 text-muted-foreground">
                  {open ? "▾" : "▸"}
                </TD>
                <TD className="capitalize text-muted-foreground">
                  {e.event_type}
                </TD>
                <TD className="font-mono">{e.http_method ?? "—"}</TD>
                <TD className="font-mono text-xs">{e.http_path ?? "—"}</TD>
                <TD className="text-right font-mono">
                  {e.http_status ?? "—"}
                </TD>
                <TD className="text-right font-mono">
                  {e.duration_ns ? nsToMs(e.duration_ns) : "—"}
                </TD>
                <TD className="font-mono text-xs text-muted-foreground">
                  {e.id.slice(0, 12)}
                </TD>
              </TRow>
              {open && (
                <TRow>
                  <TD colSpan={7} className="bg-muted/10 p-4">
                    <EventDetails event={e} />
                  </TD>
                </TRow>
              )}
            </React.Fragment>
          );
        })}
      </tbody>
    </Table>
  );
}

function EventDetails({ event: e }: { event: CapturedEvent }) {
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <div>
        <div className="mb-1 flex items-baseline justify-between">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Request
          </h3>
          {e.source_ip ? (
            <span className="font-mono text-xs text-muted-foreground">
              from {e.source_ip}
            </span>
          ) : null}
        </div>
        {e.http_route && e.http_route !== e.http_path ? (
          <div className="mb-2 text-xs">
            <span className="text-muted-foreground">route template: </span>
            <span className="font-mono">{e.http_route}</span>
          </div>
        ) : null}
        <HeaderBlock label="Headers" headers={e.request_headers} />
        <BodyBlock
          label="Body"
          preview={e.request_body_preview}
          size={e.request_body_size}
          truncated={e.request_body_truncated}
        />
      </div>
      <div>
        <div className="mb-1 flex items-baseline justify-between">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Response
          </h3>
          <span className="font-mono text-xs">
            {e.http_status ?? "—"}{" "}
            {e.duration_ns ? `· ${nsToMs(e.duration_ns)}` : ""}
          </span>
        </div>
        <HeaderBlock label="Headers" headers={e.response_headers} />
        <BodyBlock
          label="Body"
          preview={e.response_body_preview}
          size={e.response_body_size}
          truncated={e.response_body_truncated}
        />
      </div>
    </div>
  );
}

function HeaderBlock({
  label,
  headers,
}: {
  label: string;
  headers?: Record<string, string[]>;
}) {
  const entries = headers ? Object.entries(headers) : [];
  return (
    <details open className="group mb-3 rounded-md border border-border">
      <summary className="cursor-pointer select-none px-3 py-2 text-xs font-medium text-muted-foreground group-open:border-b group-open:border-border">
        {label} ({entries.length})
      </summary>
      {entries.length === 0 ? (
        <div className="px-3 py-2 text-xs text-muted-foreground">—</div>
      ) : (
        <dl className="divide-y divide-border font-mono text-xs">
          {entries.map(([k, values]) => (
            <div key={k} className="flex gap-2 px-3 py-1.5">
              <dt className="shrink-0 text-muted-foreground">{k}:</dt>
              <dd className="min-w-0 break-all">{values.join(", ")}</dd>
            </div>
          ))}
        </dl>
      )}
    </details>
  );
}

function BodyBlock({
  label,
  preview,
  size,
  truncated,
}: {
  label: string;
  preview?: string;
  size?: number;
  truncated?: boolean;
}) {
  const hasBody = (size ?? 0) > 0;
  return (
    <details open={!!preview} className="group rounded-md border border-border">
      <summary className="cursor-pointer select-none px-3 py-2 text-xs font-medium text-muted-foreground group-open:border-b group-open:border-border">
        {label}
        {hasBody ? ` (${fmtBytes(size ?? 0)})` : ""}
        {truncated ? " — preview only" : ""}
      </summary>
      {!hasBody ? (
        <div className="px-3 py-2 text-xs text-muted-foreground">—</div>
      ) : !preview ? (
        <div className="px-3 py-2 text-xs text-muted-foreground">
          [blob, {fmtBytes(size ?? 0)} — not previewed]
        </div>
      ) : (
        <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all px-3 py-2 font-mono text-xs">
          {preview}
        </pre>
      )}
    </details>
  );
}

interface EndpointRollup {
  key: string;
  method: string;
  path: string;
  count: number;
  p50: number;
  p95: number;
  max: number;
  errorRate: number; // 0..1, share of responses with status >= 400
}

function rollupByEndpoint(events: CapturedEvent[]): EndpointRollup[] {
  const groups = new Map<string, CapturedEvent[]>();
  for (const e of events) {
    if (!e.http_method && !e.http_path) continue;
    const method = e.http_method ?? "-";
    const path = e.http_path ?? "-";
    const key = `${method} ${path}`;
    const arr = groups.get(key);
    if (arr) arr.push(e);
    else groups.set(key, [e]);
  }
  const out: EndpointRollup[] = [];
  for (const [key, arr] of groups) {
    const durations = arr
      .map((e) => e.duration_ns ?? 0)
      .filter((n) => n > 0)
      .sort((a, b) => a - b);
    const [method, path] = key.split(" ");
    const errors = arr.filter((e) => (e.http_status ?? 0) >= 400).length;
    out.push({
      key,
      method,
      path,
      count: arr.length,
      p50: pct(durations, 0.5),
      p95: pct(durations, 0.95),
      max: durations[durations.length - 1] ?? 0,
      errorRate: arr.length === 0 ? 0 : errors / arr.length,
    });
  }
  // Most-frequent routes first; ties broken by p95 desc.
  out.sort((a, b) => b.count - a.count || b.p95 - a.p95);
  return out;
}

function pct(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
  return sorted[idx];
}

function EventsByEndpoint({ events }: { events: CapturedEvent[] }) {
  const rows = rollupByEndpoint(events);
  if (rows.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No HTTP events in this page — the By endpoint view is HTTP-only.
      </p>
    );
  }
  return (
    <Table>
      <THead>
        <TRow>
          <TH>Method</TH>
          <TH>Path</TH>
          <TH className="text-right">Count</TH>
          <TH className="text-right">p50</TH>
          <TH className="text-right">p95</TH>
          <TH className="text-right">Max</TH>
          <TH className="text-right">Error rate</TH>
        </TRow>
      </THead>
      <tbody>
        {rows.map((r) => (
          <TRow key={r.key}>
            <TD className="font-mono">{r.method}</TD>
            <TD className="font-mono text-xs">{r.path}</TD>
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
            <TD className="text-right font-mono">
              {r.errorRate === 0
                ? "—"
                : `${(r.errorRate * 100).toFixed(0)}%`}
            </TD>
          </TRow>
        ))}
      </tbody>
    </Table>
  );
}
