"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { api, HTTPError } from "@/lib/api";
import { Button } from "@/components/ui/button";

/**
 * First-run wizard. Creates the sole admin when `users` is empty. If
 * someone hits this URL after setup is already done, we bounce them to
 * /login — the backend also rejects the setup call (409), so the UI
 * redirect is just for UX.
 */
export default function SetupPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [gateChecked, setGateChecked] = useState(false);

  // Guard: if setup is already done, go to /login instead. Silently
  // succeeds if the engine is unreachable — the setup POST will surface
  // the real error.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const s = await api.authState();
        if (!cancelled && !s.setup_required) router.replace("/login");
      } catch {
        /* engine unreachable — let the submit attempt surface it */
      } finally {
        if (!cancelled) setGateChecked(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [router]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (password.length < 10) {
      setError("Password must be at least 10 characters.");
      return;
    }
    if (password !== confirm) {
      setError("Passwords don't match.");
      return;
    }
    setSubmitting(true);
    try {
      await api.setup(email.trim(), password);
      // /auth/setup sets the cookie on success — go straight to the
      // dashboard.
      router.replace("/");
    } catch (err) {
      if (err instanceof HTTPError) {
        setError(err.apiError.message);
      } else {
        setError(err instanceof Error ? err.message : String(err));
      }
      setSubmitting(false);
    }
  }

  if (!gateChecked) {
    return (
      <div className="flex min-h-screen flex-1 items-center justify-center text-sm text-muted-foreground">
        Loading…
      </div>
    );
  }

  return (
    <div className="flex min-h-screen flex-1 items-center justify-center bg-background px-4">
      <form
        onSubmit={onSubmit}
        className="w-full max-w-sm space-y-5 rounded-lg border bg-card p-6 shadow-sm"
      >
        <div>
          <h1 className="text-lg font-semibold">Set up clearvoiance</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Create the admin account. This only appears once — whoever fills
            it in first becomes the admin.
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
            <span className="mb-1 block text-muted-foreground">
              Password (10+ characters)
            </span>
            <input
              type="password"
              required
              minLength={10}
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full rounded-md border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-accent"
            />
          </label>
          <label className="block text-sm">
            <span className="mb-1 block text-muted-foreground">
              Confirm password
            </span>
            <input
              type="password"
              required
              minLength={10}
              autoComplete="new-password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              className="w-full rounded-md border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-accent"
            />
          </label>
        </div>

        {error && (
          <div className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger">
            {error}
          </div>
        )}

        <Button type="submit" disabled={submitting} className="w-full">
          {submitting ? "Creating…" : "Create admin account"}
        </Button>
      </form>
    </div>
  );
}
