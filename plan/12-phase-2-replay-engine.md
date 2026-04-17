# Phase 2 — Replay Engine

**Duration:** 2 weeks.
**Goal:** Take a captured session and replay its events against a target SUT at configurable speedup (1× to 100×). Measure response latencies, error rates, and timing lag.

## Deliverables

### Replay scheduler (`engine/internal/replay/scheduler.go`)

A **hashed hierarchical timer wheel** driving event fire times.

- Input: stream of events from ClickHouse, ordered by `timestamp_ns`.
- Output: at time `t_start + (event.offset_ns / speedup)`, the event is handed off to its dispatcher.
- Resolution: 1 ms (sufficient for the fastest useful speedups).
- Properties:
  - O(1) insertion and tick.
  - Handles > 1M events/second schedule rate.
  - Thread-safe.

Implementation reference: `hashicorp/go-hclog` style timer wheel, or port `facebook/folly/HHWheelTimer`. If off-the-shelf Go libraries don't meet perf, write a minimal wheel (~200 lines).

### Dispatcher registry (`engine/internal/replay/dispatcher/`)

```go
type Dispatcher interface {
    CanHandle(ev *pb.Event) bool
    Dispatch(ctx context.Context, ev *pb.Event, target *TargetConfig) (*DispatchResult, error)
    WarmUp(ctx context.Context, session *Session) error  // pre-connect, pre-auth
    CoolDown(ctx context.Context) error                   // cleanup
}

type DispatchResult struct {
    EventID          string
    ScheduledFireAt  time.Time
    ActualFireAt     time.Time
    LagNs            int64
    ResponseStatus   int
    ResponseDuration time.Duration
    Error            error
    BytesSent        int64
    BytesReceived    int64
}
```

### Per-protocol dispatchers

#### HTTP dispatcher (`engine/internal/replay/workers/http.go`)

- Uses `net/http` with a shared `http.Transport` tuned for throughput:
  - `MaxIdleConnsPerHost: 1000`
  - `MaxConnsPerHost: 0` (unlimited)
  - `DisableKeepAlives: false`
- Worker pool sized by `--http-workers` (default: 100 × speedup).
- Rewrites target URL: captured `http://original-host/path` → `{target_url}/path`.
- Applies auth strategy (see below) before sending.
- Applies payload mutator (see below).
- Sets `User-Agent: clearvoiance-replayer/{version}` and `X-Clearvoiance-Event-Id: {event_id}`.
- Records response to `replay_events` table in ClickHouse.

#### Socket.io dispatcher (`engine/internal/replay/workers/socket.go`)

- Maintains a **pool of live Socket.io client connections** keyed by captured `socket_id`.
- Pre-warms before replay start: for each unique `socket_id` in the session, open a client connection and perform the captured handshake.
- On replay:
  - `CONNECT` event → skip (already warmed).
  - `RECV_FROM_CLIENT` event → emit that event on the corresponding client socket to the server.
  - `EMIT_TO_CLIENT` events → NOT replayed (server emits these naturally in response to client actions; we verify by listening).
  - `DISCONNECT` → disconnect the pooled client.
- Uses `github.com/zishang520/socket.io-client-go` or similar. If none meets our needs, implement a minimal Engine.IO/Socket.IO client.

#### Cron dispatcher (`engine/internal/replay/workers/cron.go`)

- Cron "inbound events" in captured sessions are the trigger + args.
- On replay: POST to the SUT's internal invocation endpoint (see below).
- Requires SUT cooperation: the `@clearvoiance/node` hermetic mode exposes an HTTP endpoint `/__clearvoiance/cron/invoke` when `HERMETIC_MODE` is on (Phase 3 delivery, but dispatcher is built now with a stub endpoint for Phase 2 testing).

#### Webhook dispatcher

- Same as HTTP dispatcher, routed separately for filtering/stats.

#### Queue dispatcher (stub for Phase 7)

- Phase 2 scope: no queue dispatcher. Reserved registration slot.

### Auth strategies (`engine/internal/replay/auth/`)

Pluggable auth token rewrite. Captured events carry JWTs that will have expired by replay time.

```go
type AuthStrategy interface {
    RewriteRequest(ctx context.Context, ev *pb.Event, req *http.Request) error
}
```

Built-in strategies:

#### `AuthNone`

No-op. For endpoints that don't require auth.

#### `AuthJWTResign`

- Config: signing key, algorithm, TTL.
- Extracts JWT from configured header (default `Authorization`).
- Re-signs with fresh `exp` but preserves all other claims.
- Useful when replay target accepts the same signing key as prod.

#### `AuthStaticSwap`

- Config: map of captured `user_id` → replay API key or JWT.
- Looks up user from event metadata and swaps the auth header entirely.
- Default strategy for staging replays.

#### `AuthCallback`

- Config: URL of a user-provided callback service.
- Engine POSTs `{ captured_user_id, event_id }` → expects fresh credentials in response.
- Caches per (user_id, 5-minute TTL).
- Escape hatch for custom auth schemes.

### Payload mutator (`engine/internal/replay/mutator/`)

For scaling replays above 1× (virtual user multiplication):

```go
type Mutator interface {
    Mutate(ctx context.Context, ev *pb.Event, virtualUserIdx int) (*pb.Event, error)
}
```

Built-in mutators:

#### `MutatorNone`

No-op. 1× replay.

#### `MutatorUniqueFields`

- Config: JSONPath expressions to fields that must be unique per virtual user.
- For each VU, applies a consistent transform to matching fields:
  - Emails: `foo@bar.com` → `foo+vu{idx}@bar.com`
  - IDs: append `-vu{idx}`
  - Integers: add `idx * 1_000_000`
- Ensures FK integrity: if `user_id` is mutated, `session.user_id` is also mutated consistently.

#### `MutatorCustomScript`

- Config: path to a Lua or Starlark script.
- Escape hatch for arbitrary per-VU transforms.

### Replay session model

Stored in Postgres:

```sql
CREATE TABLE replays (
    id UUID PRIMARY KEY,
    source_session_id UUID NOT NULL REFERENCES sessions(id),
    target_url TEXT NOT NULL,
    speedup REAL NOT NULL,
    virtual_users INT NOT NULL DEFAULT 1,
    auth_strategy JSONB NOT NULL,
    mutator_config JSONB NOT NULL,
    status TEXT NOT NULL,  -- pending/running/completed/failed/cancelled
    started_at TIMESTAMPTZ,
    finished_at TIMESTAMPTZ,
    events_dispatched BIGINT DEFAULT 0,
    events_failed BIGINT DEFAULT 0,
    p50_latency_ms REAL,
    p95_latency_ms REAL,
    p99_latency_ms REAL,
    max_lag_ms REAL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);
```

Replay results (per-event) in ClickHouse:

```sql
CREATE TABLE replay_events (
    replay_id UUID,
    event_id UUID,
    virtual_user_idx UInt32,
    scheduled_fire_ns Int64,
    actual_fire_ns Int64,
    lag_ns Int64,
    response_status UInt16,
    response_duration_ns Int64,
    error_code LowCardinality(String),
    error_message String CODEC(ZSTD(6)),
    bytes_sent UInt32,
    bytes_received UInt32
) ENGINE = MergeTree()
PARTITION BY (replay_id, toStartOfHour(fromUnixTimestamp64Nano(actual_fire_ns)))
ORDER BY (replay_id, actual_fire_ns, event_id);
```

### Replay CLI

```
clearvoiance replay start <session_id> \
    --target=http://localhost:1337 \
    --speedup=12 \
    --virtual-users=1 \
    --auth=jwt-resign \
    --auth-key-file=./signing.key \
    --mutator=unique-fields

clearvoiance replay status <replay_id>
clearvoiance replay stop <replay_id>
clearvoiance replay results <replay_id>  # summary + slow endpoints
```

### Metrics

Live (Prometheus `/metrics` and internal stream for UI in Phase 6):

- `clearvoiance_replay_events_fired_total{replay_id, protocol}`
- `clearvoiance_replay_lag_seconds{quantile}`
- `clearvoiance_replay_response_duration_seconds{protocol, status, quantile}`
- `clearvoiance_replay_errors_total{replay_id, error_code}`
- `clearvoiance_replay_queue_depth{replay_id}`

## Acceptance criteria

1. Capture a 5-minute session against the example Strapi app (HTTP + socket + cron).
2. Replay at 1×: duration ≈ 5 minutes, response latencies ≈ captured response latencies (within ±20%).
3. Replay at 12×: duration ≈ 25 seconds. Timing lag p99 < 50ms. Dispatch rate ≥ captured_events / (replay_duration) × 0.95.
4. Replay at 100× against a capped target (`--http-workers=50`): scheduler does NOT crash; backpressure is visible in metrics.
5. Auth rewrite: captured sessions with expired JWTs replay successfully under `AuthJWTResign`.
6. Payload mutation: 10 virtual users against a unique-email endpoint → 10 distinct users created.
7. `clearvoiance replay results <id>` returns p50/p95/p99 latency, error rate, slow endpoints.

## Non-goals

- Hermetic mode — real external API calls WILL fire during Phase 2 replays (that's a Phase 3 fix). Test replays should use a dummy target.
- DB observer correlation (Phase 4).
- Live UI visualization (Phase 6).
- Queue dispatcher (Phase 7).

## Implementation order

1. Timer wheel (unit-tested with synthetic load).
2. Dispatcher registry + DispatchResult plumbing.
3. HTTP dispatcher with `AuthNone`.
4. End-to-end: capture → replay at 1× against Strapi example. No auth, no mutation.
5. `replay_events` ClickHouse table + results query.
6. `AuthStaticSwap` and `AuthJWTResign`.
7. `MutatorUniqueFields`.
8. Virtual users fan-out.
9. Socket.io dispatcher with client pool warming.
10. Cron dispatcher with stub invocation endpoint.
11. Speed stress test at 12×, 50×, 100×.
12. Metrics + `/metrics` endpoint.
13. CLI surface.
14. Integration tests in CI (compose-up replay against strapi example).

## Testing

### Unit
- Timer wheel correctness under load (insert 1M events, verify fire order and timing).
- Payload mutators (golden-file tests).
- Auth strategies (golden-file tests).

### Integration
- HTTP dispatcher against mock server under real network.
- Socket.io dispatcher against real `socket.io` server.
- Auth rewrite against a test JWT endpoint.

### E2E
- `just e2e-replay`: capture → replay → assert on `replay_events` contents.

### Perf / chaos
- Replay at 100× — scheduler lag p99 < 50ms.
- Slow target: 200ms per request. Replay at 12×. Verify dispatch doesn't back up the scheduler.

## Open questions

- **Socket.io client library**: no mature Go client exists as of writing. Options: (a) port a subset of `socket.io-client` to Go, (b) spawn Node subprocesses per virtual user, (c) drop socket replay for v1. Decision: prototype (a); fall back to (b) if blocked.
- **100× replay realism**: at 100×, virtual concurrency may exceed SUT's connection pool. Do we artificially limit, or let it crash? Default: let it crash — that's a meaningful result ("your pool size is <foo>, bumped by clearvoiance at 100× for 30s").
- **Replay isolation**: running replay and capture concurrently on the same engine instance. Acceptable, but resource contention. Recommend separate engine instances for "production capture + nightly replay" setups. Document.
- **Transactional SUT resets**: replay mutates the SUT DB. Do we handle snapshot/rollback? v1: caller's responsibility (document "restore your DB between replays"). v2: add a snapshot hook.

## Time budget

| Area | Estimate |
|---|---|
| Timer wheel | 2 days |
| Dispatcher registry + HTTP dispatcher | 2 days |
| Replay results storage (ClickHouse) | 1 day |
| Auth strategies | 1 day |
| Payload mutators + virtual users | 2 days |
| Socket.io dispatcher (hardest) | 3 days |
| Cron dispatcher | 1 day |
| Metrics + CLI | 1 day |
| Integration tests | 1 day |
| Perf harness + tuning | 1 day |
| **Total** | **~15 days** |
