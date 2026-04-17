# 00 — Vision

## What clearvoiance is

A self-hostable, open-source **traffic capture and time-compressed replay system** for stress testing real backend systems. It records every input your system receives over a time window — HTTP, WebSockets, cron triggers, webhooks, queue messages — and replays that stream at N× speed against a hermetic clone of the system, while observing the database side to pinpoint which replay event caused which performance problem.

## The core insight

**A system under test (SUT) is a pure function of its inputs.** If we capture every input to the SUT over a time window, we can deterministically reproduce any load pattern. Compressing the replay timeline (1 hour → 5 minutes) turns realistic production traffic into a real stress test, because the SUT must now handle 12× the concurrency without 12× the hardware.

## Problems this solves

### 1. Synthetic load tests don't look like real traffic

Teams write k6/Artillery/Locust scripts that approximate "a user browsing." Real users don't do that. Real traffic has:

- Long-tail request shapes (that one weird endpoint that makes up 3% of calls)
- Correlated bursts (CRM sync at :00, newsletter send at :15)
- Cross-protocol choreography (user hits HTTP API, then opens WebSocket, then a cron reads the data they wrote)
- Auth token refresh patterns, retry storms, partial failures

Synthetic tests miss all of this. You find out in production.

### 2. Traffic replay tools are too simple

Tools like GoReplay record HTTP and replay it at wall-clock speed. They don't:

- Capture sockets, crons, or webhooks
- Mock outbound side effects (so replays send real emails, real Telegram messages, real S3 uploads)
- Compress time
- Observe the database while replaying

### 3. Chaos tools inject failures but don't load

Toxiproxy, Chaos Mesh, etc. model infrastructure failures. They don't model traffic volume.

clearvoiance combines all three: realistic traffic + compressed time + hermetic replay + DB observability.

## Target users

| User | Use case |
|---|---|
| **Backend teams** | Pre-release load testing with real traffic shapes |
| **SREs on-call** | "We had an incident at 14:00–15:00. Can we replay that hour to reproduce?" |
| **DevOps / Platform teams** | CI regression load tests against every release candidate |
| **Consultants** | Benchmark a client's system against its own traffic |
| **Capacity planners** | "What's our breaking point at 5× current traffic?" |

## What clearvoiance is NOT

- **Not an APM.** It's not replacing Datadog/New Relic. Observability during replay is scoped to load testing insights.
- **Not a production middleware.** The capture SDK is designed for low overhead but is meant for staging / pre-prod / deliberate capture windows, not 24/7 production. (That's a potential later direction but explicitly not v1.)
- **Not a functional test framework.** We don't assert on business logic correctness; we measure performance characteristics.
- **Not an alternative to unit/integration tests.** It's a different layer.

## Differentiators

Against the closest alternatives:

| | k6 | GoReplay | clearvoiance |
|---|---|---|---|
| Real traffic input | ✗ (hand-written) | ✓ | ✓ |
| Multi-protocol (HTTP+socket+cron) | partial | ✗ | ✓ |
| Time compression | ✗ | ✗ | ✓ |
| Hermetic outbound mocking | ✗ | ✗ | ✓ |
| DB-side observability correlated to events | ✗ | ✗ | ✓ |
| Cross-language SDKs | ✗ | N/A | ✓ (Node first, others later) |
| Self-hostable OSS | ✓ | ✓ | ✓ |

## Name

**clearvoiance** — reading the future of your system under load. (Intentional spelling. Domain availability and branding TBD in Phase 8.)

## Success metrics

### Technical

- Capture overhead < 5% CPU, < 10MB additional memory per SDK instance at 1000 rps.
- Replay at 100× captured rate without > 50ms p99 timing lag (on reference hardware).
- DB observer correctly attributes ≥ 80% of slow queries to originating replay events.

### Adoption (6 months post-launch)

- 1,000 GitHub stars
- 100 npm weekly downloads of `@clearvoiance/node`
- 10 public testimonials / blog posts from external users
- 5 external contributors merged to main

## North star

> Any production engineer should be able to pull a 1-hour window of real traffic off their system, replay it at 12× in CI before each release, and automatically block deploys that introduce N+1 queries, lock contention, or latency regressions — without writing a single load test script.
