# 05 — Repo Structure

Monorepo layout. One repo, many packages. Multi-language (Go + TS) handled via pnpm workspaces + Go workspaces (`go.work`).

## Top-level layout

```
clearvoiance/
├── engine/                    # Go — core engine, CLI, replay, API
├── db-observer/               # Go — Postgres/MySQL/Mongo observer
├── sdk-node/                  # TypeScript — @clearvoiance/node
├── ui/                        # Next.js — control plane frontend
├── proto/                     # Protobuf definitions (shared)
├── deploy/                    # docker-compose, Helm, Terraform examples
├── examples/                  # Example SUT apps wired up with SDK
│   ├── strapi-basic/
│   ├── express-basic/
│   ├── nest-basic/
│   └── fastify-socketio/
├── docs/                      # User-facing docs source (Mintlify/Docusaurus)
├── plan/                      # This folder — planning docs
├── scripts/                   # Dev scripts (bootstrap, codegen, release)
├── .github/
│   ├── workflows/             # CI workflows
│   ├── ISSUE_TEMPLATE/
│   ├── PULL_REQUEST_TEMPLATE.md
│   └── CODEOWNERS
├── go.work                    # Go workspace referencing engine/ and db-observer/
├── pnpm-workspace.yaml        # pnpm workspace for sdk-node + ui + examples
├── package.json               # root, dev deps only
├── justfile                   # task runner
├── .editorconfig
├── .gitignore
├── LICENSE                    # Apache-2.0
├── CONTRIBUTING.md
├── SECURITY.md
├── CHANGELOG.md               # managed by changesets for Node + goreleaser for Go
└── README.md
```

## `engine/` — Go

```
engine/
├── cmd/
│   └── clearvoiance/
│       └── main.go            # CLI entry: clearvoiance serve|session|replay|config
├── internal/
│   ├── api/
│   │   ├── grpc/              # gRPC Capture service
│   │   ├── rest/              # REST handlers
│   │   └── ws/                # WebSocket handlers
│   ├── capture/
│   │   ├── ingest.go          # event ingest pipeline
│   │   └── validation.go
│   ├── replay/
│   │   ├── scheduler.go       # timer wheel
│   │   ├── workers/
│   │   │   ├── http.go
│   │   │   ├── socket.go
│   │   │   ├── cron.go
│   │   │   └── queue.go
│   │   ├── auth/              # token refresh strategies
│   │   ├── mutator/           # payload mutation for virtual users
│   │   └── dispatcher/
│   │       └── registry.go
│   ├── sessions/              # session lifecycle
│   ├── storage/
│   │   ├── clickhouse/
│   │   │   ├── events.go
│   │   │   ├── migrations/
│   │   │   └── schema.sql
│   │   ├── postgres/
│   │   │   ├── queries/       # .sql files for sqlc
│   │   │   ├── migrations/
│   │   │   └── generated/     # sqlc output
│   │   └── blob/
│   │       ├── minio.go
│   │       └── s3.go
│   ├── auth/                  # API key auth, OAuth proxy
│   ├── config/                # YAML + env config loader
│   └── telemetry/             # prom metrics, OTel traces
├── pkg/                       # exported-for-reuse packages (sparse)
├── go.mod
└── go.sum
```

Style conventions:
- `internal/` for everything unless external consumers need it → `pkg/`.
- Small packages per concern. Don't lump everything into `engine/internal/`.
- Tests colocated (`foo.go` + `foo_test.go`).
- Integration tests in `engine/internal/*/integration_test.go` with `//go:build integration` tag.

## `db-observer/` — Go

```
db-observer/
├── cmd/
│   └── clearvoiance-observer/
│       └── main.go
├── internal/
│   ├── postgres/
│   │   ├── activity.go        # pg_stat_activity poller
│   │   ├── locks.go           # pg_locks snapshots
│   │   ├── slowlog.go         # log tail
│   │   └── autoexplain.go
│   ├── correlator/            # link DB events to replay events
│   └── transport/             # sends observations back to engine
├── go.mod
└── go.sum
```

Runs either embedded in `engine` (same process) or standalone as a sidecar.

## `sdk-node/` — TypeScript

```
sdk-node/
├── src/
│   ├── index.ts               # main entry
│   ├── client/
│   │   ├── grpc-client.ts
│   │   ├── batcher.ts
│   │   ├── wal.ts
│   │   └── backpressure.ts
│   ├── core/
│   │   ├── event-builder.ts
│   │   ├── redaction.ts
│   │   ├── sampling.ts
│   │   └── metadata.ts
│   ├── adapters/
│   │   ├── http/
│   │   │   ├── express.ts
│   │   │   ├── fastify.ts
│   │   │   ├── koa.ts
│   │   │   ├── strapi.ts
│   │   │   ├── nest.ts
│   │   │   └── raw-body.ts    # shared raw body capture
│   │   ├── socket/
│   │   │   └── socketio.ts
│   │   ├── cron/
│   │   │   ├── node-cron.ts
│   │   │   ├── agenda.ts
│   │   │   └── bullmq.ts
│   │   ├── queue/
│   │   │   ├── bullmq.ts
│   │   │   ├── amqplib.ts
│   │   │   └── kafkajs.ts
│   │   └── outbound/
│   │       ├── http.ts        # global http/https patch
│   │       ├── undici.ts
│   │       ├── axios.ts
│   │       └── index.ts       # auto-detect
│   ├── hermetic/
│   │   ├── intercept.ts       # outbound mock on replay
│   │   ├── mock-store.ts
│   │   └── cron-killer.ts
│   ├── generated/             # protobuf-ts generated code (gitignored)
│   └── types.ts
├── test/
│   ├── unit/
│   └── integration/           # runs against engine via testcontainers
├── package.json
├── tsconfig.json
├── tsup.config.ts             # dual ESM+CJS build
└── README.md
```

Export map:

```json
{
  "exports": {
    ".": "./dist/index.js",
    "./http/express": "./dist/adapters/http/express.js",
    "./http/strapi": "./dist/adapters/http/strapi.js",
    "./socket/socketio": "./dist/adapters/socket/socketio.js",
    "./cron/node-cron": "./dist/adapters/cron/node-cron.js",
    "./queue/bullmq": "./dist/adapters/queue/bullmq.js",
    "./outbound": "./dist/adapters/outbound/index.js",
    "./hermetic": "./dist/hermetic/index.js"
  }
}
```

Subpath imports let users bring in only what they need → small bundles, clear dependency surface.

## `ui/` — Next.js

```
ui/
├── src/
│   ├── app/
│   │   ├── layout.tsx
│   │   ├── page.tsx           # dashboard
│   │   ├── sessions/
│   │   │   ├── page.tsx
│   │   │   ├── new/page.tsx
│   │   │   └── [id]/
│   │   │       ├── page.tsx
│   │   │       ├── live/page.tsx
│   │   │       └── replay/page.tsx
│   │   ├── replays/[id]/page.tsx
│   │   └── settings/page.tsx
│   ├── components/
│   │   ├── ui/                # shadcn
│   │   ├── timeline/
│   │   ├── event-browser/
│   │   ├── replay-progress/
│   │   ├── db-flamegraph/
│   │   └── lock-timeline/
│   ├── lib/
│   │   ├── api-client.ts
│   │   ├── ws-client.ts
│   │   └── query-hooks.ts
│   └── styles/
├── public/
├── package.json
├── next.config.ts
└── tailwind.config.ts
```

## `proto/`

```
proto/
└── clearvoiance/
    └── v1/
        ├── event.proto
        ├── capture.proto
        ├── control.proto       # control plane REST→proto gateway
        ├── observer.proto
        └── buf.yaml
```

Generation: `buf generate` runs `protoc-gen-go`, `protoc-gen-go-grpc`, `protoc-gen-ts` and writes to:
- `engine/internal/pb/` (committed, gitignored? — committed for reproducibility)
- `sdk-node/src/generated/` (gitignored, built in CI)

## `deploy/`

```
deploy/
├── docker-compose.yml            # single-box self-host
├── docker-compose.dev.yml        # dev with hot-reload
├── helm/
│   └── clearvoiance/
│       ├── Chart.yaml
│       ├── values.yaml
│       └── templates/
├── terraform/                    # example IaC for AWS/GCP
└── images/
    ├── engine/Dockerfile
    ├── ui/Dockerfile
    └── observer/Dockerfile
```

## `examples/`

Each example is a minimal working SUT with SDK wired up. Used for:
- Manual testing during development.
- E2E CI.
- Docs (linked from Getting Started guides).

## `justfile` (task runner)

Top-level commands developers actually run:

```
just bootstrap              # install all deps
just proto                  # regenerate protobuf bindings
just engine-dev             # run engine with hot reload (air)
just engine-test
just engine-test-integration
just sdk-dev                # tsc --watch for SDK
just sdk-test
just ui-dev
just ui-test
just examples-strapi        # run strapi example against local engine
just e2e                    # full stack compose + playwright
just release-engine
just release-sdk
just release-ui
```

## `.github/workflows/`

- `ci.yml` — runs on every PR: lint, test, typecheck all packages.
- `e2e.yml` — slow: runs compose-up + playwright.
- `release.yml` — on tag push: build + publish.
- `proto-check.yml` — buf breaking-change detection on protobuf changes.

## File ownership

- `CODEOWNERS` in `.github/` maps directories to maintainers.
- In the early phase, everything is owned by the primary author.

## What does NOT live in this repo

- Production Helm values → separate infra repo.
- Customer-facing docs site build artifacts → Mintlify/Vercel hosts.
- Telemetry/analytics keys → env vars, not committed.
