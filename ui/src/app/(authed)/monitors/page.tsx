"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Activity, PlayCircle, StopCircle } from "lucide-react";
import { FormEvent, useState } from "react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Code } from "@/components/ui/code";
import { PageHeader } from "@/components/page-header";
import { Table, TD, TH, THead, TRow } from "@/components/ui/table";
import { api, HTTPError, type Monitor } from "@/lib/api";
import { cn, relativeTime } from "@/lib/utils";

/**
 * Monitors — remote-controlled capture clients. Each row is one
 * logical SDK client (e.g. "coldfire-strapi"); the online indicator
 * reflects how many live gRPC streams are attached right now.
 *
 * Start / Stop buttons push commands down the control stream to the
 * SDK(s). When a monitor is offline, Start still pre-creates the
 * session — the SDK picks it up on next reconnect.
 */
export default function MonitorsPage() {
  const qc = useQueryClient();
  const { data, isLoading, error } = useQuery({
    queryKey: ["monitors"],
    queryFn: api.listMonitors,
    // Poll while we're on the page so online/offline + active-session
    // state stay fresh. Cheap: one REST call every 3s.
    refetchInterval: 3_000,
  });

  const [startFor, setStartFor] = useState<Monitor | null>(null);

  const stopMutation = useMutation({
    mutationFn: (name: string) => api.stopMonitor(name),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["monitors"] }),
  });

  return (
    <>
      <PageHeader
        title="Monitors"
        description={
          data
            ? `${data.count} client${data.count === 1 ? "" : "s"} · ` +
              `${data.monitors.filter((m) => m.online).length} online`
            : undefined
        }
      />
      <div className="p-6">
        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : error ? (
          <p className="text-sm text-danger">Could not load monitors.</p>
        ) : !data || data.count === 0 ? (
          <EmptyState />
        ) : (
          <Table>
            <THead>
              <TRow>
                <TH>Name</TH>
                <TH>Status</TH>
                <TH>SDK</TH>
                <TH>Labels</TH>
                <TH>Last seen</TH>
                <TH className="text-right">Actions</TH>
              </TRow>
            </THead>
            <tbody>
              {data.monitors.map((m) => (
                <TRow key={m.name}>
                  <TD>
                    <Link
                      href={`/monitors/${encodeURIComponent(m.name)}`}
                      className="font-medium hover:text-accent"
                    >
                      {m.display_name || m.name}
                    </Link>
                    <div className="font-mono text-xs text-muted-foreground">
                      {m.name}
                    </div>
                  </TD>
                  <TD>
                    <StatusIndicator m={m} />
                  </TD>
                  <TD className="font-mono text-xs text-muted-foreground">
                    {m.sdk_language ? (
                      <>
                        {m.sdk_language}
                        {m.sdk_version ? ` @ ${m.sdk_version}` : ""}
                      </>
                    ) : (
                      "—"
                    )}
                  </TD>
                  <TD>
                    <Labels labels={m.labels} />
                  </TD>
                  <TD className="text-muted-foreground">
                    {relativeTime(m.last_seen_at)}
                  </TD>
                  <TD className="text-right">
                    {m.capture_enabled ? (
                      <Button
                        variant="danger"
                        size="sm"
                        onClick={() => stopMutation.mutate(m.name)}
                        disabled={
                          stopMutation.isPending &&
                          stopMutation.variables === m.name
                        }
                      >
                        <StopCircle className="mr-1 h-3 w-3" />
                        Stop capture
                      </Button>
                    ) : (
                      <Button
                        size="sm"
                        onClick={() => setStartFor(m)}
                        disabled={!m.online}
                        title={
                          m.online
                            ? "Start capture"
                            : "Monitor offline — start will queue until reconnect"
                        }
                      >
                        <PlayCircle className="mr-1 h-3 w-3" />
                        Start capture
                      </Button>
                    )}
                  </TD>
                </TRow>
              ))}
            </tbody>
          </Table>
        )}
      </div>

      {startFor && (
        <StartDialog
          monitor={startFor}
          onClose={() => setStartFor(null)}
          onStarted={() => {
            setStartFor(null);
            qc.invalidateQueries({ queryKey: ["monitors"] });
          }}
        />
      )}
    </>
  );
}

function EmptyState() {
  return (
    <Card>
      <div className="flex items-start gap-3">
        <Activity className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" />
        <div className="text-sm">
          <p className="font-medium">No monitors registered yet.</p>
          <p className="mt-1 text-muted-foreground">
            Configure your SDK with{" "}
            <code className="font-mono text-xs">
              remote: {"{ clientName: '...' }"}
            </code>{" "}
            to register. Once connected, the client appears here and you
            can start / stop captures from this page.
          </p>
        </div>
      </div>
    </Card>
  );
}

function StatusIndicator({ m }: { m: Monitor }) {
  if (m.capture_enabled) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full border border-success/40 bg-success/10 px-2 py-0.5 text-xs text-success">
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-success" />
        Capturing{m.online_replicas > 1 ? ` · ${m.online_replicas} replicas` : ""}
      </span>
    );
  }
  if (m.online) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-muted/40 px-2 py-0.5 text-xs text-muted-foreground">
        <span className="h-1.5 w-1.5 rounded-full bg-foreground/40" />
        Online{m.online_replicas > 1 ? ` · ${m.online_replicas}` : ""}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-muted/40 px-2 py-0.5 text-xs text-muted-foreground">
      <span className="h-1.5 w-1.5 rounded-full bg-foreground/20" />
      Offline
    </span>
  );
}

function Labels({ labels }: { labels: Record<string, string> }) {
  const entries = Object.entries(labels);
  if (entries.length === 0) return <span className="text-muted-foreground">—</span>;
  return (
    <div className="flex flex-wrap gap-1">
      {entries.slice(0, 3).map(([k, v]) => (
        <Code key={k}>
          {k}={v}
        </Code>
      ))}
      {entries.length > 3 && (
        <span className="text-xs text-muted-foreground">
          +{entries.length - 3}
        </span>
      )}
    </div>
  );
}

function StartDialog({
  monitor,
  onClose,
  onStarted,
}: {
  monitor: Monitor;
  onClose: () => void;
  onStarted: () => void;
}) {
  const router = useRouter();
  const [sessionName, setSessionName] = useState("");
  const [error, setError] = useState<string | null>(null);

  const start = useMutation({
    mutationFn: () =>
      api.startMonitor(monitor.name, {
        session_name: sessionName.trim() || undefined,
      }),
    onSuccess: (resp) => {
      onStarted();
      // Drop straight into the session detail so operator can watch
      // events stream in.
      router.push(`/sessions/${resp.session_id}`);
    },
    onError: (err) =>
      setError(
        err instanceof HTTPError
          ? err.apiError.message
          : err instanceof Error
          ? err.message
          : String(err),
      ),
  });

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    start.mutate();
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 p-4"
      onClick={onClose}
    >
      <Card
        className={cn("w-full max-w-md")}
        onClick={(e) => e.stopPropagation()}
      >
        <form onSubmit={onSubmit} className="space-y-4">
          <div>
            <h2 className="text-base font-semibold">
              Start capture — {monitor.display_name || monitor.name}
            </h2>
            <p className="mt-1 text-xs text-muted-foreground">
              Opens a new capture session. Everything the SDK captures
              until you click Stop becomes a replayable window.
            </p>
          </div>
          <label className="block text-sm">
            <span className="mb-1 block text-muted-foreground">
              Session name (optional)
            </span>
            <input
              type="text"
              autoFocus
              value={sessionName}
              onChange={(e) => setSessionName(e.target.value)}
              placeholder={`${monitor.name}-${nowSlug()}`}
              className="w-full rounded-md border border-border bg-background px-3 py-2 font-mono text-sm"
            />
            <span className="mt-1 block text-xs text-muted-foreground">
              Leave blank for an auto-generated name.
            </span>
          </label>
          {error && (
            <div className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger">
              {error}
            </div>
          )}
          <div className="flex items-center gap-2">
            <Button type="submit" disabled={start.isPending}>
              {start.isPending ? "Starting…" : "Start capture"}
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={onClose}
              disabled={start.isPending}
            >
              Cancel
            </Button>
          </div>
        </form>
      </Card>
    </div>
  );
}

function nowSlug(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-` +
    `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  );
}
