"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";

import { PageHeader } from "@/components/page-header";
import { StatusPill } from "@/components/ui/status-pill";
import { Table, TD, TH, THead, TRow } from "@/components/ui/table";
import { api, docsURL } from "@/lib/api";
import { fmtBytes, relativeTime } from "@/lib/utils";

export default function SessionsPage() {
  const { data, isLoading, error } = useQuery({
    queryKey: ["sessions", { limit: 100 }],
    queryFn: () => api.listSessions({ limit: 100 }),
    refetchInterval: 5_000,
  });

  return (
    <>
      <PageHeader
        title="Sessions"
        description={
          data ? `${data.count} session${data.count === 1 ? "" : "s"}` : undefined
        }
      />
      <div className="p-6">
        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : error ? (
          <p className="text-sm text-danger">Could not load sessions.</p>
        ) : !data || data.count === 0 ? (
          <p className="text-sm text-muted-foreground">
            No sessions yet. Start one with the SDK — see{" "}
            <a
              href={docsURL("/docs/quickstart")}
              target="_blank"
              rel="noreferrer"
              className="text-accent hover:underline"
            >
              the quickstart
            </a>
            .
          </p>
        ) : (
          <Table>
            <THead>
              <TRow>
                <TH>Name</TH>
                <TH>Status</TH>
                <TH className="text-right">Events</TH>
                <TH className="text-right">Bytes</TH>
                <TH>Started</TH>
              </TRow>
            </THead>
            <tbody>
              {data.sessions.map((s) => (
                <TRow key={s.id}>
                  <TD>
                    <Link
                      href={`/sessions/${s.id}`}
                      className="font-medium hover:text-accent"
                    >
                      {s.name}
                    </Link>
                    <div className="font-mono text-xs text-muted-foreground">
                      {s.id}
                    </div>
                  </TD>
                  <TD>
                    <StatusPill status={s.status} />
                  </TD>
                  <TD className="text-right font-mono">
                    {s.events_captured.toLocaleString()}
                  </TD>
                  <TD className="text-right font-mono">
                    {fmtBytes(s.bytes_captured)}
                  </TD>
                  <TD className="text-muted-foreground">
                    {relativeTime(s.started_at)}
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
