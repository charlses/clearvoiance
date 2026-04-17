"use client";

/**
 * Thin WebSocket client for the engine's /ws hub.
 *
 * Protocol:
 *   - Client sends {type:"auth", api_key} on open.
 *   - Server acks with {type:"message", topic:"__auth", data:{ok:true}}.
 *   - Client sends {type:"subscribe", topic} to start receiving pushes.
 *   - Server sends {type:"message", topic, data: ...} for each publish.
 *
 * Reconnects with capped backoff on transport failures.
 */

import { storedAPIKey, wsBaseURL } from "./api";

type Handler<T = unknown> = (data: T) => void;

export interface WSClient {
  subscribe<T = unknown>(topic: string, handler: Handler<T>): () => void;
  close(): void;
}

const WS_STATE = {
  CONNECTING: 0,
  OPEN: 1,
  CLOSING: 2,
  CLOSED: 3,
};

export function createWSClient(): WSClient {
  let ws: WebSocket | null = null;
  const handlers = new Map<string, Set<Handler<unknown>>>();
  const pendingSubscribes = new Set<string>();
  let reconnectAttempt = 0;
  let closed = false;

  const connect = (): void => {
    if (closed) return;
    const key = storedAPIKey();
    if (!key) return;
    ws = new WebSocket(`${wsBaseURL()}/ws`);

    ws.addEventListener("open", () => {
      reconnectAttempt = 0;
      ws?.send(JSON.stringify({ type: "auth", api_key: key }));
      // Resend every active subscription so reconnects recover topics.
      for (const topic of handlers.keys()) {
        ws?.send(JSON.stringify({ type: "subscribe", topic }));
        pendingSubscribes.delete(topic);
      }
    });

    ws.addEventListener("message", (ev) => {
      let msg: { type?: string; topic?: string; data?: unknown };
      try {
        msg = JSON.parse(ev.data) as typeof msg;
      } catch {
        return;
      }
      if (msg.type !== "message" || !msg.topic) return;
      const set = handlers.get(msg.topic);
      if (!set) return;
      for (const h of set) h(msg.data);
    });

    ws.addEventListener("close", () => {
      if (closed) return;
      // Exponential backoff capped at 10s.
      const delay = Math.min(10_000, 500 * 2 ** reconnectAttempt);
      reconnectAttempt += 1;
      setTimeout(connect, delay);
    });

    ws.addEventListener("error", () => {
      ws?.close();
    });
  };

  connect();

  const send = (payload: Record<string, unknown>): void => {
    if (ws && ws.readyState === WS_STATE.OPEN) {
      ws.send(JSON.stringify(payload));
    } else {
      // Queue — handled by the open handler on next connect.
    }
  };

  return {
    subscribe<T>(topic: string, handler: Handler<T>): () => void {
      let set = handlers.get(topic);
      if (!set) {
        set = new Set();
        handlers.set(topic, set);
        send({ type: "subscribe", topic });
        pendingSubscribes.add(topic);
      }
      set.add(handler as Handler);
      return () => {
        const s = handlers.get(topic);
        if (!s) return;
        s.delete(handler as Handler);
        if (s.size === 0) {
          handlers.delete(topic);
          send({ type: "unsubscribe", topic });
        }
      };
    },
    close(): void {
      closed = true;
      if (ws) ws.close();
    },
  };
}
