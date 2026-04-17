# Phase 1 — Capture MVP

**Status:** Shipped 2026-04-17.
**Goal:** A Node app using `@clearvoiance/node` can capture HTTP + Socket.io + cron events to the engine, which persists them to ClickHouse and MinIO. End-to-end, wire-level, real storage.

This is the phase that proves the architecture works. Everything after this is additive.

## Deliverables

### SDK (`@clearvoiance/node` v0.1.0-alpha)

#### Core

- `createClient(config)` — main entry point. Returns a `Client` instance.
- `Client` responsibilities:
  - gRPC connection management with auto-reconnect
  - Event batching (from [`04-protocol-spec.md`](./04-protocol-spec.md))
  - Local WAL persistence on engine unreachable
  - Backpressure handling
  - Graceful shutdown (flush before exit)

Config shape:

```ts
import { createClient } from '@clearvoiance/node';

const client = createClient({
  engine: {
    url: 'grpc://localhost:9000',
    apiKey: process.env.CLEARVOIANCE_API_KEY!,
    tls: false,  // dev default
  },
  session: {
    name: 'strapi-local',
    sampleRate: 1.0,
  },
  redaction: {
    headers: ['authorization', 'cookie', 'x-api-key'],
    jsonPaths: ['$.password', '$.creditCard', '$.ssn'],
    redactAuthorization: true,
    redactCookies: true,
  },
  buffer: {
    maxEvents: 10000,
    maxBatchSize: 100,
    flushIntervalMs: 100,
    walDir: '/var/lib/clearvoiance/wal',
  },
  userExtractor: (ctx) => ctx.state?.user?.id ?? null,
});
```

#### HTTP adapter: Express + Strapi

`@clearvoiance/node/http/express`:

```ts
import { captureHttp } from '@clearvoiance/node/http/express';
app.use(captureHttp(client));
```

Responsibilities:
- Mount as early middleware — before body parser.
- Capture raw body via stream tee, not the post-parse body.
- Extract: method, path, headers, body, status, duration, source IP, user.
- Match against Express route after the fact to fill `route_template`.
- Measure duration with `performance.now()`.

`@clearvoiance/node/http/strapi`:
- Strapi uses Koa under the hood but has its own middleware conventions (`src/middlewares/`).
- Provides a Strapi-style middleware factory: `export default (config, { strapi }) => captureHttp(client)`.
- Integration notes in the adapter README.

Raw body capture is shared: `src/adapters/http/raw-body.ts` — a utility that pipes the request stream through a `PassThrough`, buffering up to `maxBodyInlineBytes`, with the tail streamed directly to MinIO via presigned URL.

#### Socket.io adapter

`@clearvoiance/node/socket/socketio`:

```ts
import { captureSocketIO } from '@clearvoiance/node/socket/socketio';
captureSocketIO(io, client);
```

Wraps:
- `io.on('connection')` — emits `CONNECT` event with handshake.
- `socket.on` (via Proxy or monkeypatch on `socket.onevent`) — emits `RECV_FROM_CLIENT` per incoming event.
- `socket.emit` / `socket.to(...).emit` / `io.emit` — emits `EMIT_TO_CLIENT` per outgoing event.
- `socket.on('disconnect')` — emits `DISCONNECT`.
- Namespace awareness: attach to all namespaces by default, or a configured list.

Binary payloads handled: treat as `application/octet-stream`, blob-ref if over threshold.

#### Cron adapter: node-cron + agenda

`@clearvoiance/node/cron/node-cron`:

```ts
import cron from 'node-cron';
import { wrapCron } from '@clearvoiance/node/cron/node-cron';
const captured = wrapCron(cron, client);
captured.schedule('* * * * *', async () => { ... }, { name: 'heartbeat' });
```

- Wraps `schedule` to emit a `CronEvent` on each invocation.
- Captures args (if task accepts them), duration, status, error.
- Requires a `name` option for identification (enforced, else warns).

`@clearvoiance/node/cron/agenda`:
- Wraps `agenda.define` similarly.

### Engine

#### gRPC Capture service

`engine/internal/api/grpc/capture_server.go`:
- Implements `StreamEvents`, `StartSession`, `StopSession`, `GetBlobUploadURL`, `Heartbeat`.
- Authenticates via API key on Handshake. Caches session→apiKey binding for subsequent batches.
- Writes events to ClickHouse via the storage layer.
- Issues presigned MinIO URLs for blob uploads.

#### ClickHouse storage

`engine/internal/storage/clickhouse/`:
- Connection pool via `github.com/ClickHouse/clickhouse-go/v2`.
- Migrations via `golang-migrate` running at engine startup.
- `events.go`: `InsertBatch(events []Event)` using async insert mode for throughput.
- Query API for later phases: `ReadSession(sessionID) <-chan Event`.

#### MinIO storage

`engine/internal/storage/blob/minio.go`:
- Bucket per environment (e.g. `clearvoiance-events-dev`).
- Key layout: `sessions/{session_id}/blobs/{sha256}`.
- Presigned PUT URLs with 10-minute expiry.
- Dedup check: `HEAD` before issuing URL; if exists, return existing ref.

#### Postgres metadata

`engine/internal/storage/postgres/`:
- Schema:
  - `sessions (id, name, started_at, stopped_at, status, labels, config)`
  - `api_keys (id, key_hash, name, created_at, revoked_at)`
  - `users (id, email, password_hash, created_at)` — minimal for v1 single-admin
- Migrations via `golang-migrate`.
- Queries via `sqlc`.

#### Session lifecycle

`engine/internal/sessions/manager.go`:
- `StartSession` → insert row with status=`active`.
- `StopSession` → update status=`closed`, compute stats.
- Heartbeat renews last-seen; sessions without heartbeat for 5 minutes auto-close.

#### CLI commands

`engine/cmd/clearvoiance/`:
- `clearvoiance serve` — start engine (gRPC + REST placeholder).
- `clearvoiance session start --name=X` → prints session ID + API key for SDK.
- `clearvoiance session stop <id>`.
- `clearvoiance session list`.
- `clearvoiance session inspect <id>` — metadata + first/last events.

### Infrastructure

`deploy/docker-compose.yml` for Phase 1:

```yaml
services:
  clickhouse:
    image: clickhouse/clickhouse-server:24-alpine
    ports: ["8123:8123", "9000:9000"]
    volumes: [clickhouse_data:/var/lib/clickhouse]

  minio:
    image: minio/minio:latest
    command: server /data --console-address ":9001"
    environment: { MINIO_ROOT_USER: dev, MINIO_ROOT_PASSWORD: devdevdev }
    ports: ["9002:9000", "9001:9001"]
    volumes: [minio_data:/data]

  postgres:
    image: postgres:16-alpine
    environment: { POSTGRES_PASSWORD: dev, POSTGRES_DB: clearvoiance }
    volumes: [pg_data:/var/lib/postgresql/data]

  engine:
    build: ../engine
    depends_on: [clickhouse, minio, postgres]
    environment:
      CLEARVOIANCE_CLICKHOUSE_DSN: clickhouse://default@clickhouse:9000/default
      CLEARVOIANCE_MINIO_ENDPOINT: minio:9000
      CLEARVOIANCE_POSTGRES_DSN: postgres://postgres:dev@postgres/clearvoiance
      CLEARVOIANCE_GRPC_PORT: 9100
    ports: ["9100:9100"]

volumes: { clickhouse_data, minio_data, pg_data }
```

### Example app

`examples/strapi-basic/`:
- Small Strapi 4.x app with two content types.
- SDK wired up via middleware.
- `docker-compose.yml` that spins up the example + engine stack.
- README showing before/after patterns for Strapi integration.

## Acceptance criteria

1. `docker compose up` brings up engine + storage.
2. `clearvoiance session start --name=demo` returns a session ID and API key.
3. Example Strapi app, started with the session ID + API key in env, captures:
   - Every HTTP request and response (bodies, headers, status, duration)
   - Socket.io connections, emits, receives, disconnects
   - Cron job invocations
4. Query ClickHouse directly: `SELECT count() FROM events WHERE session_id = '...'` returns the expected count.
5. Query MinIO: blob bucket contains objects for large payloads.
6. Kill engine, SDK continues to buffer to WAL. Restart engine, SDK drains WAL. No events lost.
7. `clearvoiance session stop <id>` closes the session; subsequent events are rejected.
8. SDK overhead at 1000 rps: < 5% CPU increase, < 10MB RSS increase (measured on reference Strapi app).

## Non-goals (deferred to later phases)

- Replay (Phase 2).
- Outbound capture (Phase 3).
- Hermetic mode (Phase 3).
- DB observer (Phase 4).
- UI (Phase 6).
- Adapters for frameworks beyond Express/Strapi (Phase 7).

## Implementation order (suggested)

Each bullet is ~½ to 1 day:

1. Proto definitions finalized and regenerated.
2. Engine: gRPC server skeleton, Handshake + StartSession working.
3. Engine: ClickHouse writer, happy-path insert tests with testcontainers.
4. Engine: StreamEvents with BatchAck.
5. SDK: gRPC client + batcher + handshake.
6. SDK: event builder + redaction.
7. SDK: HTTP Express adapter (raw body capture).
8. **End-to-end smoke test #1: HTTP capture works.**
9. SDK: HTTP Strapi adapter.
10. Engine: MinIO + blob upload flow.
11. SDK: large body → blob-ref path.
12. **End-to-end smoke test #2: blobs work.**
13. SDK: Socket.io adapter.
14. **End-to-end smoke test #3: sockets work.**
15. SDK: cron adapters.
16. **End-to-end smoke test #4: cron works.**
17. Engine: WAL drain handling (SDK retry with offline periods).
18. Engine: heartbeat + backpressure.
19. CLI commands.
20. Docker compose polishing + example app.
21. Integration test suite (Go + Node) running in CI.
22. Perf benchmark (1000 rps overhead test).

## Testing

### SDK unit tests
- Event builder (each adapter → correct Event shape).
- Redaction (verify jsonpath and header rules).
- Batcher (batching rules, flush timing).
- WAL write/read round-trip.

### SDK integration tests (testcontainers)
- Spin up engine in a container, full client flow, verify ClickHouse rows.
- Chaos test: kill engine mid-stream, verify WAL drain works.

### Engine unit tests
- ClickHouse batch insert correctness.
- gRPC handshake auth.
- MinIO presigned URL generation.

### Engine integration tests
- testcontainers-go with real ClickHouse + MinIO + Postgres.
- E2E: simulated SDK client → engine → verify storage.

### E2E (compose + real Strapi)
- Run from `examples/strapi-basic/`. Hit endpoints, verify ClickHouse has correct events.

## Open questions

- **Strapi raw body capture:** Strapi's body parser runs as a core Koa middleware; capturing raw body may require patching before Strapi's parser. Investigate whether a Strapi-provided hook exists.
- **Socket.io binary events:** msgpack vs. socket.io's default encoder. SDK must detect and encode correctly for the captured payload.
- **Cron invocation args:** serialization for non-JSON args (functions, class instances). Document limitations.
- **WAL durability:** fsync every write, or batched fsync? Tradeoff of durability vs. overhead. Default to batched (every 10 batches or 1s) with an option for strict.

## Time budget

| Area | Estimate |
|---|---|
| Engine: gRPC server + ClickHouse + Postgres | 3 days |
| Engine: MinIO + blob flow | 1 day |
| SDK: client core + transport | 2 days |
| SDK: HTTP adapters (Express + Strapi) | 2 days |
| SDK: Socket.io adapter | 2 days |
| SDK: cron adapters | 1 day |
| Docker compose + example + CLI | 2 days |
| Integration & E2E tests | 2 days |
| Polish, benchmark, buffer time | 1 day |
| **Total** | **~14 days** |
