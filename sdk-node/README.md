# @clearvoiance/node

> **Record real production traffic and replay it safely at N× speed.**
>
> Catch breaking points before they hit production — without triggering
> real APIs, payments, or side effects.

## Why?

Staging environments lie.

Mocks drift.
Synthetic tests miss real edge cases.

clearvoiance records actual traffic — HTTP, WebSockets, cron, queues,
outbound calls, DB queries — and replays it in a hermetic environment
so you can test against reality, not guesses.

This is the Node.js SDK. It runs inside your app, streams captured events
to the [clearvoiance engine](https://github.com/charlses/clearvoiance),
and (in hermetic mode) serves captured outbound calls back from a mock
pack during replay so your tests never hit real external APIs.

## 60-second flow

```
  1. install SDK              npm install @clearvoiance/node
  2. hit your endpoint        curl http://localhost:3000/api/leads
  3. see traffic appear       open dashboard → events stream in live
  4. replay at 10×            click Replay → 10 min captured → 1 min real
  5. break something safely   outbound calls mocked, zero real damage
```

Five steps. No staging environment, no synthetic scripts. Real traffic,
safe replay — see the full walkthrough in the
[quickstart](https://clearvoiance.vercel.app/docs/quickstart).

- **Docs**: https://clearvoiance.vercel.app/docs
- **Engine**: Go, self-hosted (gRPC + REST + WebSocket control plane)
- **Node**: 18+ required (uses stable `AsyncLocalStorage` + global `fetch`)
- **License**: Apache-2.0

## Install

```bash
pnpm add @clearvoiance/node
# or: npm install @clearvoiance/node
# or: yarn add @clearvoiance/node
```

Every adapter is a separate subpath. Install the underlying library
in your app; the SDK never imports it at runtime.

| Adapter                                | Requires in your app  |
| -------------------------------------- | --------------------- |
| `@clearvoiance/node/http/express`      | `express >= 4`        |
| `@clearvoiance/node/http/koa`          | `koa >= 2`            |
| `@clearvoiance/node/http/strapi`       | Strapi v4             |
| `@clearvoiance/node/http/fastify`      | `fastify >= 4`        |
| `@clearvoiance/node/socket/socketio`   | `socket.io >= 4`      |
| `@clearvoiance/node/cron/node-cron`    | `node-cron >= 3`      |
| `@clearvoiance/node/queue/bullmq`      | `bullmq >= 4`         |
| `@clearvoiance/node/db/postgres`       | `pg >= 8`             |
| `@clearvoiance/node/db/knex`           | `knex >= 2`           |
| `@clearvoiance/node/db/prisma`         | `@prisma/client >= 5` |
| `@clearvoiance/node/db/mongoose`       | `mongoose >= 7`       |

The SDK ships `sideEffects: false` so bundlers can drop the adapter
subpaths you don't import.

## Getting an API key

The SDK authenticates to the engine via a bearer API key. Mint one via
the dashboard:

1. Open the engine's dashboard (default `http://localhost:3000`).
2. First visit lands on **Setup** — create an admin account (email +
   password).
3. Once signed in, go to **Settings → API keys → Create**.
4. Copy the plaintext `clv_live_...` string (shown once) into your env
   as `CLEARVOIANCE_API_KEY`.

Prefer the command line? `clearvoiance api-keys create --name my-key`
does the same thing.

## Quick start — Express + outbound capture

```ts
import express from "express";
import { createClient } from "@clearvoiance/node";
import { captureHttp } from "@clearvoiance/node/http/express";
import { patchOutbound } from "@clearvoiance/node/outbound";

const client = createClient({
  engine: {
    url: process.env.CLEARVOIANCE_ENGINE_URL ?? "127.0.0.1:9100",
    // Mint an API key at the engine's dashboard → Settings → API keys.
    // Copy the plaintext (shown once) into your env.
    apiKey: process.env.CLEARVOIANCE_API_KEY!,
  },
  session: { name: "my-api" },
  // Optional WAL — events queue to disk if the engine's unreachable,
  // drain automatically when it reconnects. Leave unset to disable.
  wal: { dir: "/var/lib/clearvoiance-wal" },
});

await client.start();

// Outbound HTTP + fetch get recorded so hermetic replay can serve them back.
// Only calls made inside a capture scope (started by the HTTP middleware
// below) are recorded, so this doesn't record the SDK's own plumbing.
patchOutbound(client);

const app = express();
app.use(captureHttp(client));
app.get("/", (_req, res) => res.json({ ok: true }));
app.listen(3000);
```

Stop gracefully on shutdown so in-flight events flush:

```ts
const shutdown = async () => {
  await client.stop({ flushTimeoutMs: 10_000 });
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT",  shutdown);
```

## Remote-controlled mode

For production services you usually don't want capture running 24/7 —
you want to record a specific 10 min window when something's off, then
replay it. Set `remote.clientName` and the SDK subscribes to the
engine's ControlService and waits idle. The dashboard's **Monitors**
page drives Start / Stop:

```ts
const client = createClient({
  engine: {
    url: process.env.CLEARVOIANCE_ENGINE_URL!,
    apiKey: process.env.CLEARVOIANCE_API_KEY!,
    tls: true,
  },
  // Session name is used only as a fallback; actual session ids come
  // from StartCapture commands pushed by the control plane.
  session: { name: "my-api" },
  remote: {
    clientName: "my-api-prod",            // stable identity, survives restarts
    displayName: "My API (production)",   // shown in the dashboard
    labels: { env: "production", region: "eu-central-1" },
  },
  wal: { dir: "/var/lib/clearvoiance-wal" },
});

await client.start();
// SDK is now subscribed. sendBatch() drops events silently until
// the dashboard clicks Start; after that it streams until Stop.
```

While idle, captures are a no-op: the middleware runs but
`sendBatch()` drops events without touching the network. Only a
StartCapture command from the dashboard opens a session; StopCapture
flushes + closes it. Each cycle is a distinct replayable session.

**Properties worth knowing:**

- SDK reconnect / engine restart / pod reschedule mid-capture: the
  engine keeps the session active, SDK reattaches on reconnect via
  `preferred_session_id`. Events resume in the same session.
- Horizontal replicas sharing a `clientName`: dashboard Start fans out
  to every live stream, all replicas contribute to the same session.
- Engine reachability required for capture; the Subscribe stream is
  plain server-streaming gRPC, so the engine needs to be reachable
  directly (e.g. via Traefik's h2c router for TLS-terminated gRPC).

## Adapters

Each adapter is a separate subpath import. Installing the SDK doesn't
pull any framework as a hard dep — the peer deps list makes them optional.

### HTTP

| Framework | Import                                    |
| --------- | ----------------------------------------- |
| Express   | `@clearvoiance/node/http/express`         |
| Koa       | `@clearvoiance/node/http/koa`             |
| Strapi    | `@clearvoiance/node/http/strapi`          |
| Fastify   | `@clearvoiance/node/http/fastify`         |

Fastify differs slightly — it registers lifecycle hooks rather than a
middleware:

```ts
import Fastify from "fastify";
import { registerCapture } from "@clearvoiance/node/http/fastify";

const app = Fastify();
await registerCapture(app, client);
app.get("/ping", async () => ({ pong: true }));
await app.listen({ port: 3000 });
```

### Sockets

```ts
import { Server as IOServer } from "socket.io";
import { captureSocketIO } from "@clearvoiance/node/socket/socketio";

const io = new IOServer(httpServer);
captureSocketIO(io, client);
```

### Cron

```ts
import cron from "node-cron";
import { captureCronJob } from "@clearvoiance/node/cron/node-cron";

cron.schedule(
  "* * * * *",
  captureCronJob(client, "nightly-cleanup", async () => {
    // your job
  }),
);
```

### Queues (BullMQ)

```ts
import { Worker } from "bullmq";
import { captureBullMQ } from "@clearvoiance/node/queue/bullmq";

new Worker(
  "emails",
  captureBullMQ(client, "emails", async (job) => {
    // your processor — job.data, job.id, etc.
    // the wrapper re-throws on error so BullMQ retries still work.
  }),
  { connection: { host: "localhost", port: 6379 } },
);
```

### Outbound HTTP + fetch

```ts
import { patchOutbound } from "@clearvoiance/node/outbound";
patchOutbound(client);
// or selective:
//   import { patchHttp, patchFetch } from "@clearvoiance/node/outbound";
```

Records a `OutboundEvent` for every `http.request` / `https.request` /
global `fetch` call fired inside a capture scope (adapters open one
around each inbound request). Pass-through when no scope is active so
the SDK's own engine traffic is never self-recorded.

### Database

Two correlation strategies ship in the box, and every adapter supports
both — pick whichever fits (or run them in parallel):

1. **Observer-based** — SDK stamps every connection with
   `application_name = 'clv:<replayId?>:<eventId>'`. The out-of-band
   db-observer polls `pg_stat_activity` and emits `DbObservationEvent`s
   tagged with `caused_by_event_id`. Zero per-query overhead, but only
   catches queries that were running when the observer polled — very
   fast queries (< poll interval) slip through invisibly.

2. **SDK-side emission** — opt in by passing `emit: { client }` to any
   adapter. The wrapper times every query and streams a
   `DbObservationEvent` through the SDK client directly. Catches 100%
   of queries above `slowThresholdMs`. Adds a few µs per query and a
   small event payload per emission, so keep `slowThresholdMs` non-zero
   on high-QPS apps. Required for Mongo (no `pg_stat_activity`
   equivalent); optional-but-recommended for Postgres when the observer
   misses too much.

Both paths produce the same event shape, so the dashboard shows DB
activity from all drivers on one timeline regardless of how it got there.

**node-postgres / raw pg.Pool:**

```ts
import { Pool } from "pg";
import { instrumentPg } from "@clearvoiance/node/db/postgres";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
instrumentPg(pool, {
  replayId: process.env.CLEARVOIANCE_REPLAY_ID,
  // Optional: also emit a DbObservationEvent per query via the SDK.
  emit: { client, slowThresholdMs: 10 },
});
```

**Knex** — Knex manages its own tarn.js pool under the hood, so use the
Knex-specific entry point instead of `instrumentPg`:

```ts
import knex from "knex";
import { instrumentKnex } from "@clearvoiance/node/db/knex";

const db = knex({ client: "pg", connection: process.env.DATABASE_URL });
instrumentKnex(db, {
  replayId: process.env.CLEARVOIANCE_REPLAY_ID,
  emit: { client, slowThresholdMs: 10 },
});
```

The adapter is a silent no-op when `db.client.driverName` isn't `pg`
(mysql2, sqlite, etc.), so it's safe to wire up unconditionally.

**Prisma** (runs its own engine process; the pg-pool hook doesn't see it):

```ts
import { PrismaClient } from "@prisma/client";
import { instrumentPrisma } from "@clearvoiance/node/db/prisma";

const prisma = instrumentPrisma(new PrismaClient(), {
  replayId: process.env.CLEARVOIANCE_REPLAY_ID,
  emit: { client, slowThresholdMs: 10 },
});
```

**Mongoose** — install *before* any model is defined so every schema
picks up the plugin. Mongoose is emit-only (no observer equivalent),
so `client` is a required arg:

```ts
import mongoose from "mongoose";
import { instrumentMongoose } from "@clearvoiance/node/db/mongoose";

instrumentMongoose(mongoose, client, {
  slowThresholdMs: 50,                          // 0 = emit every op
  replayId: process.env.CLEARVOIANCE_REPLAY_ID,
});
```

#### Adapter contract

If you want to add support for another driver, a DB adapter needs to
do exactly one of these two things:

- **Observer-style**: set a per-connection identifier that the observer
  can parse. The format is `clv:<replayId?>:<eventId>`, truncated to
  the driver's identifier limit (63 chars for Postgres). Existing
  adapters use `parseClvAppName()` from `@clearvoiance/node/db/postgres`
  so observers see one shape regardless of source.
- **SDK-side**: time each op, read the active `eventId` via
  `currentEventId()` (exported from the top-level package), and call
  `client.sendBatch([event])` with an `adapter: "db.<driver>"` event
  carrying a `DbObservationEvent` whose `caused_by_event_id` matches.

Either way, drop ops that fire outside any event scope — those have
nothing to correlate against and only add noise.

### Auto-detect

For quick prototyping — detects Express/Koa/Fastify on the `app` you pass
in, installs the matching HTTP adapter + outbound patches in one call:

```ts
import { autoInstrument } from "@clearvoiance/node/auto";

const handle = await autoInstrument(client, { app });
console.log("detected:", handle.detected);
// → ["http.express", "outbound.http", "outbound.fetch"]
```

Production code should wire adapters explicitly so the installed surface
is obvious from imports.

## Hermetic replay

During capture, outbound calls are recorded. During replay, set
`CLEARVOIANCE_HERMETIC=true` and the SDK swaps the outbound patches for
mock-serving versions — every captured call returns from an in-memory
mock pack instead of hitting the wire. Zero real emails, zero real
Stripe charges, zero real OpenAI tokens.

```ts
import { maybeActivateHermetic } from "@clearvoiance/node/hermetic";

// Call this EARLY in your boot (before any handlers run).
await maybeActivateHermetic();
```

Env vars the orchestrator reads:

| Variable                              | What                                                           |
| ------------------------------------- | -------------------------------------------------------------- |
| `CLEARVOIANCE_HERMETIC`               | `true` to activate                                             |
| `CLEARVOIANCE_ENGINE_URL`             | gRPC target for the mock-pack fetch (e.g. `127.0.0.1:9100`)    |
| `CLEARVOIANCE_API_KEY`                | Engine API key                                                 |
| `CLEARVOIANCE_SOURCE_SESSION_ID`      | Captured session to replay from                                |
| `CLEARVOIANCE_HERMETIC_POLICY`        | `strict` (default — throw on unmocked) or `loose` (200 `{}`)   |
| `CLEARVOIANCE_HERMETIC_KILL_CRON`     | `false` to keep the SUT's native cron scheduler running        |
| `CLEARVOIANCE_HERMETIC_INVOKE_PORT`   | Start the invoke server on this loopback port                  |
| `CLEARVOIANCE_HERMETIC_INVOKE_TOKEN`  | Optional Bearer token for the invoke server                    |
| `CLEARVOIANCE_HERMETIC_RECORD_UNMOCKED` | `true` to POST unmocked info to the engine for operator review |

**Cron + queue replay**: hermetic mode also replaces node-cron with a
registry that never auto-fires. The engine's replay scheduler POSTs to
an invoke server on the SUT so only captured events run. See
`@clearvoiance/node/hermetic` for the full surface.

## Configuration

```ts
createClient({
  engine: {
    url: string;          // "host:port" (gRPC)
    apiKey: string;
    tls?: boolean;        // default false — loopback dev default
  },
  session: {
    name: string;
    labels?: Record<string, string>;
  },
  wal?: {
    dir?: string;         // default: os.tmpdir() + "/clearvoiance-wal"
    maxBytes?: number;    // default: 1 GB
    disabled?: boolean;   // skip disk entirely (events lost on engine down)
  },
  reconnect?: {
    initialBackoffMs?: number;  // default: 500
    maxBackoffMs?: number;      // default: 30_000
  },
});
```

Per-adapter options (redaction, sampling, body size caps) live on each
adapter's own options interface — see the TSDoc on `captureHttp`,
`captureKoa`, etc.

### Redaction

Since 0.1.5, the default is **no redaction** — captures are full-fidelity
so replay Just Works against the same SUT without auth-strategy
acrobatics. Authorization headers, session cookies, and API keys flow
through as captured and land in ClickHouse.

If you're capturing against a production-adjacent environment and need
to keep credentials out of storage, opt into the recommended set per
adapter:

```ts
import { RECOMMENDED_HEADER_DENY_PRODUCTION } from "@clearvoiance/node";

app.use(
  captureHttp(client, {
    redactHeaders: RECOMMENDED_HEADER_DENY_PRODUCTION,
    // Or customise:
    //   redactHeaders: ["authorization", "cookie", /^x-internal-/i],
    userExtractor: (req) => req.user?.id,
    maxBodyInlineBytes: 64 * 1024, // default
  }),
);
```

`RECOMMENDED_HEADER_DENY_PRODUCTION` covers `authorization`, `cookie`,
`set-cookie`, `proxy-authorization`, `x-api-key`, `x-auth-token`, and
`x-secret-*`. Redacted values get replaced with `[REDACTED]` and the
redaction is recorded on the event for audit.

For captures that need redaction AND faithful replay, pair opt-in
redaction with the engine's replay-time auth strategies
(`static_swap`, `jwt_resign`).

### Event context

All adapters open an `AsyncLocalStorage` scope keyed on a generated
`eventId`. Children (outbound calls, DB queries) read the same id via
`currentEventId()` so the db-observer can correlate slow queries back
to the originating request.

```ts
import { currentEventId } from "@clearvoiance/node";
```

## Running against a local engine

The engine is a separate Go binary. The quickest path:

```bash
git clone https://github.com/charlses/clearvoiance
cd clearvoiance/deploy
docker-compose up -d   # ClickHouse + Postgres + MinIO + engine
```

Point your SDK at `127.0.0.1:9100` and visit the dashboard at
`http://127.0.0.1:3100` (Next.js UI).

## Compatibility

| SDK version | Engine API |
| ----------- | ---------- |
| `0.1.x`     | `v1`       |
| `0.2.x`     | `v1`       |

Minor SDK bumps stay wire-compatible with older engines. Major bumps may
require an engine upgrade — check the release notes.

## Contributing

This is a monorepo — the SDK lives at `sdk-node/` in the main repo. PRs
welcome; see the top-level [CONTRIBUTING.md](https://github.com/charlses/clearvoiance/blob/main/CONTRIBUTING.md).

## License

Apache-2.0.
