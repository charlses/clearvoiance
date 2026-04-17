# Phase 3 — Hermetic Mode

**Duration:** 1 week.
**Goal:** SUT under replay performs **zero real external I/O**. No real emails sent, no real Telegram messages, no real OpenAI charges, no real S3 uploads. Cron fires only from replay events, not from the SUT's own scheduler.

Without this phase, replay is dangerous. Teams won't run it.

## The model

During normal operation, the SUT reacts to inbound events by producing outbound effects (API calls, emails, etc.). During capture, clearvoiance records **both**: the inbound event AND the outbound effects it caused, linked by `caused_by_event_id`.

During replay, the SUT is put in **hermetic mode** via `CLEARVOIANCE_HERMETIC=true`. In this mode:

1. **Outbound HTTP calls are intercepted.** Instead of hitting real APIs, they're matched against captured outbound responses and served from memory.
2. **Email/Telegram/S3 clients are intercepted.** Most of these use HTTP under the hood — the outbound HTTP patch catches them. Native SMTP (nodemailer direct) and SDK-level wrappers get their own wrappers.
3. **The native cron scheduler is disabled.** No job fires autonomously. The replay engine fires cron events at the compressed timing instead.
4. **An internal invocation endpoint is exposed** for the engine to trigger cron handlers directly.

## Deliverables

### SDK: outbound capture (Phase 1 extension)

This is delivered in Phase 1 as part of normal capture but the details belong here:

`@clearvoiance/node/outbound`:

- `patchHttp(client)` — monkey-patches global `http.request` and `https.request`.
- `patchUndici(client)` — patches `undici.fetch` and `undici.request`.
- `patchAxios(axiosInstance, client)` — Axios interceptor.
- Each patch emits an `OutboundEvent` with:
  - `target` — derived from hostname (e.g. `api.telegram.org` → `telegram.api`)
  - `http` — full HttpEvent
  - `caused_by_event_id` — pulled from AsyncLocalStorage context
  - `response_hash` — sha256 of response body for dedup

AsyncLocalStorage context propagation: when an inbound HTTP/socket/cron event is captured, the SDK opens a context with `currentEventId`. Any outbound call within that async scope automatically inherits `caused_by_event_id`.

### SDK: hermetic mode (`@clearvoiance/node/hermetic`)

Activated by `CLEARVOIANCE_HERMETIC=true` env var. On activation:

#### Outbound interception

Same patches as capture mode, but swapped: instead of recording, they **return captured responses**.

```ts
// Pseudocode
http.request = (opts, cb) => {
  const signature = hash({ method, host, path, body_hash });
  const captured = mockStore.lookup(currentEventId, signature);

  if (captured) {
    return simulateResponse(captured);
  }

  switch (policy) {
    case 'strict': throw new Error(`Unmocked outbound: ${signature}`);
    case 'loose':  return simulateResponse({ status: 200, body: '{}' });
    case 'passthrough': return original(opts, cb);  // dangerous, dev-only
  }
};
```

#### Mock store (`@clearvoiance/node/hermetic/mock-store`)

On replay start, the engine sends the SUT a mock store populated from captured outbound events. Delivery mechanism:

- On hermetic activation, SDK connects to the engine (via `CLEARVOIANCE_ENGINE_URL`) and requests the mock pack for the current `REPLAY_ID`.
- Engine streams mocks indexed by `(caused_by_event_id, signature)`.
- SDK holds them in an LRU cache (size configurable, default 100MB).

#### Outbound matching semantics

Signature: `sha256(method + host + path + canonicalized(body))` where `canonicalized()` removes volatile fields (timestamps, nonces) per configuration:

```ts
hermetic: {
  policy: 'strict',
  canonicalize: {
    ignoreJsonPaths: ['$.timestamp', '$.nonce', '$.request_id'],
    ignoreHeaders: ['date', 'x-request-id'],
  },
}
```

Multiple captured responses for the same signature (due to repeated identical outbounds) → cycle through them in order.

#### Cron killer

`@clearvoiance/node/hermetic/cron-killer`:

- Patches `node-cron.schedule` to register jobs WITHOUT starting them.
- Patches `agenda.start()` to be a no-op.
- Patches `bullmq.Worker` to not consume from queue (jobs only run via explicit invocation endpoint).
- Registers jobs in an internal registry for the invocation endpoint.

#### Internal invocation endpoint

`@clearvoiance/node/hermetic/invoke-server`:

- Listens on `127.0.0.1:7777` (configurable).
- `POST /invoke/cron { name, args }` → runs the registered cron handler.
- `POST /invoke/queue { queue, payload }` → runs the registered queue handler.
- Only accessible from localhost by default. Token-auth option for cross-container setups.

This endpoint is what the engine's cron/queue dispatchers POST to.

### Engine side: mock pack delivery

`engine/internal/replay/mockpack/`:

- On replay start, builds a mock pack from ClickHouse:
  ```sql
  SELECT caused_by_event_id, http.body_hash, http.status, http.body, http.headers
  FROM events
  WHERE session_id = :source AND event_type = 'outbound';
  ```
- Serves mock pack via gRPC:
  ```proto
  service Hermetic {
    rpc GetMockPack(GetMockPackRequest) returns (stream MockEntry);
  }
  ```
- Mock pack is scoped to the replay ID and expires when replay finishes.

### Configurable policies

```ts
hermetic: {
  policy: 'strict' | 'loose' | 'passthrough',
  // strict: throw on unmocked outbound (default)
  // loose:  return 200 {} on unmocked (for rapid iteration)
  // passthrough: allow real call (dev only, loud warning)

  onUnmocked: (req) => {  // hook for custom handling
    // return a mock response, or null to fall through to policy
  },

  recordUnmocked: true,  // if true, unmocked outbounds are logged to the engine
                          // for the operator to decide to add to future mocks
}
```

### SUT README template additions

Document required environment for hermetic replay:

```sh
# During replay, set on the SUT:
CLEARVOIANCE_HERMETIC=true
CLEARVOIANCE_REPLAY_ID=<uuid>
CLEARVOIANCE_ENGINE_URL=grpc://engine:9100
CLEARVOIANCE_API_KEY=<key>
CLEARVOIANCE_HERMETIC_POLICY=strict
```

## Acceptance criteria

1. Capture a session against the example Strapi app, including outbound calls to a mock Telegram server (via nock).
2. Replay the session with `CLEARVOIANCE_HERMETIC=true`. Monitor the mock Telegram: **zero requests received** during replay.
3. SUT's application logs show "outbound HTTP intercepted by hermetic" for each captured outbound.
4. Strict mode: replay a session that, due to a code change in the SUT, issues a *new* outbound not in the mock pack. Replay fails fast with an actionable error pointing at the unmocked call.
5. Loose mode: same scenario, replay continues, logs the unmocked signature.
6. Cron: during 1-hour replay at 12×, the SUT's own cron scheduler fires **zero** times. Captured cron events fire via the invocation endpoint at correct compressed timings.
7. No changes to SUT code required beyond adding middleware (`patchHttp` etc. are auto-applied when hermetic env vars are set).

## Non-goals

- Outbound capture modes beyond HTTP-based (e.g., raw SMTP). Most services use HTTP-based APIs; raw SMTP is rare and deferred.
- Binary response bodies over ~1MB. Document the limit.
- Perfect canonicalization of every third-party API. Provide defaults + escape hatches.

## Implementation order

1. AsyncLocalStorage context propagation in Phase 1 SDK (already required for capture).
2. `@clearvoiance/node/outbound/http.ts` — outbound HTTP patch for capture.
3. Capture a session with outbounds; verify `OutboundEvent` records are correct.
4. `@clearvoiance/node/hermetic/mock-store.ts` — in-memory LRU with signature lookup.
5. `@clearvoiance/node/hermetic/intercept.ts` — re-use patches, swap behavior to mock response.
6. Engine `/hermetic` gRPC service + mock pack query.
7. SDK: on hermetic startup, fetch mock pack.
8. `@clearvoiance/node/hermetic/cron-killer.ts`.
9. `@clearvoiance/node/hermetic/invoke-server.ts`.
10. Wire cron dispatcher (Phase 2) to invoke-server.
11. E2E test: capture-with-outbounds → hermetic replay → verify zero real outbounds.
12. Canonicalization config + unit tests.
13. Policy modes (strict/loose/passthrough).

## Testing

### Unit
- Signature canonicalization (volatile fields stripped correctly).
- Mock store hit/miss.
- Cron killer: jobs are not auto-started.

### Integration
- Nock-backed test: capture outbounds → replay → assert nock saw zero calls.
- Strict policy: unmocked outbound throws.
- Policy fallbacks behave correctly.

### E2E
- Full capture → hermetic replay against example Strapi that hits a mock Telegram + mock OpenAI in both phases.

## Open questions

- **Response streaming:** some outbounds stream large bodies (file downloads). Mock store would need to stream too. v1: buffer limit 5MB; larger responses return an error and are noted for future work.
- **Time-dependent mocks:** some APIs return data tied to server time. Do we serve the captured response verbatim even though the SUT "sees" a different time? v1: yes, document it.
- **Stateful outbounds (e.g., database queries over HTTP):** if the SUT expects a sequence of different responses for repeated identical queries, our cycle semantics should match. Confirm with a test case.
- **Nodemailer raw SMTP:** defer. Document that SMTP-level email sending is not covered by hermetic mode in v1; users should use SES/Postmark/Mailgun HTTP APIs.

## Time budget

| Area | Estimate |
|---|---|
| Outbound HTTP patch + context propagation | 1 day |
| Mock pack storage + query | 1 day |
| Mock store + intercept | 1 day |
| Cron killer + invoke-server | 1 day |
| Policy + canonicalization | 1 day |
| E2E + docs | 1 day |
| Buffer | 1 day |
| **Total** | **~7 days** |
