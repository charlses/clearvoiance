// Thin typed client for the engine's REST API. Reads the base URL from
// NEXT_PUBLIC_CLEARVOIANCE_API (default: http://127.0.0.1:9101). Auth is
// via session cookie (clv_session) — every request goes out with
// credentials:"include" so the cookie travels cross-origin under CORS.
//
// API keys are managed from inside an authed session (the /settings/api-keys
// page), but the dashboard itself never logs in with an API key. That path
// is for SDK / programmatic clients only.
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

export interface User {
  id: string;
  email: string;
  role: string;
  created_at: string;
  last_login_at?: string;
}

export interface AuthState {
  setup_required: boolean;
}

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

// External marketing + docs site. Baked in at build time via
// NEXT_PUBLIC_CLEARVOIANCE_DOCS; defaults to the public vercel deploy so
// self-hosters get working links out of the box.
export function docsURL(path = ""): string {
  const base = (
    process.env.NEXT_PUBLIC_CLEARVOIANCE_DOCS ||
    "https://clearvoiance.vercel.app"
  ).replace(/\/$/, "");
  return path ? `${base}${path.startsWith("/") ? path : "/" + path}` : base;
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
  if (init.body && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  const resp = await fetch(`${apiBaseURL()}${path}`, {
    ...init,
    headers,
    cache: "no-store",
    // Sends the clv_session cookie on cross-origin requests. The engine's
    // CORS middleware must include the dashboard origin + Allow-Credentials.
    credentials: "include",
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
  // --- Auth -------------------------------------------------------------
  authState: () => req<AuthState>(`/api/v1/auth/state`),
  setup: (email: string, password: string) =>
    req<{ user: User }>(`/api/v1/auth/setup`, {
      method: "POST",
      body: JSON.stringify({ email, password }),
    }),
  login: (email: string, password: string) =>
    req<{ user: User }>(`/api/v1/auth/login`, {
      method: "POST",
      body: JSON.stringify({ email, password }),
    }),
  logout: () =>
    req<{ status: string }>(`/api/v1/auth/logout`, {
      method: "POST",
      body: "{}",
    }),
  me: () => req<User>(`/api/v1/auth/me`),
  changePassword: (current: string, next: string) =>
    req<{ status: string }>(`/api/v1/auth/change-password`, {
      method: "POST",
      body: JSON.stringify({
        current_password: current,
        new_password: next,
      }),
    }),

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

  // --- Runtime (memory/CPU/event-loop/pool) -----------------------------
  runtimeSummary: (replayID: string) =>
    req<RuntimeSummary>(`/api/v1/replays/${replayID}/runtime/summary`),
  runtimeSamples: (replayID: string) =>
    req<{ replay_id: string; points: RuntimePoint[] }>(
      `/api/v1/replays/${replayID}/runtime`,
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

  // --- Monitors (remote-controlled capture clients) ---------------------
  listMonitors: () =>
    req<{ monitors: Monitor[]; count: number }>(`/api/v1/monitors`),
  getMonitor: (name: string) =>
    req<Monitor>(`/api/v1/monitors/${encodeURIComponent(name)}`),
  startMonitor: (
    name: string,
    body: {
      session_name?: string;
      session_labels?: Record<string, string>;
      flush_timeout_ms?: number;
    } = {},
  ) =>
    req<{
      monitor_name: string;
      session_id: string;
      session_name: string;
      pushed_to_online: number;
      note?: string;
    }>(`/api/v1/monitors/${encodeURIComponent(name)}/start`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  stopMonitor: (name: string) =>
    req<{
      monitor_name: string;
      session_id: string;
      pushed_to_online: number;
      note?: string;
    }>(`/api/v1/monitors/${encodeURIComponent(name)}/stop`, {
      method: "POST",
      body: "{}",
    }),

  // --- Config + metrics -------------------------------------------------
  config: () => req<ConfigView>(`/api/v1/config`),
  metricsText: () => req<string>(`/api/v1/metrics`, {}, { parse: "text" }),
};

// --- shapes returned by the engine ------------------------------------

export interface Monitor {
  name: string;
  display_name: string;
  labels: Record<string, string>;
  capture_enabled: boolean;
  active_session_id?: string;
  sdk_language?: string;
  sdk_version?: string;
  last_seen_at: string;
  created_at: string;
  online_replicas: number;
  online: boolean;
}

export interface EventView {
  id: string;
  timestamp_ns: number;
  offset_ns: number;
  duration_ns?: number;
  adapter: string;
  event_type: string;
  http_method?: string;
  http_path?: string;
  http_route?: string;
  http_status?: number;
  request_headers?: Record<string, string[]>;
  response_headers?: Record<string, string[]>;
  request_body_preview?: string;
  request_body_size?: number;
  request_body_truncated?: boolean;
  response_body_preview?: string;
  response_body_size?: number;
  response_body_truncated?: boolean;
  source_ip?: string;
  user_id?: string;
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

export interface RuntimeSummary {
  samples: number;
  window_start_ns: number;
  window_end_ns: number;
  mem_rss_peak: number;
  mem_rss_min: number;
  event_loop_p99_peak_ms: number;
  pool_saturated_sec: number;
  pool_max: number;
  gc_total_pause_ms: number;
}

export interface RuntimePoint {
  sampled_at: string;
  mem_rss: number;
  mem_heap_used: number;
  mem_heap_total: number;
  event_loop_p50_ns: number;
  event_loop_p99_ns: number;
  event_loop_max_ns: number;
  gc_count: number;
  gc_total_pause_ns: number;
  cpu_user_us: number;
  cpu_system_us: number;
  active_handles: number;
  active_requests: number;
  db_pool_used: number;
  db_pool_free: number;
  db_pool_pending: number;
  db_pool_max: number;
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
