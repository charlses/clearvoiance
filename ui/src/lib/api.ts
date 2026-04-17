// Thin typed client for the engine's REST API. Reads the base URL from the
// NEXT_PUBLIC_CLEARVOIANCE_API env var (default: http://127.0.0.1:9101) and
// the API key from localStorage ("clv.api_key"). For dev-open engines any
// non-empty key works.
//
// We hand-roll this instead of generating from OpenAPI so the surface stays
// tight + the spec can evolve without a codegen step. Shapes mirror what
// `engine/internal/api/rest` emits.

export type SessionStatus = "active" | "stopped";

export interface Session {
  id: string;
  name: string;
  labels: Record<string, string>;
  status: SessionStatus;
  started_at: string;
  stopped_at?: string;
  events_captured: number;
  bytes_captured: number;
}

export interface Replay {
  id: string;
  source_session_id: string;
  target_url: string;
  speedup: number;
  label?: string;
  status: "pending" | "running" | "completed" | "failed" | "cancelled";
  started_at: string;
  finished_at?: string;
  events_dispatched: number;
  events_failed: number;
  events_backpressured: number;
  p50_latency_ms?: number;
  p95_latency_ms?: number;
  p99_latency_ms?: number;
  max_lag_ms?: number;
  error_message?: string;
}

export interface APIKey {
  id: string;
  name: string;
  created_at: string;
  revoked_at?: string;
  last_used_at?: string;
}

export interface APIError {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

const API_KEY_STORAGE = "clv.api_key";

export function apiBaseURL(): string {
  return (
    process.env.NEXT_PUBLIC_CLEARVOIANCE_API ||
    "http://127.0.0.1:9101"
  ).replace(/\/$/, "");
}

export function wsBaseURL(): string {
  const base = apiBaseURL();
  return base.replace(/^http/, "ws");
}

export function storedAPIKey(): string | null {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem(API_KEY_STORAGE);
}

export function setAPIKey(key: string | null): void {
  if (typeof window === "undefined") return;
  if (!key) window.localStorage.removeItem(API_KEY_STORAGE);
  else window.localStorage.setItem(API_KEY_STORAGE, key);
}

export class HTTPError extends Error {
  constructor(
    public status: number,
    public apiError: APIError,
  ) {
    super(apiError.message);
  }
}

async function req<T>(
  path: string,
  init: RequestInit = {},
  opts: { parse?: "json" | "text" | "none" } = {},
): Promise<T> {
  const parse = opts.parse ?? "json";
  const headers = new Headers(init.headers ?? {});
  const key = storedAPIKey();
  if (key) headers.set("Authorization", `Bearer ${key}`);
  if (init.body && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  const resp = await fetch(`${apiBaseURL()}${path}`, {
    ...init,
    headers,
    cache: "no-store",
  });
  if (!resp.ok) {
    // Error envelope shape: {error: {code, message, details}}
    let apiErr: APIError = { code: "HTTP_" + resp.status, message: resp.statusText };
    try {
      const body = (await resp.json()) as { error?: APIError };
      if (body.error) apiErr = body.error;
    } catch {
      /* ignore parse errors on non-JSON failures */
    }
    throw new HTTPError(resp.status, apiErr);
  }
  if (parse === "none") return undefined as T;
  if (parse === "text") return (await resp.text()) as T;
  return (await resp.json()) as T;
}

export const api = {
  // --- Health -----------------------------------------------------------
  health: () => req<{ status: string }>(`/api/v1/health`),
  version: () =>
    req<{ engine: string; api: string; sdk_compat: string }>(`/api/v1/version`),

  // --- Sessions ---------------------------------------------------------
  listSessions: (params?: { status?: SessionStatus; limit?: number }) => {
    const qs = toQS(params);
    return req<{ sessions: Session[]; count: number }>(`/api/v1/sessions${qs}`);
  },
  getSession: (id: string) => req<Session>(`/api/v1/sessions/${id}`),
  stopSession: (id: string) =>
    req<{ id: string; status: string }>(`/api/v1/sessions/${id}/stop`, {
      method: "POST",
      body: "{}",
    }),
  deleteSession: (id: string) =>
    req<void>(`/api/v1/sessions/${id}`, { method: "DELETE" }, { parse: "none" }),
  sessionEvents: (id: string, limit = 100) =>
    req<{ session_id: string; events: EventView[]; count?: number; note?: string }>(
      `/api/v1/sessions/${id}/events?limit=${limit}`,
    ),

  // --- Replays ----------------------------------------------------------
  listReplays: (params?: { status?: Replay["status"]; limit?: number }) => {
    const qs = toQS(params);
    return req<{ replays: Replay[]; count: number }>(`/api/v1/replays${qs}`);
  },
  getReplay: (id: string) => req<Replay>(`/api/v1/replays/${id}`),
  replayEvents: (id: string, limit = 100) =>
    req<{ replay_id: string; events: ReplayEventRow[]; count?: number; note?: string }>(
      `/api/v1/replays/${id}/events?limit=${limit}`,
    ),
  cancelReplay: (id: string) =>
    req<{ id: string; cancelled: boolean }>(`/api/v1/replays/${id}/cancel`, {
      method: "POST",
      body: "{}",
    }),
  startReplay: (body: {
    source_session_id: string;
    target_url: string;
    speedup?: number;
    label?: string;
    target_duration_ms?: number;
    http_workers?: number;
  }) =>
    req<{ id: string; status: string; started_at: string }>(`/api/v1/replays`, {
      method: "POST",
      body: JSON.stringify(body),
    }),

  // --- DB observations --------------------------------------------------
  dbTopSlow: (replayID: string, limit = 20) =>
    req<{ replay_id: string; rows: DbSlowRow[] }>(
      `/api/v1/replays/${replayID}/db/top-slow-queries?limit=${limit}`,
    ),
  dbByEndpoint: (replayID: string, limit = 20) =>
    req<{ replay_id: string; rows: DbEndpointRow[] }>(
      `/api/v1/replays/${replayID}/db/by-endpoint?limit=${limit}`,
    ),
  dbDeadlocks: (replayID: string, limit = 50) =>
    req<{ replay_id: string; rows: DbLockWaitRow[]; note?: string }>(
      `/api/v1/replays/${replayID}/db/deadlocks?limit=${limit}`,
    ),

  // --- API keys ---------------------------------------------------------
  listAPIKeys: () => req<{ keys: APIKey[]; count: number }>(`/api/v1/api-keys`),
  createAPIKey: (name: string) =>
    req<{ id: string; name: string; key: string; created_at: string; warning: string }>(
      `/api/v1/api-keys`,
      { method: "POST", body: JSON.stringify({ name }) },
    ),
  revokeAPIKey: (id: string) =>
    req<void>(`/api/v1/api-keys/${id}`, { method: "DELETE" }, { parse: "none" }),

  // --- Config + metrics -------------------------------------------------
  config: () => req<ConfigView>(`/api/v1/config`),
  metricsText: () => req<string>(`/api/v1/metrics`, {}, { parse: "text" }),
};

// --- shapes returned by the engine ------------------------------------

export interface EventView {
  id: string;
  timestamp_ns: number;
  offset_ns: number;
  adapter: string;
  event_type: string;
  http_method?: string;
  http_path?: string;
  http_status?: number;
  metadata?: Record<string, string>;
  raw_pb_b64?: string;
}

export interface ReplayEventRow {
  ReplayID: string;
  EventID: string;
  ScheduledFireNs: number;
  ActualFireNs: number;
  LagNs: number;
  ResponseStatus: number;
  ResponseDurationNs: number;
  ErrorCode: string;
  ErrorMessage: string;
  BytesSent: number;
  BytesReceived: number;
  HTTPMethod: string;
  HTTPPath: string;
  HTTPRoute: string;
}

export interface DbSlowRow {
  observation_type: string;
  event_id: string;
  query_fingerprint: string;
  query_text: string;
  occurrences: number;
  avg_ms: number;
  p95_ms: number;
  max_ms: number;
  first_observed_at: string;
}

export interface DbEndpointRow {
  http_method: string;
  http_route: string;
  observations: number;
  total_db_ms: number;
  avg_ms: number;
  max_ms: number;
}

export interface DbLockWaitRow {
  event_id: string;
  query_fingerprint: string;
  query_text: string;
  occurrences: number;
  avg_ms: number;
  max_ms: number;
  wait_event_type: string;
  wait_event: string;
}

export interface ConfigView {
  engine: string;
  version: string;
  grpc_addr?: string;
  http_addr?: string;
  clickhouse_dsn?: string;
  postgres_dsn?: string;
  minio_endpoint?: string;
  features: Record<string, boolean>;
}

function toQS(params?: Record<string, unknown>): string {
  if (!params) return "";
  const parts = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  return parts.length ? `?${parts.join("&")}` : "";
}
