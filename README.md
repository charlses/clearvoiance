# clearvoiance

> Reproducible, time-compressed traffic replay for stress testing real systems.

**clearvoiance** captures everything hitting your backend — HTTP, WebSockets, cron triggers, webhooks, queue messages — and replays it at N× speed against a hermetic clone of your system. You find the breaking points *before* production does.

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

Planning phase. See [`plan/`](./plan/README.md) for the full roadmap across 9 phases (~12 weeks to OSS launch).

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
