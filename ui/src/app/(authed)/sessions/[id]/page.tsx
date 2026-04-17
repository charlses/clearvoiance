"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { use } from "react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Code } from "@/components/ui/code";
import { PageHeader } from "@/components/page-header";
import { StatusPill } from "@/components/ui/status-pill";
import { Table, TD, TH, THead, TRow } from "@/components/ui/table";
import { api } from "@/lib/api";
import { fmtBytes, relativeTime } from "@/lib/utils";

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

function EventsPanel({
  events,
  note,
}: {
  events: Array<{
    id: string;
    event_type: string;
    http_method?: string;
    http_path?: string;
    http_status?: number;
    timestamp_ns: number;
  }>;
  note?: string;
}) {
  return (
    <div>
      <h2 className="mb-2 text-sm font-semibold">Events (latest {events.length})</h2>
      {note ? (
        <p className="mb-2 text-xs text-muted-foreground">{note}</p>
      ) : null}
      {events.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No events yet, or the event store doesn&apos;t support reads (Noop mode).
        </p>
      ) : (
        <Table>
          <THead>
            <TRow>
              <TH>Type</TH>
              <TH>Method</TH>
              <TH>Path</TH>
              <TH className="text-right">Status</TH>
              <TH>ID</TH>
            </TRow>
          </THead>
          <tbody>
            {events.map((e) => (
              <TRow key={e.id}>
                <TD className="capitalize text-muted-foreground">{e.event_type}</TD>
                <TD className="font-mono">{e.http_method ?? "—"}</TD>
                <TD className="font-mono text-xs">{e.http_path ?? "—"}</TD>
                <TD className="text-right font-mono">{e.http_status ?? "—"}</TD>
                <TD className="font-mono text-xs text-muted-foreground">
                  {e.id.slice(0, 12)}
                </TD>
              </TRow>
            ))}
          </tbody>
        </Table>
      )}
    </div>
  );
}
