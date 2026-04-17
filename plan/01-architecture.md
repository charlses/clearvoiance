# 01 — Architecture

## System overview

clearvoiance has four planes that communicate over well-defined contracts:

1. **Capture plane** — SDK libraries embedded in the SUT that emit events.
2. **Storage plane** — event store (ClickHouse) + blob store (S3/MinIO) + metadata (Postgres).
3. **Replay plane** — Go engine that reads captured events and fires them at the SUT with compressed timing.
4. **Control plane** — REST/WebSocket API + Next.js UI for operators.

```
                         ┌──────────────────────────────┐
                         │      System Under Test       │
                         │  ┌────────────────────────┐  │
                         │  │   clearvoiance SDK     │  │
                         │  │  • HTTP middleware     │  │
                         │  │  • Socket wrapper      │  │
                         │  │  • Cron wrapper        │  │
                         │  │  • Queue wrapper       │  │
                         │  │  • Outbound interceptor│  │
                         │  └──────────┬─────────────┘  │
                         └─────────────┼────────────────┘
                                       │ gRPC stream
                                       ↓
┌──────────────────────────────────────────────────────────────┐
│                      Go Engine                                │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐    │
│  │   Ingest     │  │   Replay     │  │   Control API    │    │
│  │   gRPC       │  │   Scheduler  │  │   REST + WS      │    │
│  │   Server     │  │   + Workers  │  │                  │    │
│  └──────┬───────┘  └──────┬───────┘  └────────┬─────────┘    │
└─────────┼─────────────────┼───────────────────┼──────────────┘
          ↓                 ↑                   ↑
   ┌──────────────┐  ┌────────────┐     ┌────────────┐
   │  ClickHouse  │  │   MinIO    │     │  Postgres  │
   │  (events)    │  │  (blobs)   │     │ (metadata) │
   └──────────────┘  └────────────┘     └────────────┘
                                                ↑
                                  ┌─────────────┴─────────────┐
                                  │   Next.js Control UI      │
                                  └───────────────────────────┘
                                                ↑
                                  ┌─────────────┴─────────────┐
                                  │    DB Observer (Go)       │
                                  │  pg_stat_activity poller  │
                                  │  slow query log tail      │
                                  │  lock snapshot on deadlock│
                                  └───────────────────────────┘
                                                ↑
                                           ┌─────────┐
                                           │  SUT    │
                                           │ Postgres│
                                           └─────────┘
```

## Data flow: capture

1. Request/event arrives at SUT.
2. SDK adapter intercepts it (middleware, wrapper, proxy).
3. SDK builds `Event` protobuf, tags with `session_id`, enriches with metadata (user_id extractor, trace context).
4. SDK redacts PII per configured rules.
5. Payloads over threshold (default 64KB) are streamed to MinIO; event record holds `body_ref` pointer.
6. Events are batched (100 events or 100ms, whichever first) and streamed to the engine via gRPC.
7. On gRPC unavailability, events land in a local WAL file (`/var/lib/clearvoiance/wal/`) for later flush.
8. Engine ingest server writes events to ClickHouse (`events` table, partitioned by `session_id`, `toStartOfHour(timestamp)`).

## Data flow: replay

1. Operator triggers replay via API or UI: `POST /replays { session_id, target_url, speedup, auth_strategy }`.
2. Engine spawns replay session. Loads DB snapshot (if provided) into SUT's Postgres.
3. Engine streams events from ClickHouse ordered by `timestamp_ns`.
4. Scheduler (timer wheel) schedules each event's fire time: `t0 + (event.timestamp_ns - session.start_ns) / speedup`.
5. Worker pool dispatches events per protocol:
   - HTTP events → `http.Client` pool
   - Socket events → pre-warmed `socket.io-client` pool
   - Cron events → direct invocation endpoint on SUT
   - Webhook events → `http.Client` pool (same as HTTP)
6. Per-event pre-processing:
   - **Auth strategy** rewrites tokens (re-sign JWT, swap OAuth, etc.)
   - **Payload mutator** rewrites unique fields for virtual-user fan-out
   - **Outbound correlator** ensures captured outbound responses are available for the SUT's hermetic layer
7. Worker records actual response: latency, status, error, lag-from-scheduled.
8. DB observer runs in parallel, attributing slow queries to replay events via `application_name` tagging.
9. On replay completion, engine writes a `replay_result` summary and surfaces it via API.

## Adapter plugin architecture

Adapters live at two layers:

### SDK-side adapters (per language/framework)

Each adapter is a thin module that plugs into a framework and emits canonical Events. They share a common `Client` that handles batching and transport.

```
sdk-node/
├── src/
│   ├── client/               # shared transport client
│   ├── core/                 # event builder, redaction, metadata
│   └── adapters/
│       ├── http/
│       │   ├── express.ts
│       │   ├── fastify.ts
│       │   ├── koa.ts
│       │   ├── strapi.ts
│       │   └── nest.ts
│       ├── socket/
│       │   └── socketio.ts
│       ├── cron/
│       │   ├── node-cron.ts
│       │   ├── agenda.ts
│       │   └── bullmq.ts
│       ├── queue/
│       │   ├── bullmq.ts
│       │   ├── amqplib.ts
│       │   └── kafkajs.ts
│       └── outbound/
│           ├── http.ts       # wraps global http/https
│           ├── undici.ts
│           ├── axios.ts
│           └── nodemailer.ts
```

### Engine-side dispatchers (per protocol)

The replay engine has one dispatcher per protocol. Dispatchers are registered at startup:

```go
// engine/replay/dispatcher/registry.go
type Dispatcher interface {
    CanHandle(eventType pb.EventType) bool
    Dispatch(ctx context.Context, ev *pb.Event, target *TargetConfig) (*DispatchResult, error)
}

// registered at startup:
registry.Register(&httpDispatcher{})
registry.Register(&socketDispatcher{})
registry.Register(&cronDispatcher{})
registry.Register(&queueDispatcher{})
```

## Hermetic mode

When `CLEARVOIANCE_HERMETIC=true` is set in the SUT environment, the SDK activates outbound interception:

- Outbound HTTP: patched globally. Each request's `(method, host, path, body_hash)` is looked up against the captured outbound responses for the current replay. Hit → return captured response. Miss → configurable policy (strict: error; loose: return 200 `{}`; passthrough: allow real call, log warning).
- Native cron scheduler is disabled — the engine fires cron events instead.
- Email/Telegram/S3/OpenAI/etc. clients route through the outbound HTTP patch.

## Boundaries and contracts

| Boundary | Contract |
|---|---|
| SDK ↔ Engine | gRPC + Protobuf (`proto/clearvoiance/v1/`) |
| Engine ↔ ClickHouse | SQL schema (`engine/storage/clickhouse/schema.sql`) |
| Engine ↔ Control UI | REST + WebSocket (OpenAPI spec auto-generated) |
| Engine ↔ DB Observer | In-process (same binary) OR gRPC if run as sidecar |
| CLI ↔ Engine | REST (uses Control API) |

All cross-process contracts are versioned (`/v1/`, `/v2/`). Breaking changes require new version prefix.

## Deployment topologies

### Self-host, single-box (dev / small teams)
```
docker-compose.yml:
  - engine
  - clickhouse
  - minio
  - postgres (metadata)
  - ui
  SUT connects to engine:9000 (gRPC).
```

### Self-host, clustered (production scale)
```
Kubernetes (Helm chart):
  - engine (3+ replicas behind load balancer)
  - clickhouse (StatefulSet with replication)
  - minio (distributed mode)
  - postgres (operator-managed, e.g. CNPG)
  - ui (2+ replicas)
  Ingress → engine (gRPC) and UI (HTTPS).
```

### Embedded (CI-friendly)
```
Single Go binary with embedded SQLite (metadata) + DuckDB (events) + local FS (blobs).
For smoke tests, CI, or demos. Not production.
```

## Security boundaries

- SDK ↔ Engine: mTLS + API key. SDK holds API key in env var.
- Control API: API key or OAuth proxy. No public endpoint without auth.
- Events at rest: encrypted in ClickHouse via column-level encryption for flagged PII fields.
- Blobs at rest: S3/MinIO server-side encryption (SSE-S3 or SSE-KMS).
- Hermetic mode has a `strict` default to prevent accidental outbound leaks during replay.

Full security spec in [20-security.md](./20-security.md).

## Scaling characteristics

Target: capture + replay a service doing 10,000 rps for 1 hour.

- **Events:** 10K rps × 3600s = 36M events. At ~500 bytes each avg → 18GB. ClickHouse handles this in a single node trivially.
- **Blobs:** assume 10% of events have bodies > 64KB. 3.6M blobs, avg 200KB → 720GB. MinIO cluster or S3 required.
- **Ingest throughput:** 10K events/s per engine instance. Target 5× headroom → 50K events/s per instance with batching.
- **Replay at 100×:** 1M events/s dispatch rate. Single Go process with goroutine pool can do this; worker pool sized per protocol.

## Performance budgets

| Component | Budget |
|---|---|
| SDK capture overhead | < 5% CPU @ 1000 rps |
| SDK memory | < 10MB additional |
| Engine ingest latency | < 50ms p99 (SDK batch → ClickHouse row) |
| Replay timing lag | < 50ms p99 between scheduled and actual fire time |
| DB observer overhead on SUT Postgres | < 2% CPU, zero query performance impact |

Any component missing its budget blocks the phase it's in.
