"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { PlusCircle } from "lucide-react";

import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/page-header";
import { StatusPill } from "@/components/ui/status-pill";
import { Table, TD, TH, THead, TRow } from "@/components/ui/table";
import { api } from "@/lib/api";
import { relativeTime } from "@/lib/utils";

export default function ReplaysPage() {
  const { data, isLoading, error } = useQuery({
    queryKey: ["replays", { limit: 100 }],
    queryFn: () => api.listReplays({ limit: 100 }),
    refetchInterval: 5_000,
  });

  return (
    <>
      <PageHeader
        title="Replays"
        description={
          data ? `${data.count} replay${data.count === 1 ? "" : "s"}` : undefined
        }
        actions={
          <Link href="/replays/new">
            <Button size="sm">
              <PlusCircle className="mr-1 h-4 w-4" /> New replay
            </Button>
          </Link>
        }
      />
      <div className="p-6">
        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : error ? (
          <p className="text-sm text-danger">Could not load replays.</p>
        ) : !data || data.count === 0 ? (
          <p className="text-sm text-muted-foreground">
            No replays yet.{" "}
            <Link href="/replays/new" className="text-accent hover:underline">
              Start one
            </Link>{" "}
            from a stopped session.
          </p>
        ) : (
          <Table>
            <THead>
              <TRow>
                <TH>Replay</TH>
                <TH>Target</TH>
                <TH>Speedup</TH>
                <TH>Status</TH>
                <TH className="text-right">Dispatched</TH>
                <TH className="text-right">Failed</TH>
                <TH className="text-right">p95 ms</TH>
                <TH>Started</TH>
              </TRow>
            </THead>
            <tbody>
              {data.replays.map((r) => (
                <TRow key={r.id}>
                  <TD>
                    <Link
                      href={`/replays/${r.id}`}
                      className="font-medium hover:text-accent"
                    >
                      {r.label || r.id}
                    </Link>
                    <div className="font-mono text-xs text-muted-foreground">
                      {r.id}
                    </div>
                  </TD>
                  <TD className="max-w-[220px] truncate font-mono text-xs">
                    {r.target_url}
                  </TD>
                  <TD className="font-mono">{r.speedup}×</TD>
                  <TD>
                    <StatusPill status={r.status} />
                  </TD>
                  <TD className="text-right font-mono">{r.events_dispatched}</TD>
                  <TD className="text-right font-mono">
                    {r.events_failed || 0}
                  </TD>
                  <TD className="text-right font-mono">
                    {r.p95_latency_ms != null ? r.p95_latency_ms.toFixed(1) : "—"}
                  </TD>
                  <TD className="text-muted-foreground">
                    {relativeTime(r.started_at)}
                  </TD>
                </TRow>
              ))}
            </tbody>
          </Table>
        )}
      </div>
    </>
  );
}
