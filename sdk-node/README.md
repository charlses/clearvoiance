# @clearvoiance/node

> Capture real traffic from your backend — HTTP, WebSockets, cron, queues,
> outbound calls, DB queries — and replay it at N× speed against a hermetic
> clone. Find the breaking points *before* production does.

This is the Node.js SDK. It runs inside your app, streams captured events
to the [clearvoiance engine](https://github.com/charlses/clearvoiance),
and (in hermetic mode) serves captured outbound calls back from a mock
pack during replay so your tests never hit real external APIs.

- **Docs**: https://github.com/charlses/clearvoiance
- **Engine**: Go, self-hosted (gRPC + REST + WebSocket control plane)
- **Node**: 24+ required (uses stable `AsyncLocalStorage` + global `fetch`)
- **License**: Apache-2.0

## Install

```bash
pnpm add @clearvoiance/node
# or: npm install @clearvoiance/node
# or: yarn add @clearvoiance/node
```

All framework integrations (Express, Koa, Strapi, Fastify, Socket.io,
node-cron, BullMQ, pg, Prisma) are optional peer dependencies — install
only the ones you actually use.

## Quick start — Express + outbound capture

```ts
import express from "express";
import { createClient } from "@clearvoiance/node";
import { captureHttp } from "@clearvoiance/node/http/express";
import { patchOutbound } from "@clearvoiance/node/outbound";

const client = createClient({
  engine: {
    url: process.env.CLEARVOIANCE_ENGINE_URL ?? "127.0.0.1:9100",
    apiKey: process.env.CLEARVOIANCE_API_KEY ?? "dev",
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

For correlation between DB observations and replay events, the SDK sets
a connection-level `application_name = 'clv:<event_id>'` on every query.
The db-observer parses that back out when scanning `pg_stat_activity`.

**node-postgres / pg-Pool consumers (including Knex):**

```ts
import { Pool } from "pg";
import { instrumentPg } from "@clearvoiance/node/db/postgres";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
instrumentPg(pool, { replayId: process.env.CLEARVOIANCE_REPLAY_ID });
```

**Prisma** (runs its own engine process; the pg-pool hook doesn't see it):

```ts
import { PrismaClient } from "@prisma/client";
import { instrumentPrisma } from "@clearvoiance/node/db/prisma";

const prisma = instrumentPrisma(new PrismaClient(), {
  replayId: process.env.CLEARVOIANCE_REPLAY_ID,
});
```

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

All HTTP adapters apply a default header denylist
(`authorization`, `cookie`, `set-cookie`, `proxy-authorization`,
`x-api-key`, `x-auth-token`, `x-secret-*`). Values get replaced with
`[REDACTED]` and the redaction is recorded on the event for audit.

Override per-adapter:

```ts
app.use(
  captureHttp(client, {
    redactHeaders: ["authorization", "cookie", /^x-internal-/i],
    userExtractor: (req) => req.user?.id,
    maxBodyInlineBytes: 64 * 1024, // default
  }),
);
```

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

Minor SDK bumps stay wire-compatible with older engines. Major bumps may
require an engine upgrade — check the release notes.

## Contributing

This is a monorepo — the SDK lives at `sdk-node/` in the main repo. PRs
welcome; see the top-level [CONTRIBUTING.md](https://github.com/charlses/clearvoiance/blob/main/CONTRIBUTING.md).

## License

Apache-2.0.
