"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { FormEvent, useEffect, useState } from "react";

import { api, HTTPError, apiBaseURL } from "@/lib/api";
import { Button } from "@/components/ui/button";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Route first-time visitors to /setup instead of confusing them with a
  // login screen that can't succeed.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const s = await api.authState();
        if (!cancelled && s.setup_required) router.replace("/setup");
      } catch {
        /* engine unreachable — stay on login, submit will surface it */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [router]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setErr(null);
    setBusy(true);
    try {
      await api.login(email.trim(), password);
      router.replace("/");
    } catch (e) {
      if (e instanceof HTTPError && e.status === 401) {
        setErr("Invalid email or password.");
      } else if (e instanceof HTTPError) {
        setErr(e.apiError.message);
      } else {
        setErr(
          `Could not reach the engine at ${apiBaseURL()}. Is it running?` +
            (e instanceof Error ? `\n${e.message}` : ""),
        );
      }
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-screen flex-1 items-center justify-center bg-background px-4">
      <form
        onSubmit={onSubmit}
        className="w-full max-w-sm space-y-5 rounded-lg border bg-card p-6 shadow-sm"
      >
        <div>
          <h1 className="text-lg font-semibold">Sign in</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Engine at <code className="font-mono text-xs">{apiBaseURL()}</code>.
          </p>
        </div>

        <div className="space-y-3">
          <label className="block text-sm">
            <span className="mb-1 block text-muted-foreground">Email</span>
            <input
              type="email"
              required
              autoFocus
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full rounded-md border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-accent"
            />
          </label>
          <label className="block text-sm">
            <span className="mb-1 block text-muted-foreground">Password</span>
            <input
              type="password"
              required
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full rounded-md border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-accent"
            />
          </label>
        </div>

        {err && (
          <div className="whitespace-pre-line rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger">
            {err}
          </div>
        )}

        <Button
          type="submit"
          disabled={busy || !email.trim() || !password}
          className="w-full"
        >
          {busy ? "Signing in…" : "Sign in"}
        </Button>

        <p className="text-xs text-muted-foreground">
          Lost access? Reset from the server with{" "}
          <Link
            href="https://clearvoiance.vercel.app/docs/deployment#users"
            target="_blank"
            rel="noreferrer"
            className="underline"
          >
            the CLI recovery flow
          </Link>
          .
        </p>
      </form>
    </div>
  );
}
