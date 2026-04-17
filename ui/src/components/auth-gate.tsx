"use client";

import { useRouter } from "next/navigation";
import { useSyncExternalStore } from "react";

import { storedAPIKey } from "@/lib/api";

/**
 * Redirects unauthenticated visitors to /login. API keys live in
 * localStorage, so we only know for sure on the client. Using
 * useSyncExternalStore lets React reconcile the value cleanly between
 * server (always null — SSR snapshot) and client (real value) without
 * tripping React's "don't setState inside useEffect" lint.
 */
export function AuthGate({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const key = useSyncExternalStore(
    subscribeLocalStorage,
    () => storedAPIKey(),
    () => null,
  );

  if (!key) {
    if (typeof window !== "undefined") router.replace("/login");
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
        Loading…
      </div>
    );
  }
  return <>{children}</>;
}

function subscribeLocalStorage(onChange: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  window.addEventListener("storage", onChange);
  return () => window.removeEventListener("storage", onChange);
}
