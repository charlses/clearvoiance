# @clearvoiance/ui

Next.js 16 dashboard for the clearvoiance engine. Consumes the engine's
REST API (`/api/v1/*`) and WebSocket hub (`/ws`) — see
`plan/16-phase-6-frontend.md` for the full design.

## Dev

```bash
pnpm install        # from the monorepo root
pnpm dev            # starts Next.js on :3100
```

The UI expects an engine reachable at `http://127.0.0.1:9101` by default.
Override with `NEXT_PUBLIC_CLEARVOIANCE_API`:

```bash
NEXT_PUBLIC_CLEARVOIANCE_API=http://engine.staging:9101 pnpm dev
```

On first load — if the engine has no users yet — you'll be redirected
to `/setup` to create the admin account. After that, `/login` takes
email + password. Auth is a session cookie (clv_session, HttpOnly);
API keys are managed from **Settings → API keys** inside the authed
dashboard. The paste-API-key login flow is gone — API keys are
programmatic (SDK) access only.

## Layout

- `src/app/(authed)/*` — app pages behind the auth gate (dashboard,
  sessions, replays, settings).
- `src/app/setup/*` — first-run wizard (only reachable when users is
  empty).
- `src/app/login/*` — email + password login page.
- `src/lib/api.ts` — typed REST client. Every request goes out with
  `credentials: "include"` so the session cookie rides along.
- `src/lib/ws.ts` + `src/lib/hooks/use-ws-topic.ts` — WebSocket singleton
  and subscribe hook. The browser sends the cookie on the WS upgrade
  handshake; no in-protocol auth needed.
- `src/components/ui/*` — shadcn-style primitives (Card, Button, Table,
  StatusPill, Code).
- `tests/e2e/*.spec.ts` — Playwright happy-path tests with a mocked
  engine (`page.route()`).

## Commands

```bash
pnpm dev        # Next.js dev server on :3100
pnpm build      # production build
pnpm start      # serve the production build on :3100
pnpm lint       # ESLint
pnpm typecheck  # tsc --noEmit
pnpm test       # Playwright e2e (builds + serves + runs)
```

## Live progress

Replay detail (`/replays/[id]`) subscribes to the engine's
`replay.<id>.progress` topic while status is `running` or `pending`.
The 250ms snapshots override the REST counters in-flight; once the
replay finishes, the final `status:"finished"` snapshot arrives and
the page reverts to pure REST polling.

If the engine's topic semantics change, keep `src/lib/hooks/use-ws-topic.ts`
and the detail page's subscription in sync.
