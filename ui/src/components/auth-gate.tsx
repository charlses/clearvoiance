"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { api, HTTPError, type User } from "@/lib/api";

type GateState =
  | { status: "pending" }
  | { status: "authed"; user: User }
  | { status: "redirecting" };

/**
 * Asks the engine "who am I?" on mount. On success, renders children.
 * On 401, checks /auth/state: setup_required → /setup, otherwise /login.
 * The session cookie is HttpOnly so we can't peek at it from JS — the
 * only way to know if a user is logged in is to try an authed call.
 */
export function AuthGate({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [state, setState] = useState<GateState>({ status: "pending" });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const user = await api.me();
        if (!cancelled) setState({ status: "authed", user });
      } catch (err) {
        if (cancelled) return;
        if (err instanceof HTTPError && err.status === 401) {
          setState({ status: "redirecting" });
          try {
            const s = await api.authState();
            router.replace(s.setup_required ? "/setup" : "/login");
          } catch {
            // Engine unreachable — surface a login screen, the user
            // can retry from there.
            router.replace("/login");
          }
          return;
        }
        // Anything else (network, 5xx): show an inline error rather
        // than bouncing the user somewhere useless.
        setState({ status: "redirecting" });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [router]);

  if (state.status !== "authed") {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
        Loading…
      </div>
    );
  }
  return <>{children}</>;
}
