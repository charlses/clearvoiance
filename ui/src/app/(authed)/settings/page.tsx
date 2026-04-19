"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertCircle, Copy, LogOut, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { FormEvent, useState } from "react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Code } from "@/components/ui/code";
import { PageHeader } from "@/components/page-header";
import { Table, TD, TH, THead, TRow } from "@/components/ui/table";
import { api, HTTPError, type APIKey } from "@/lib/api";
import { relativeTime } from "@/lib/utils";

export default function SettingsPage() {
  const qc = useQueryClient();
  const router = useRouter();
  const keys = useQuery({
    queryKey: ["api-keys"],
    queryFn: api.listAPIKeys,
  });
  const config = useQuery({
    queryKey: ["config"],
    queryFn: api.config,
  });
  const me = useQuery({
    queryKey: ["me"],
    queryFn: api.me,
  });

  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [pwdError, setPwdError] = useState<string | null>(null);
  const [pwdSuccess, setPwdSuccess] = useState(false);

  const changePwd = useMutation({
    mutationFn: ({ current, next }: { current: string; next: string }) =>
      api.changePassword(current, next),
    onSuccess: () => {
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      setPwdError(null);
      setPwdSuccess(true);
      setTimeout(() => setPwdSuccess(false), 4000);
    },
    onError: (err) => {
      if (err instanceof HTTPError) setPwdError(err.apiError.message);
      else setPwdError(err instanceof Error ? err.message : String(err));
    },
  });

  const logout = useMutation({
    mutationFn: () => api.logout(),
    onSuccess: () => router.replace("/login"),
    onError: () => router.replace("/login"),
  });

  function onPwdSubmit(e: FormEvent) {
    e.preventDefault();
    setPwdError(null);
    if (newPassword.length < 10) {
      setPwdError("New password must be at least 10 characters.");
      return;
    }
    if (newPassword !== confirmPassword) {
      setPwdError("New passwords don't match.");
      return;
    }
    changePwd.mutate({ current: currentPassword, next: newPassword });
  }

  const [name, setName] = useState("");
  const [justCreated, setJustCreated] = useState<{
    id: string;
    name: string;
    key: string;
  } | null>(null);

  const create = useMutation({
    mutationFn: (n: string) => api.createAPIKey(n),
    onSuccess: (data) => {
      setJustCreated({ id: data.id, name: data.name, key: data.key });
      setName("");
      qc.invalidateQueries({ queryKey: ["api-keys"] });
    },
  });
  const revoke = useMutation({
    mutationFn: (id: string) => api.revokeAPIKey(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["api-keys"] }),
  });

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    create.mutate(name.trim());
  }

  return (
    <>
      <PageHeader title="Settings" description="Account, API keys, engine config" />
      <div className="space-y-6 p-6">
        <section>
          <h2 className="mb-2 text-sm font-semibold">Account</h2>
          <Card>
            <div className="grid gap-y-2 text-sm md:grid-cols-2">
              <Row label="Email" value={me.data?.email ?? "—"} />
              <Row label="Role" value={me.data?.role ?? "—"} />
              <Row
                label="Last login"
                value={
                  me.data?.last_login_at ? relativeTime(me.data.last_login_at) : "—"
                }
              />
              <div className="flex items-baseline gap-3">
                <span className="w-28 shrink-0 text-xs uppercase tracking-wide text-muted-foreground">
                  Session
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => logout.mutate()}
                  disabled={logout.isPending}
                >
                  <LogOut className="mr-1 h-3 w-3" />
                  {logout.isPending ? "Signing out…" : "Sign out"}
                </Button>
              </div>
            </div>
          </Card>
          <Card className="mt-3">
            <form onSubmit={onPwdSubmit} className="space-y-3">
              <h3 className="text-sm font-medium">Change password</h3>
              <div className="grid gap-3 md:grid-cols-3">
                <input
                  type="password"
                  required
                  autoComplete="current-password"
                  value={currentPassword}
                  onChange={(e) => setCurrentPassword(e.target.value)}
                  placeholder="Current password"
                  className="rounded-md border border-border bg-background px-3 py-2 text-sm"
                />
                <input
                  type="password"
                  required
                  minLength={10}
                  autoComplete="new-password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  placeholder="New password (10+ chars)"
                  className="rounded-md border border-border bg-background px-3 py-2 text-sm"
                />
                <input
                  type="password"
                  required
                  minLength={10}
                  autoComplete="new-password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  placeholder="Confirm new password"
                  className="rounded-md border border-border bg-background px-3 py-2 text-sm"
                />
              </div>
              {pwdError && (
                <div className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger">
                  {pwdError}
                </div>
              )}
              {pwdSuccess && (
                <div className="rounded-md border border-success/30 bg-success/10 px-3 py-2 text-sm text-success">
                  Password updated. Other sessions signed out.
                </div>
              )}
              <Button
                type="submit"
                size="sm"
                disabled={
                  changePwd.isPending ||
                  !currentPassword ||
                  !newPassword ||
                  !confirmPassword
                }
              >
                {changePwd.isPending ? "Updating…" : "Update password"}
              </Button>
            </form>
          </Card>
        </section>

        <section>
          <h2 className="mb-2 text-sm font-semibold">Engine</h2>
          <Card>
            <div className="grid gap-y-2 text-sm md:grid-cols-2">
              <Row label="Version" value={config.data?.version ?? "—"} mono />
              <Row label="gRPC" value={config.data?.grpc_addr ?? "—"} mono />
              <Row label="HTTP" value={config.data?.http_addr ?? "—"} mono />
              <Row
                label="ClickHouse"
                value={config.data?.clickhouse_dsn ?? "—"}
                mono
              />
              <Row
                label="Postgres"
                value={config.data?.postgres_dsn ?? "—"}
                mono
              />
              <Row
                label="MinIO"
                value={config.data?.minio_endpoint ?? "—"}
                mono
              />
              <Row
                label="Features"
                value={
                  config.data
                    ? Object.entries(config.data.features)
                        .filter(([, v]) => v)
                        .map(([k]) => k)
                        .join(", ")
                    : "—"
                }
              />
            </div>
          </Card>
        </section>

        <section>
          <h2 className="mb-2 text-sm font-semibold">API keys</h2>
          <Card className="mb-3">
            <form onSubmit={onSubmit} className="flex gap-2">
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Name (e.g. ci-runner)"
                className="flex-1 rounded-md border border-border bg-background px-3 py-2 text-sm"
              />
              <Button type="submit" disabled={create.isPending || !name.trim()}>
                {create.isPending ? "Creating…" : "Create"}
              </Button>
            </form>
            {justCreated ? (
              <div className="mt-3 rounded-md border border-warning/40 bg-warning/10 p-3 text-sm">
                <div className="mb-1 flex items-center gap-2 text-warning">
                  <AlertCircle className="h-4 w-4" />
                  Store this key now — it will not be shown again.
                </div>
                <div className="flex items-center gap-2 font-mono text-xs">
                  <span className="break-all">{justCreated.key}</span>
                  <button
                    onClick={() => navigator.clipboard.writeText(justCreated.key)}
                    className="rounded-md border border-border px-2 py-1 text-foreground hover:bg-muted"
                    aria-label="Copy key"
                  >
                    <Copy className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
            ) : null}
          </Card>

          {keys.data && keys.data.count > 0 ? (
            <Table>
              <THead>
                <TRow>
                  <TH>Name</TH>
                  <TH>ID</TH>
                  <TH>Created</TH>
                  <TH>Last used</TH>
                  <TH>Revoked</TH>
                  <TH className="text-right">Actions</TH>
                </TRow>
              </THead>
              <tbody>
                {keys.data.keys.map((k: APIKey) => (
                  <TRow key={k.id}>
                    <TD className="font-medium">{k.name}</TD>
                    <TD>
                      <Code>{k.id}</Code>
                    </TD>
                    <TD className="text-muted-foreground">
                      {relativeTime(k.created_at)}
                    </TD>
                    <TD className="text-muted-foreground">
                      {k.last_used_at ? relativeTime(k.last_used_at) : "—"}
                    </TD>
                    <TD className="text-muted-foreground">
                      {k.revoked_at ? relativeTime(k.revoked_at) : "—"}
                    </TD>
                    <TD className="text-right">
                      {k.revoked_at ? null : (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => {
                            if (confirm(`Revoke ${k.name}?`)) revoke.mutate(k.id);
                          }}
                        >
                          <Trash2 className="mr-1 h-3 w-3" /> Revoke
                        </Button>
                      )}
                    </TD>
                  </TRow>
                ))}
              </tbody>
            </Table>
          ) : (
            <p className="text-sm text-muted-foreground">No API keys provisioned yet.</p>
          )}
        </section>
      </div>
    </>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-baseline gap-3">
      <span className="w-28 shrink-0 text-xs uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      <span className={`min-w-0 break-all ${mono ? "font-mono text-xs" : "text-sm"}`}>
        {value}
      </span>
    </div>
  );
}
