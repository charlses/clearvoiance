# Phase 6 — Frontend

**Duration:** 2 weeks.
**Goal:** A production-quality Next.js dashboard for the full clearvoiance workflow: create capture → monitor live → stop → configure replay → watch replay → analyze results.

## Deliverables

### Pages

#### `/` — Dashboard

Landing view after login:

- Active sessions widget (count, links to live view).
- Recent captures (last 20, with status and duration).
- Recent replays (last 20, with pass/fail status).
- Storage stats (events / blobs / disk used).
- Engine health.

#### `/sessions` — Sessions list

- Filterable table: status, labels, created_at range.
- Columns: name, status (pill), event count, duration, labels, created, actions.
- Bulk actions: delete, export.
- "New session" CTA.

#### `/sessions/new`

Form:
- Name
- Labels (key-value chips)
- Event types to capture (checkbox list)
- Redaction config:
  - Preset toggles: "redact authorization", "redact cookies"
  - Header denylist (chip input)
  - JSONPath denylist (chip input, with live-test pane)
- Sample rate slider
- Body inline threshold slider

On submit → returns session ID + **copyable setup snippet** for the SDK:

```ts
// Paste into your app
import { createClient } from '@clearvoiance/node';
import { captureHttp } from '@clearvoiance/node/http/strapi';

const client = createClient({
  engine: { url: 'grpc://...', apiKey: '...' },
  session: { id: 'sess_abc...' },
  // ...
});
```

With a "Copy" button for each code snippet.

#### `/sessions/:id`

Session detail page. Tabs:

1. **Overview** — metadata, start/stop time, total events, breakdown by type, byte totals.
2. **Events** — event browser (see below).
3. **Live** — if active, realtime view.
4. **Replays** — list of replays run against this session.
5. **Settings** — redaction config (readonly during active capture).

#### `/sessions/:id/events` — Event browser

A powerful event inspector. This is one of the most important views.

- Left pane: virtualized list of events with compact display (ts, type pill, method/event, path).
- Right pane: full event detail (expandable sections for headers, body, response).
- Top bar:
  - Type filter (HTTP/socket/cron/webhook/outbound).
  - Text search (path, event name).
  - Time range slider scoped to session start/end.
  - Export filtered subset.
- Virtualization: `@tanstack/virtual` — lists of 1M events must scroll smoothly.
- Pagination: cursor-based via REST.

#### `/sessions/:id/live`

Live capture view. Subscribes to WS topics:

- `session.{id}.events` — streaming log of latest events (auto-scroll, pause button).
- `session.{id}.stats` — live sparkline: events/s, bytes/s, endpoint breakdown.
- Big "STOP" button.

#### `/sessions/:id/replay/new`

Replay configuration form:

- Target URL.
- Speedup (slider 1×–100× with presets).
- Virtual users (1–100).
- Auth strategy (dropdown: none / jwt-resign / static-swap / callback).
- Auth config (fields depend on strategy).
- Mutator:
  - None
  - Unique fields: JSONPath chip input.
- DB observer toggle + Postgres DSN.
- Estimated replay duration + warning if > threshold.

Submit → redirects to `/replays/:id`.

#### `/replays/:id`

Replay live/results page.

During run:

- Progress bar (events_fired / total).
- Live metrics: req/s, p50/p95/p99 latency, error rate, lag p99.
- Live chart: latency over replay time.
- Live DB observations pane (streaming).

After completion:

- Summary card: status, duration, totals, pass/fail indicator vs. thresholds.
- Latency distribution histogram.
- Top-N slowest endpoints.
- Top-N endpoints by error rate.
- Link to DB analysis tab.

Tabs:

1. **Summary**
2. **Event results** — per-event table (scheduled vs actual time, lag, status, duration).
3. **DB observations** — see below.
4. **Comparison** — compare to prior replays of same session.

#### `/replays/:id/db` — DB observations

- Flame graph: queries by total duration, grouped by fingerprint.
- Lock contention timeline (horizontal bars showing lock holds per relation over replay time).
- Slow query table: fingerprint, count, total time, avg time, caused-by endpoint.
- Click fingerprint → EXPLAIN plan modal (rendered as nested tree).
- Deadlock detail view: full lock graph (d3 force layout).

#### `/settings`

- API keys (create, revoke, copy plaintext once).
- Storage config (read-only).
- Retention settings.
- Engine version + SDK compatibility.

### Components (reusable)

- `<EventTimeline>` — horizontal zoomable timeline showing events by type (d3 + canvas for perf).
- `<EventList>` — virtualized list (tanstack-virtual).
- `<EventDetail>` — detail panel with tabs for request/response/metadata.
- `<MetricChart>` — recharts line/bar wrapper with consistent styling.
- `<StatusPill>` — session/replay status indicators.
- `<CodeSnippet>` — syntax highlighted + copy button (Shiki).
- `<DbFlameGraph>` — custom d3 component.
- `<LockGraph>` — d3 force-directed lock relationship graph.
- `<ExplainPlan>` — tree view of Postgres EXPLAIN output.

### State management

- **Server state:** TanStack Query. All REST calls wrapped as hooks (`useSession`, `useReplay`, `useDbObservations`).
- **Client state:** Zustand for UI-only state (sidebar collapsed, current filters, etc.).
- **WebSocket:** singleton connection manager; components subscribe via a hook (`useWsTopic('session.abc.events')`).

### Theming

- Tailwind + shadcn defaults.
- Light + dark modes (system-default).
- High-contrast mode for accessibility.
- Monospace code blocks, readable fonts everywhere.

### API client

Generated from the engine's OpenAPI spec (`openapi-typescript-codegen`):

```
ui/src/lib/api-client/ (generated, gitignored)
ui/src/lib/api.ts (thin wrapper for auth headers)
```

### Auth

- Login: enter API key. Stored in localStorage.
- No per-user accounts for v1.
- "Log out" clears localStorage + redirects to login.

### Performance targets

- First paint < 1.5s on cached load.
- Event list scrolls at 60fps with 100k events loaded.
- Live view: < 250ms from engine emit → UI render.

### Accessibility

- All interactive elements keyboard-navigable.
- ARIA labels on icons.
- Color-blind-safe palette for status indicators.
- Screen reader labels on charts via accessible tables adjacent.

## Acceptance criteria

1. Full workflow is completable via UI alone: create session → copy snippet → capture → stop → replay → review DB findings.
2. Live view: during a running capture generating 100 events/s, UI shows events scrolling with no dropped frames and < 1s latency.
3. Event browser: loading a session with 100K events renders instantly; scrolling is smooth.
4. Replay page: metrics update every 250ms; latency chart renders without lag.
5. DB flame graph: click to drill into a slow query reveals EXPLAIN plan.
6. UI works on Chrome, Firefox, Safari (current + N-1 versions).
7. Lighthouse: Performance 90+, Accessibility 95+.

## Non-goals

- Mobile-optimized layouts (desktop-first for v1, but not broken on mobile).
- Multi-user features (invites, permissions).
- In-UI editing of redaction rules after session creation.
- AI-generated insights ("here's what to fix").

## Implementation order

**Week 1 — foundations + core pages**

1. Next.js + shadcn install, layout shell, sidebar nav.
2. Auth gate + API client + TanStack Query setup.
3. Dashboard page (static data).
4. Sessions list page.
5. New session form → creates session via API.
6. Session detail overview tab.
7. Event browser (table + detail pane).
8. Deploy UI container in `docker-compose.yml`.

**Week 2 — live + replay + polish**

9. WebSocket client + `useWsTopic` hook.
10. Live session view.
11. Replay config form.
12. Replay live view.
13. Replay results tabs (summary, events, comparison).
14. DB flame graph.
15. Lock timeline.
16. EXPLAIN plan viewer.
17. Settings page (API keys).
18. Theming polish, empty states, error states.
19. Lighthouse pass + a11y pass.

## Testing

### Unit
- vitest + React Testing Library for components.
- Especially cover: event filters, chart data transforms, WS message handling.

### E2E (Playwright)
- Full workflows: create session → capture fake traffic → stop → replay → assertions on replay result page.
- Run against compose-up stack.

### Visual regression
- Playwright screenshot comparison on key pages (optional v1, must-have v1.5).

## Open questions

- **State of big lists on reload:** 100k events cursor-paginated. Resume position on reload? Hash-state in URL.
- **Theming brand:** colors, logo, font. Needs design pass or stock shadcn defaults with custom accent.
- **Sticky filters:** remember user's last filter selection across reloads? Likely yes via localStorage.
- **Multi-session compare view:** v2 feature. Note but skip.

## Time budget

| Area | Estimate |
|---|---|
| Shell + auth + API client | 1 day |
| Dashboard + sessions list + new session | 1.5 days |
| Event browser | 2 days |
| Live view (WS) | 1.5 days |
| Replay form + live view | 2 days |
| Replay results + analysis | 1.5 days |
| DB visualizations (flame + locks + explain) | 2.5 days |
| Settings + polish + a11y | 1 day |
| E2E tests | 1 day |
| **Total** | **~14 days** |
