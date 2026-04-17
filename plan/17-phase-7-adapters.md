# Phase 7 — Adapter Ecosystem

**Duration:** 1 week.
**Goal:** Grow the adapter surface from "Strapi + Express" to a complete Node.js ecosystem. Pave the path for non-Node SDKs by productionizing the adapter pattern.

## Deliverables

### HTTP adapters

Already in Phase 1: Express, Strapi. Add:

- `@clearvoiance/node/http/fastify`
- `@clearvoiance/node/http/koa`
- `@clearvoiance/node/http/nest`
- `@clearvoiance/node/http/hono` (for edge / serverless)
- `@clearvoiance/node/http/next-api` (Next.js API routes + App Router route handlers)

All share `src/adapters/http/raw-body.ts` + the same event-building core. Each adapter is < 200 LOC of framework-specific glue.

#### Nest integration

Nest requires module+interceptor pattern:

```ts
import { ClearvoianceModule } from '@clearvoiance/node/http/nest';

@Module({
  imports: [ClearvoianceModule.forRoot({ engine: {...}, session: {...} })],
})
export class AppModule {}
```

Provides `APP_INTERCEPTOR` registration, DI token for the client, etc.

#### Next.js integration

Two flavors:

- Legacy API routes: `export default withClearvoiance(handler)`.
- App Router: `export const GET = withClearvoiance(async (req) => ...)`.

Documents limitations under Edge runtime (no fs, no gRPC → falls back to HTTP/1 transport to engine).

### Socket adapters

Already in Phase 1: Socket.io. Add:

- `@clearvoiance/node/socket/ws` — plain `ws` library
- `@clearvoiance/node/socket/native` — Node.js built-in `WebSocket`

### Cron adapters

Already in Phase 1: `node-cron`, `agenda`. Add:

- `@clearvoiance/node/cron/bullmq` — BullMQ jobs / workers
- `@clearvoiance/node/cron/bree` — Bree worker-thread scheduler
- `@clearvoiance/node/cron/cron` — `cron` package
- `@clearvoiance/node/cron/temporal` — Temporal workflows (experimental)

### Queue adapters (new surface)

Queues are both cron-like triggers and cross-service comms:

- `@clearvoiance/node/queue/bullmq`
- `@clearvoiance/node/queue/amqplib` (RabbitMQ)
- `@clearvoiance/node/queue/kafkajs`
- `@clearvoiance/node/queue/sqs` (AWS SQS)
- `@clearvoiance/node/queue/pgboss` (Postgres-based)

Each captures `QueueEvent` records on consumption. During replay, the engine publishes captured messages to the queue (or invokes the handler directly via the hermetic invoke-server, which is preferred since queue state is volatile).

### Outbound adapters

Already in Phase 1: http/https, undici. Add:

- `@clearvoiance/node/outbound/fetch` — global `fetch` (Node 24+)
- `@clearvoiance/node/outbound/prisma` — Prisma query interceptor
- `@clearvoiance/node/outbound/stripe` — Stripe SDK wrapper (uses underlying HTTP, but tags nicely)
- `@clearvoiance/node/outbound/openai` — OpenAI SDK wrapper
- `@clearvoiance/node/outbound/aws-sdk-v3` — AWS SDK v3 middleware

These are mostly signaling/tagging — the underlying HTTP interceptor catches the calls, but these adapters add structured metadata (`target: "stripe.api"`, `operation: "charges.create"`).

### DB adapters (Phase 4 extension)

Already in Phase 4: node-pg, Knex. Add:

- `@clearvoiance/node/db/prisma` — Prisma $extends
- `@clearvoiance/node/db/typeorm`
- `@clearvoiance/node/db/drizzle`
- `@clearvoiance/node/db/mongoose`

All set `application_name` or equivalent identifier for correlation.

### Auto-detect mode

`@clearvoiance/node/auto`:

```ts
import { autoInstrument } from '@clearvoiance/node/auto';

autoInstrument(client, app);  // detects app type, installs all relevant adapters
```

Detection logic: inspects installed packages in `node_modules`, attaches matching adapters. Ergonomic for prototypes; explicit import is still recommended for production.

### Engine-side: queue dispatcher

Previously stubbed in Phase 2. Now implemented:

`engine/internal/replay/workers/queue.go`:
- For each `QueueEvent`, determines routing: direct handler invoke (preferred, via hermetic invoke-server) OR publish to queue.
- For direct invoke: same pattern as cron dispatcher.
- For publish: requires queue connection config per target queue.

### Documentation

For each adapter: a setup snippet + a "gotchas" section.

Docs page structure: `docs/adapters/<framework>.md`.

### Tests

One `examples/` app per adapter that CI uses for E2E smoke.

## Acceptance criteria

1. Each adapter has:
   - Source in `sdk-node/src/adapters/`.
   - Unit tests.
   - An example app in `examples/`.
   - A docs page in `docs/adapters/`.
2. CI runs a matrix job testing each adapter with capture + replay against a trivial workflow.
3. Auto-instrument example: `examples/auto-detect-express/` — trivial app, `autoInstrument(client, app)` call, captures HTTP + outbound.
4. Bundle size: each adapter's additional install size is < 100KB (they share a common runtime).
5. Queue adapters: BullMQ end-to-end test — enqueue jobs during capture, consume + replay, verify queue dispatcher correctly invokes handlers in hermetic mode.

## Non-goals

- Non-Node SDKs (explicit future work, see below).
- Framework versions older than current LTS minus one.
- Edge runtime gRPC (HTTP/1 transport is v1 only).

## Implementation order

1. Fastify + Koa adapters.
2. Nest module.
3. Next.js integrations.
4. Hono.
5. BullMQ cron + queue adapters (these overlap).
6. amqplib queue adapter.
7. kafkajs adapter.
8. Outbound tagging wrappers (Stripe, OpenAI, aws-sdk).
9. DB adapters (Prisma, TypeORM, Drizzle, Mongoose).
10. Auto-detect mode.
11. Engine queue dispatcher.
12. Matrix CI.
13. Docs.

## Future: non-Node SDKs

Not Phase 7, but noted so the adapter pattern generalizes:

- **Python SDK** (`clearvoiance-python`):
  - HTTP: Django, Flask, FastAPI, Starlette adapters
  - Cron: Celery beat, APScheduler
  - Queue: Celery tasks, RQ
  - DB: SQLAlchemy, Django ORM
- **Go SDK** (`github.com/<org>/clearvoiance-go`):
  - HTTP: net/http middleware, Gin, Echo, Fiber, Chi
  - DB: database/sql wrappers
- **Ruby SDK** (`clearvoiance-ruby`):
  - Rails middleware, Sidekiq adapter

These share the same `proto/` contract — the hard work (schema, engine) is done in v1. Each SDK is a 2-3 week project.

## Testing

### Unit
- Per adapter: builds events correctly for framework-specific concerns.

### Integration
- Per example app: smoke test capture → replay.

### Matrix CI
- Build and test each adapter pair (framework × clearvoiance feature).

## Open questions

- **Adapter release cadence:** each adapter bumps `@clearvoiance/node` version? Or versioned separately (mini-monorepo per adapter)? Decision: single package, semver bumps on any adapter API change.
- **Peer dependencies:** each adapter pins the framework as `peerDependencies` with broad ranges. Document supported versions.
- **Auto-detect reliability:** risk of surprising users. Default to off; opt-in via `autoInstrument`.
- **Queue replay order:** messages may be consumed concurrently in captured state. How do we preserve ordering semantics? v1: single-threaded replay of queue events, document limitation.

## Time budget

| Area | Estimate |
|---|---|
| Fastify + Koa + Nest | 1.5 days |
| Next.js (both flavors) + Hono | 1 day |
| BullMQ (cron + queue) | 1 day |
| amqplib + kafkajs | 1 day |
| Outbound tagging wrappers | ½ day |
| DB adapters | 1 day |
| Auto-detect | ½ day |
| Queue dispatcher (engine) | 1 day |
| Matrix CI + docs | 1 day |
| **Total** | **~7 days** |
