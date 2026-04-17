# clearvoiance — planning docs

These docs define the project from zero to OSS launch.

**Read order:** design docs (00–05) first to understand the system, then phase docs (10–18) in sequence for execution.

## Design docs (read these first)

| Doc | What it covers |
|---|---|
| [00-vision.md](./00-vision.md) | What we're building, who it's for, why it matters |
| [01-architecture.md](./01-architecture.md) | System diagram, components, data flow, boundaries |
| [02-tech-stack.md](./02-tech-stack.md) | Go / TS / ClickHouse / Next.js — rationale per choice |
| [03-event-schema.md](./03-event-schema.md) | Canonical event format (protobuf) |
| [04-protocol-spec.md](./04-protocol-spec.md) | SDK ↔ engine wire protocol (gRPC) |
| [05-repo-structure.md](./05-repo-structure.md) | Monorepo layout, workspaces, build tools |

## Phase docs (execute in order)

| Phase | Duration | Goal |
|---|---|---|
| [10 — Phase 0: Foundations](./10-phase-0-foundations.md) | 3 days | Monorepo, CI, licensing, contribution guide |
| [11 — Phase 1: Capture MVP](./11-phase-1-capture-mvp.md) | 2 weeks | Node SDK + Go ingest + ClickHouse storage |
| [12 — Phase 2: Replay Engine](./12-phase-2-replay-engine.md) | 2 weeks | Go replayer with timer wheel, N× speedup |
| [13 — Phase 3: Hermetic Mode](./13-phase-3-hermetic-mode.md) | 1 week | Outbound mock layer, cron neutering |
| [14 — Phase 4: DB Observer](./14-phase-4-db-observer.md) | 1 week | Postgres observer, slow query correlation |
| [15 — Phase 5: Control Plane API](./15-phase-5-control-plane.md) | 1 week | REST + WebSocket API |
| [16 — Phase 6: Frontend](./16-phase-6-frontend.md) | 2 weeks | Next.js dashboard with live views + analytics |
| [17 — Phase 7: Adapter Ecosystem](./17-phase-7-adapters.md) | 1 week | Express/Fastify/Nest/Koa/BullMQ/RabbitMQ adapters |
| [18 — Phase 8: OSS Launch](./18-phase-8-oss-launch.md) | 1 week | Docs site, Helm, Docker images, public release |

**Total: ~12 weeks to public OSS launch.**

## Cross-cutting docs

| Doc | What it covers |
|---|---|
| [20-security.md](./20-security.md) | PII redaction, encryption at rest, API auth, hermetic safety |
| [21-testing.md](./21-testing.md) | Unit, integration, e2e strategy across Go + Node + UI |
| [22-open-questions.md](./22-open-questions.md) | Unresolved decisions, tradeoffs still being evaluated |

## How to use these docs

- **Before starting a phase:** read its doc end-to-end. Every phase has `goals`, `deliverables`, `non-goals`, `acceptance criteria`, and `open questions`. Resolve the open questions or move them to phase N+1 before coding.
- **During a phase:** track progress in a phase-specific TODO inside this folder, e.g. `phase-1-progress.md`. Don't pollute the spec doc.
- **After a phase:** update the spec doc with anything that changed in practice (deviations, gotchas, post-mortem notes) so future contributors know what to trust.

## Decision log convention

When a non-trivial design decision is made, add an entry to `22-open-questions.md` under "Resolved" with date, decision, rationale, and alternatives considered. Avoids re-litigating the same argument every 3 weeks.
