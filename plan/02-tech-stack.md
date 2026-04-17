# 02 — Tech Stack

Every choice below has a why. Don't deviate without updating this doc and `22-open-questions.md`.

## Core engine: **Go 1.22+**

- **Concurrency model.** Goroutines + channels fit the replay engine's "fire N events per ms at a worker pool" shape perfectly. Node's single-threaded loop chokes at 10K+ events/s dispatch; Go handles it without thinking about it.
- **Static binary.** Single `clearvoiance` executable, trivial to ship in Docker or release tarballs. No runtime dependency hell.
- **Ecosystem.** `net/http`, `gorilla/websocket`, `grpc-go`, `pgx`, ClickHouse Go driver are all top-tier and well-maintained.
- **Ops-friendly.** Fast startup, predictable memory, good `pprof` story — matters when the engine itself is under load.
- **Not Rust because:** smaller pool of contributors in the Go ecosystem for backend tooling, longer compile times, harder onboarding for a public OSS project. Performance delta doesn't justify the hiring/contributor penalty for this workload.

## Node SDK: **TypeScript (ESM + CJS dual)**

- First-class `@clearvoiance/node` package published to npm.
- **TypeScript** for the API surface — types are the documentation.
- **Dual build** (ESM + CJS) to support both modern and legacy projects without config gymnastics.
- Transport to engine: **gRPC via `@grpc/grpc-js`** (pure JS, no native deps — keeps the package simple to install).
- Minimal runtime deps: gRPC client, protobuf runtime, `pino` for internal logging, nothing else. Goal: install size < 5MB.

## Event storage: **ClickHouse**

- **Columnar, designed for time-series.** Range scans over billions of events by timestamp are cheap.
- Handles 100K+ inserts/s per node comfortably.
- SQL interface; no custom query language to learn.
- Supports `TTL` for automatic event expiration.
- `MergeTree` with `ORDER BY (session_id, timestamp_ns)` gives perfect ordered reads for replay.
- OSS, self-hostable, Apache-2.0.
- **Not Mongo because:** Mongo's per-document overhead and lack of columnar compression makes it 5-10x more expensive for this workload. Mongo was my earlier suggestion to the user in discussion — this is the considered answer.
- **Not Postgres because:** Postgres time-series performance falls off past ~10M rows per table. Workable for small demos but not the target scale.
- **Not Timescale because:** ClickHouse wins on raw ingest rate and compression. Timescale's advantage (joins with relational Postgres data) doesn't apply here — we don't join events.

## Blob storage: **S3-compatible (MinIO for self-host)**

- Event bodies over threshold (default 64KB) are offloaded to blob storage.
- MinIO for self-host single-box; AWS S3, GCS, R2 all compatible via the AWS SDK.
- Go: `aws-sdk-go-v2` with custom endpoint for non-AWS providers.
- Node SDK uploads directly to presigned URLs issued by the engine (avoids proxying large bodies through gRPC).

## Metadata storage: **Postgres 15+**

- Sessions, replay runs, API keys, user config, audit log.
- Small, relational data. Postgres is the obvious choice.
- **Not SQLite by default** — operational simplicity of SQLite is nice but we want multi-replica engine deployments.
- Migration tool: **`golang-migrate`** (pure SQL migrations, no ORM).

## Database access: **`pgx` (Go) + raw SQL**

- No ORM. `pgx` gives us pooling, prepared statements, COPY protocol for bulk inserts, and type-safety via `sqlc`.
- `sqlc` to generate type-safe query code from SQL files (`engine/storage/queries/*.sql` → generated Go).

## Transport: **gRPC + Protocol Buffers**

- SDK → Engine event stream is gRPC bidirectional streaming.
- Protos live in `proto/clearvoiance/v1/` at the repo root, generate Go + TS clients.
- Tooling: **`buf`** for linting, breaking-change detection, and code generation.
- **Not REST for events because:** streaming + binary is significantly more efficient and gRPC gives us backpressure for free.

## Frontend: **Next.js 14 + TypeScript + Tailwind + shadcn/ui**

- Matches the user's existing stack (`repufox-new`, `orexus-website`, `coldfire-frontend`) → easier for him to own long-term.
- App Router.
- State: **TanStack Query** for server state, **Zustand** for client-local state. No Redux — too much ceremony for the data shapes we have.
- Charts: **Recharts** for standard charts, **d3** for the custom pieces (timeline, flame graph, lock graph).
- WebSocket client: native `WebSocket` API with reconnection helper.
- Auth: API key stored in localStorage (self-host default), OAuth pluggable later.

## CLI: **Cobra (Go)**

- `clearvoiance` binary with subcommands: `session`, `replay`, `config`, `version`, `serve`.
- Cobra is the default choice in Go CLI land; integrates with Viper for config.

## Config: **YAML + env var overrides**

- Engine config in `/etc/clearvoiance/config.yaml`, overridable by `CLEARVOIANCE_*` env vars.
- SDK config in a `clearvoiance.config.ts` (or `.js`) file at the project root, with env var overrides.

## Observability of the engine itself

- **Logs:** structured JSON via `slog` (Go) and `pino` (Node). `CLEARVOIANCE_LOG_LEVEL` env.
- **Metrics:** Prometheus-compatible `/metrics` endpoint on the engine.
- **Traces:** OpenTelemetry SDK integration, optional. Exporter configurable.

## Testing

- **Go:** stdlib `testing` + `testify/require` + `testcontainers-go` for integration tests (real ClickHouse, MinIO, Postgres).
- **Node:** `vitest` (fast, TS-native, ESM-friendly).
- **E2E:** Playwright against a compose-up of engine + UI + example SUT.

## Build & release

- **Monorepo tool:** `pnpm` workspaces for Node packages + Go multi-module. Task runner: **`mise` + `just`** (or plain `make`).
  - `just engine-build`, `just sdk-build`, `just ui-dev`, `just proto-gen`.
- **Versioning:** semver. Independent versions per package.
- **Release:** 
  - Go: `goreleaser` → GitHub Releases (binaries for linux/amd64, linux/arm64, darwin/amd64, darwin/arm64).
  - Node: `changesets` → npm.
  - Docker: multi-arch images on GHCR.

## Logging philosophy

- User-facing logs use plain English, not internal jargon.
- Log levels: trace/debug/info/warn/error. Default prod level: info.
- Every error log line includes: timestamp, component, session_id (if applicable), error chain.

## License

- Repository: **Apache-2.0**.
- Reasons: permissive, compatible with corporate adoption, widely understood. Avoid AGPL to not scare enterprise users.
- Contributor agreement: **DCO** (Developer Certificate of Origin) sign-off, not a CLA — lower friction for contributors.

## Supported platforms

- Engine: Linux (amd64, arm64), macOS (amd64, arm64) for dev. No Windows server for v1.
- Node SDK: Node.js 18+ (LTS and current).
- UI: any modern browser (Chromium 100+, Firefox 100+, Safari 15+).

## Deferred tech decisions

These aren't v1 but noted here so we design around them:

- **Python SDK** (Django/Flask/FastAPI adapters) — Phase 2 post-launch.
- **Go SDK** (Gin/Echo/Fiber) — Phase 2 post-launch.
- **Ruby SDK** (Rails) — Phase 2 post-launch.
- **eBPF-based HTTP capture** for zero-instrumentation mode — experimental future direction.
