"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { Database, ExternalLink, PlayCircle, History } from "lucide-react";

import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/page-header";
import { StatusPill } from "@/components/ui/status-pill";
import { api, apiBaseURL, docsURL } from "@/lib/api";
import { relativeTime } from "@/lib/utils";

export default function DashboardPage() {
  const version = useQuery({
    queryKey: ["version"],
    queryFn: api.version,
    refetchInterval: 30_000,
  });
  const sessions = useQuery({
    queryKey: ["sessions", { limit: 5 }],
    queryFn: () => api.listSessions({ limit: 5 }),
    refetchInterval: 10_000,
  });
  const replays = useQuery({
    queryKey: ["replays", { limit: 5 }],
    queryFn: () => api.listReplays({ limit: 5 }),
    refetchInterval: 5_000,
  });

  return (
    <>
      <PageHeader
        title="Dashboard"
        description={`Engine @ ${apiBaseURL()}`}
        actions={
          <a
            href={docsURL("/docs")}
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          >
            Docs <ExternalLink className="h-3 w-3" />
          </a>
        }
      />
      <div className="grid grid-cols-1 gap-4 p-6 md:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Database className="h-4 w-4" /> Engine
            </CardTitle>
          </CardHeader>
          <div className="font-mono text-sm">
            {version.isError ? (
              <span className="text-danger">unreachable</span>
            ) : version.data ? (
              <>
                <div>{version.data.engine}</div>
                <div className="text-xs text-muted-foreground">
                  api {version.data.api} · sdk {version.data.sdk_compat}
                </div>
              </>
            ) : (
              <span className="text-muted-foreground">…</span>
            )}
          </div>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <History className="h-4 w-4" /> Recent sessions
            </CardTitle>
            <CardDescription>
              <Link href="/sessions" className="text-accent hover:underline">
                See all
              </Link>
            </CardDescription>
          </CardHeader>
          {sessions.data && sessions.data.count > 0 ? (
            <ul className="space-y-2">
              {sessions.data.sessions.slice(0, 5).map((s) => (
                <li
                  key={s.id}
                  className="flex items-center justify-between gap-2 text-sm"
                >
                  <Link
                    href={`/sessions/${s.id}`}
                    className="truncate hover:text-accent"
                  >
                    {s.name}
                  </Link>
                  <StatusPill status={s.status} />
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">No sessions yet.</p>
          )}
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <PlayCircle className="h-4 w-4" /> Recent replays
            </CardTitle>
            <CardDescription>
              <Link href="/replays" className="text-accent hover:underline">
                See all
              </Link>
            </CardDescription>
          </CardHeader>
          {replays.data && replays.data.count > 0 ? (
            <ul className="space-y-2">
              {replays.data.replays.slice(0, 5).map((r) => (
                <li
                  key={r.id}
                  className="flex items-center justify-between gap-2 text-sm"
                >
                  <div className="flex min-w-0 flex-col">
                    <Link
                      href={`/replays/${r.id}`}
                      className="truncate hover:text-accent"
                    >
                      {r.label || r.id}
                    </Link>
                    <span className="text-xs text-muted-foreground">
                      {relativeTime(r.started_at)}
                    </span>
                  </div>
                  <StatusPill status={r.status} />
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">No replays yet.</p>
          )}
        </Card>
      </div>
    </>
  );
}
