"use client";

import { useEffect, useState } from "react";

import { createWSClient, type WSClient } from "@/lib/ws";

// Process-singleton so every useWsTopic call shares one ws connection.
let shared: WSClient | null = null;
function getClient(): WSClient {
  if (!shared) shared = createWSClient();
  return shared;
}

/**
 * Subscribe to a hub topic and expose the latest payload. Each unmount
 * unsubscribes — the shared WS client drops the topic when the last
 * subscriber leaves.
 */
export function useWsTopic<T>(topic: string | null): T | null {
  const [data, setData] = useState<T | null>(null);
  useEffect(() => {
    if (!topic) return;
    const client = getClient();
    return client.subscribe<T>(topic, (payload) => setData(payload));
  }, [topic]);
  return data;
}
