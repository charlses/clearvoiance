"use client";

import { useRouter } from "next/navigation";
import { FormEvent, useState } from "react";

import { api, HTTPError, setAPIKey, storedAPIKey } from "@/lib/api";
import { apiBaseURL } from "@/lib/api";

export default function LoginPage() {
  const router = useRouter();
  const [key, setKey] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setErr(null);
    setBusy(true);
    // Stash the key, then probe /version to verify the engine + auth.
    setAPIKey(key.trim());
    try {
      await api.version();
      router.replace("/");
    } catch (e) {
      // Clear the bad key so the auth gate doesn't loop.
      setAPIKey(null);
      if (e instanceof HTTPError && e.status === 401) {
        setErr("Unauthorized. Check your API key.");
      } else {
        setErr(
          `Could not reach the engine at ${apiBaseURL()}. Is it running?` +
            (e instanceof Error ? `\n${e.message}` : ""),
        );
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-1 items-center justify-center p-8">
      <form
        onSubmit={onSubmit}
        className="w-full max-w-md rounded-xl border border-border bg-background p-6 shadow-sm"
      >
        <h1 className="text-lg font-semibold">clearvoiance</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Enter an API key to access the engine at{" "}
          <code className="font-mono text-xs">{apiBaseURL()}</code>. Dev-open
          mode accepts any non-empty key until your first real key is provisioned.
        </p>
        <label htmlFor="api-key" className="mt-6 block text-sm font-medium">
          API key
        </label>
        <input
          id="api-key"
          type="password"
          autoComplete="off"
          autoFocus
          value={key}
          onChange={(e) => setKey(e.target.value)}
          placeholder="clv_live_..."
          className="mt-1 block w-full rounded-md border border-border bg-background px-3 py-2 font-mono text-sm"
        />
        {err && (
          <p className="mt-3 whitespace-pre-line text-sm text-danger">{err}</p>
        )}
        <button
          type="submit"
          disabled={busy || !key.trim()}
          className="mt-5 w-full rounded-md bg-accent px-3 py-2 text-sm font-medium text-accent-foreground disabled:opacity-50"
        >
          {busy ? "Signing in…" : "Sign in"}
        </button>
        <p className="mt-4 text-xs text-muted-foreground">
          {storedAPIKey() ? "Already signed in — submitting will replace the stored key." : null}
        </p>
      </form>
    </div>
  );
}
