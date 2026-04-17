# strapi-basic

A worked example of wiring `@clearvoiance/node` into a Strapi 5 app. Every
inbound request the Strapi server handles is captured and streamed to the
engine, with Strapi's authenticated user automatically attached to the event.

This example is deliberately **not part of the CI smoke suite** — spinning up
a full Strapi app + database every run adds minutes without catching anything
the unit test (`sdk-node/src/adapters/http/strapi.test.ts`) doesn't already
cover. Use it as a drop-in template when you start a real Strapi project.

## 1. Add the middleware file

Create `src/middlewares/clearvoiance.ts` inside your Strapi app:

```ts
import { createClient } from "@clearvoiance/node";
import { clearvoianceStrapiMiddleware } from "@clearvoiance/node/http/strapi";

const client = createClient({
  engine: {
    url: process.env.CLEARVOIANCE_ENGINE_URL ?? "127.0.0.1:9100",
    apiKey: process.env.CLEARVOIANCE_API_KEY ?? "dev",
  },
  session: { name: process.env.CLEARVOIANCE_SESSION_NAME ?? "strapi" },
  ...(process.env.CLEARVOIANCE_WAL_DIR
    ? { wal: { dir: process.env.CLEARVOIANCE_WAL_DIR } }
    : {}),
});

// Top-level await works in Strapi's ESM config. If your project is CJS,
// wrap this in an IIFE and await inside the factory below.
await client.start();

process.on("SIGINT", () => void client.stop({ flushTimeoutMs: 10_000 }));
process.on("SIGTERM", () => void client.stop({ flushTimeoutMs: 10_000 }));

export default () =>
  clearvoianceStrapiMiddleware(client, {
    // Strapi's auth plugin populates ctx.state.user after its own middleware
    // runs, so the userId is picked up on response-finish.
    userExtractor: (ctx) => ctx.state?.user?.id,
  });
```

## 2. Register it

Edit `config/middlewares.ts`:

```ts
export default [
  "strapi::errors",
  "strapi::security",
  "strapi::cors",
  "strapi::poweredBy",
  "strapi::logger",
  "strapi::query",
  "strapi::body",
  "strapi::session",
  "strapi::favicon",
  "strapi::public",
  // Add this line — order matters: AFTER `strapi::body` so request bodies
  // are parsed, AFTER `strapi::session` so ctx.state.user resolves.
  "global::clearvoiance",
];
```

## 3. Run

```bash
export CLEARVOIANCE_ENGINE_URL=127.0.0.1:9100
export CLEARVOIANCE_API_KEY=dev        # use a real key in prod, see `clearvoiance api-keys create`
export CLEARVOIANCE_WAL_DIR=.clearvoiance-wal
npm run develop
```

Every request Strapi serves will stream to the engine. Stop with `Ctrl-C` —
the SIGINT/SIGTERM handler above flushes in-flight events before exit.

## Caveats

- **Admin panel requests** are captured too. If you'd rather skip them, add
  a `pathFilter` via the koa adapter options (Strapi factory forwards them):
  ```ts
  clearvoianceStrapiMiddleware(client, {
    userExtractor: (ctx) => ctx.state?.user?.id,
    pathFilter: (path) => !path.startsWith("/admin"),
  });
  ```
- **Multipart uploads** are not redacted by default — configure `maxBodyInlineBytes`
  to keep binary blobs out of the inline path.
- **Session name** should be stable across process restarts if you rely on WAL
  drain; otherwise a new session starts on every boot.
