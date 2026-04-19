"use client";

import { useMutation, useQuery } from "@tanstack/react-query";
import { useRouter, useSearchParams } from "next/navigation";
import { FormEvent, useState } from "react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { PageHeader } from "@/components/page-header";
import { api, HTTPError } from "@/lib/api";

/**
 * Start a new replay. Reachable via "New replay" on /replays or
 * "Replay" on a Session detail page (passes ?source=<session_id>).
 *
 * Minimal form — source session + target URL + speedup. Engine-side
 * options like virtual users, auth strategies, body mutators aren't
 * exposed here yet; those need POST /api/v1/replays directly or the
 * CLI. Start simple, grow the form as real needs surface.
 */
export default function NewReplayPage() {
  const router = useRouter();
  const search = useSearchParams();
  const preselectedSource = search.get("source") ?? "";

  const sessions = useQuery({
    queryKey: ["sessions", { status: "stopped", limit: 50 }],
    queryFn: () => api.listSessions({ status: "stopped", limit: 50 }),
  });

  // null = user hasn't picked yet; we derive a fallback from the query.
  // When the user interacts with the select we store their explicit
  // choice as a string. This pattern avoids setState-in-effect since
  // the fallback is a pure derivation.
  const [userPickedSource, setUserPickedSource] = useState<string | null>(null);
  const [targetUrl, setTargetUrl] = useState("");
  const [speedup, setSpeedup] = useState("1");
  const [label, setLabel] = useState("");
  const [error, setError] = useState<string | null>(null);

  const fallbackSourceId =
    sessions.data?.sessions.find((s) => s.id === preselectedSource)?.id ??
    sessions.data?.sessions[0]?.id ??
    "";
  const sourceId = userPickedSource ?? fallbackSourceId;

  const start = useMutation({
    mutationFn: () =>
      api.startReplay({
        source_session_id: sourceId,
        target_url: targetUrl.trim(),
        speedup: Number(speedup) || 1,
        label: label.trim() || undefined,
      }),
    onSuccess: (r) => router.push(`/replays/${r.id}`),
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
    if (!sourceId) {
      setError("Pick a source session.");
      return;
    }
    try {
      new URL(targetUrl.trim());
    } catch {
      setError("Target URL is invalid.");
      return;
    }
    start.mutate();
  }

  const stoppedSessions = sessions.data?.sessions ?? [];

  return (
    <>
      <PageHeader
        title="New replay"
        description="Fire captured traffic at a target URL"
      />
      <div className="p-6">
        <Card className="max-w-xl">
          <form onSubmit={onSubmit} className="space-y-4">
            <label className="block text-sm">
              <span className="mb-1 block text-muted-foreground">
                Source session
              </span>
              {sessions.isLoading ? (
                <div className="text-xs text-muted-foreground">Loading…</div>
              ) : stoppedSessions.length === 0 ? (
                <div className="text-xs text-muted-foreground">
                  No stopped sessions yet. Stop an active capture first.
                </div>
              ) : (
                <select
                  required
                  value={sourceId}
                  onChange={(e) => setUserPickedSource(e.target.value)}
                  className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
                >
                  {stoppedSessions.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name} — {s.id}
                      {s.events_captured > 0
                        ? ` (${s.events_captured.toLocaleString()} events)`
                        : ""}
                    </option>
                  ))}
                </select>
              )}
            </label>

            <label className="block text-sm">
              <span className="mb-1 block text-muted-foreground">
                Target URL
              </span>
              <input
                type="url"
                required
                value={targetUrl}
                onChange={(e) => setTargetUrl(e.target.value)}
                placeholder="https://staging.example.com"
                className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
              />
              <span className="mt-1 block text-xs text-muted-foreground">
                Captured HTTP requests get fired at this origin. For safe
                replay against a clone, run the SUT in hermetic mode.
              </span>
            </label>

            <div className="grid gap-4 md:grid-cols-2">
              <label className="block text-sm">
                <span className="mb-1 block text-muted-foreground">
                  Speedup
                </span>
                <input
                  type="number"
                  min="0.1"
                  step="0.1"
                  required
                  value={speedup}
                  onChange={(e) => setSpeedup(e.target.value)}
                  className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
                />
                <span className="mt-1 block text-xs text-muted-foreground">
                  1.0 = real time, 12.0 = 12×, 0.5 = half-speed
                </span>
              </label>
              <label className="block text-sm">
                <span className="mb-1 block text-muted-foreground">
                  Label (optional)
                </span>
                <input
                  type="text"
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                  placeholder="friday-smoke-12x"
                  className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
                />
              </label>
            </div>

            {error && (
              <div className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger">
                {error}
              </div>
            )}

            <div className="flex items-center gap-2">
              <Button
                type="submit"
                disabled={
                  start.isPending ||
                  !sourceId ||
                  !targetUrl ||
                  stoppedSessions.length === 0
                }
              >
                {start.isPending ? "Starting…" : "Start replay"}
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={() => router.back()}
              >
                Cancel
              </Button>
            </div>
          </form>
        </Card>
      </div>
    </>
  );
}
