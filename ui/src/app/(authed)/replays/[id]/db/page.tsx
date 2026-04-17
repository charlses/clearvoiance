"use client";

import { useQuery } from "@tanstack/react-query";
import { use } from "react";

import { Card, CardTitle } from "@/components/ui/card";
import { Code } from "@/components/ui/code";
import { PageHeader } from "@/components/page-header";
import { Table, TD, TH, THead, TRow } from "@/components/ui/table";
import { api } from "@/lib/api";

export default function ReplayDbPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);

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

        <section>
          <h2 className="mb-2 text-sm font-semibold">Top slow queries</h2>
          {topSlow.data && topSlow.data.rows.length > 0 ? (
            <Table>
              <THead>
                <TRow>
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
                {topSlow.data.rows.map((r) => (
                  <TRow key={r.query_fingerprint + r.observation_type}>
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
                ))}
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
