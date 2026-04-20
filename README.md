# clearvoiance

> **Record real production traffic and replay it safely at N× speed.**
>
> Catch breaking points before they hit production — without triggering
> real APIs, payments, or side effects.

## Why?

Staging environments lie.

Mocks drift. Synthetic tests miss real edge cases.

**clearvoiance** records actual traffic — HTTP, WebSockets, cron, queues,
outbound calls, DB queries — and replays it in a hermetic environment
so you can test against reality, not guesses.

## 60-second flow

```
  1. install SDK              npm install @clearvoiance/node
  2. hit your endpoint        curl http://localhost:3000/api/leads
  3. see traffic appear       open dashboard → events stream in live
  4. replay at 10×            click Replay → 10 min captured → 1 min real
  5. break something safely   outbound calls mocked, zero real damage
```

## The pitch

Existing tools force a tradeoff:

- **Synthetic load (k6, Artillery, Locust, Gatling)** — you hand-write traffic scenarios. Real production traffic is weirder than anything you'll script.
- **Traffic replay (GoReplay, mirrord)** — replays at wall-clock speed. Fine for smoke tests, useless for finding scale ceilings.
- **Chaos tools (Toxiproxy, Chaos Mesh)** — inject failures, don't model real load shapes.

clearvoiance does all three in one system:

1. **Capture** one hour of real production traffic across every input protocol (not just HTTP).
2. **Replay** it in 5 minutes against a hermetic SUT (no real emails, no real external API calls).
3. **Observe** the database side of the replay — slow queries, locks, plans — correlated to the replay event that caused them.

Output: "Under 12× prod load, request `POST /api/leads` triggers lock contention on `leads_email_key` ~400ms in. Here's the query plan, here's the captured event, here's the reproducer."

## Status

Phases 0 through 6 are shipped end-to-end, all green in CI (14 jobs: Go unit + Go integration via testcontainers Postgres/ClickHouse, seven per-adapter e2e smokes, SDK unit + SDK integration, UI build + lint + typecheck, and UI e2e via Playwright). What's live today:

- **Capture**: `@clearvoiance/node` SDK — HTTP (Express/Koa/Strapi), Socket.io, node-cron, direct outbound HTTP + `fetch` capture with AsyncLocalStorage event correlation.
- **Replay engine**: time-compressed replay at N× speedup, virtual-user fan-out, JWT-resign / static-swap auth strategies, Starlark body mutators, time-window selection + target-duration auto-speedup.
- **Hermetic mode**: captured outbounds served from a mock pack, cron killer + invoke server so the SUT's scheduler never fires during replay, strict/loose policies, engine-side unmocked-outbound log.
- **DB observer**: out-of-process `clearvoiance-observer` polls `pg_stat_activity` and correlates slow queries back to replay events via `application_name = clv:<event_id>` set by the SDK's `instrumentPg`.
- **Control plane**: REST API at `/api/v1/*` (sessions, replays, api-keys, db-observations, health, metrics, config, auth) + WebSocket hub with live replay progress. OpenAPI 3.1 at `/api/v1/openapi.yaml`, Swagger UI at `/docs`, Postgres-backed audit log with secret-redacted payloads. Dual auth: HttpOnly session cookie for humans, Bearer API key for SDKs.
- **UI**: Next.js 16 + React 19 dashboard consuming the REST + WS — email+password login with a first-visit setup wizard, sessions, replays with 250ms live progress, DB observations view, API key management, self-serve account settings.

Remaining phases per [`plan/`](./plan/README.md): **Phase 7** (more SDK languages / framework adapters) and **Phase 8** (OSS launch + docs site).

## Self-host in one command

The full stack — engine, dashboard, ClickHouse, Postgres, MinIO — runs
behind loopback on your machine with a single compose up. Every
password, port, and URL is driven by `deploy/.env`.

```bash
git clone https://github.com/charlses/clearvoiance
cd clearvoiance
cp deploy/.env.example deploy/.env
docker compose --env-file deploy/.env -f deploy/docker-compose.yml up -d --build
```

Default endpoints:

| Service             | URL                       |
|---------------------|---------------------------|
| Dashboard           | `http://127.0.0.1:3000`   |
| Engine REST + WS    | `http://127.0.0.1:9101`   |
| Engine gRPC (SDK)   | `127.0.0.1:9100`          |

Open the dashboard, create an admin account in the first-visit setup
wizard, then mint API keys in **Settings → API keys** to point the SDK
at the engine. No CLI bootstrap required.

`deploy/docker-compose.yml` ships commented Traefik labels for both the
engine and dashboard, plus an optional `db-observer` block — see the
[Deployment docs](https://clearvoiance.io/docs/deployment) for TLS
setup, DSN wiring, session cookie config, and upgrade flow.

## Architecture at a glance

```
┌─────────────────────────────────────────────┐
│  Capture SDKs (per-language, per-framework) │
│  @clearvoiance/node • python • go • ruby    │
└──────────────┬──────────────────────────────┘
               ↓ gRPC stream
┌─────────────────────────────────────────────┐
│  Go Engine (capture + replay + API)         │
└──────┬────────────────────────┬─────────────┘
       ↓                        ↓
 ClickHouse (events)     MinIO (blobs)
       ↑
┌──────┴──────────────────────────────────────┐
│  Next.js Control Plane (UI)                 │
└─────────────────────────────────────────────┘
```

## License

Apache-2.0.
