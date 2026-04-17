"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";

/**
 * TanStack Query root. Everything reactive about engine data flows through
 * here: REST calls via `useQuery`, live progress from the WebSocket gets
 * folded into the same cache via `queryClient.setQueryData` so one consumer
 * doesn't need two abstractions.
 *
 * Defaults: retries disabled for mutations (user-visible toasts handle
 * retry UX), stale time 5s for reads so navigating between pages feels
 * instant without doubling our request count.
 */
export function Providers({ children }: { children: React.ReactNode }) {
  const [qc] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 5_000,
            refetchOnWindowFocus: false,
            retry: 1,
          },
          mutations: {
            retry: 0,
          },
        },
      }),
  );
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}
