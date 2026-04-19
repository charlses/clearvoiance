"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { PlayCircle, StopCircle } from "lucide-react";
import { use, useState } from "react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Code } from "@/components/ui/code";
import { PageHeader } from "@/components/page-header";
import { api, HTTPError, type Monitor } from "@/lib/api";
import { relativeTime } from "@/lib/utils";

/**
 * Monitor detail — everything there is to know about one
 * remote-controlled SDK client, plus the same Start/Stop controls
 * that live on the Monitors list.
 */
export default function MonitorDetailPage({
  params,
}: {
  params: Promise<{ name: string }>;
}) {
  const { name: rawName } = use(params);
  const name = decodeURIComponent(rawName);
  const qc = useQueryClient();
  const router = useRouter();

  const monitor = useQuery({
    queryKey: ["monitor", name],
    queryFn: () => api.getMonitor(name),
    refetchInterval: 3_000,
  });

  const [showStart, setShowStart] = useState(false);

  const stop = useMutation({
    mutationFn: () => api.stopMonitor(name),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["monitor", name] }),
  });

  const m = monitor.data;
  return (
    <>
      <PageHeader
        title={m?.display_name || name}
        description={<Code>{name}</Code> as unknown as string}
        actions={
          !m ? null : m.capture_enabled ? (
            <Button
              variant="danger"
              size="sm"
              onClick={() => stop.mutate()}
              disabled={stop.isPending}
            >
              <StopCircle className="mr-1 h-4 w-4" />
              {stop.isPending ? "Stopping…" : "Stop capture"}
            </Button>
          ) : (
            <Button
              size="sm"
              onClick={() => setShowStart(true)}
              disabled={!m.online}
              title={
                m.online
                  ? "Start capture"
                  : "Monitor offline — start will queue until reconnect"
              }
            >
              <PlayCircle className="mr-1 h-4 w-4" />
              Start capture
            </Button>
          )
        }
      />
      <div className="space-y-4 p-6">
        {monitor.isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : !m ? (
          <p className="text-sm text-danger">Monitor not found.</p>
        ) : (
          <>
            <div className="grid gap-3 md:grid-cols-4">
              <Stat
                label="Status"
                value={
                  m.capture_enabled
                    ? "Capturing"
                    : m.online
                    ? "Online · idle"
                    : "Offline"
                }
              />
              <Stat
                label="Replicas"
                value={m.online_replicas.toLocaleString()}
              />
              <Stat
                label="SDK"
                value={
                  m.sdk_language
                    ? `${m.sdk_language}${m.sdk_version ? " @ " + m.sdk_version : ""}`
                    : "—"
                }
              />
              <Stat
                label="Last seen"
                value={relativeTime(m.last_seen_at)}
              />
            </div>

            <Card>
              <h2 className="mb-2 text-sm font-semibold">Meta</h2>
              <div className="grid gap-y-2 text-sm md:grid-cols-2">
                <MetaRow label="Name" value={<Code>{m.name}</Code>} />
                <MetaRow label="Registered" value={relativeTime(m.created_at)} />
                {m.active_session_id ? (
                  <MetaRow
                    label="Active session"
                    value={
                      <Link
                        href={`/sessions/${m.active_session_id}`}
                        className="text-accent hover:underline"
                      >
                        {m.active_session_id}
                      </Link>
                    }
                  />
                ) : null}
                {Object.keys(m.labels).length > 0 && (
                  <div className="md:col-span-2">
                    <div className="mb-2 text-xs uppercase tracking-wide text-muted-foreground">
                      Labels
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {Object.entries(m.labels).map(([k, v]) => (
                        <Code key={k}>
                          {k}={v}
                        </Code>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </Card>
          </>
        )}
      </div>

      {showStart && m && (
        <StartDialog
          monitor={m}
          onClose={() => setShowStart(false)}
          onStarted={(sessionId) => {
            setShowStart(false);
            qc.invalidateQueries({ queryKey: ["monitor", name] });
            router.push(`/sessions/${sessionId}`);
          }}
        />
      )}
    </>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <Card>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 truncate text-lg font-semibold">{value}</div>
    </Card>
  );
}

function MetaRow({
  label,
  value,
}: {
  label: string;
  value: React.ReactNode;
}) {
  return (
    <div className="flex items-baseline gap-3">
      <span className="w-32 shrink-0 text-xs uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      <span className="min-w-0 break-all text-sm">{value}</span>
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
  onStarted: (sessionId: string) => void;
}) {
  const [sessionName, setSessionName] = useState("");
  const [error, setError] = useState<string | null>(null);

  const start = useMutation({
    mutationFn: () =>
      api.startMonitor(monitor.name, {
        session_name: sessionName.trim() || undefined,
      }),
    onSuccess: (resp) => onStarted(resp.session_id),
    onError: (err) =>
      setError(
        err instanceof HTTPError
          ? err.apiError.message
          : err instanceof Error
          ? err.message
          : String(err),
      ),
  });

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 p-4"
      onClick={onClose}
    >
      <Card className="w-full max-w-md" onClick={(e) => e.stopPropagation()}>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setError(null);
            start.mutate();
          }}
          className="space-y-4"
        >
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
              placeholder={`${monitor.name}-auto`}
              className="w-full rounded-md border border-border bg-background px-3 py-2 font-mono text-sm"
            />
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
