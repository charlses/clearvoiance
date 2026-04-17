# 22 — Open Questions & Decision Log

Living document. Unresolved questions move to "Resolved" with date and rationale once decided. Re-opening a resolved question requires updating the resolution with new context.

## Open

### Product

#### Q1. Where does clearvoiance live — OSS only, OSS + paid cloud, or OSS + enterprise features?

Options:
- **A.** Pure OSS, Apache-2.0, no paid tier. Sustained via sponsorship + consulting.
- **B.** OSS core + hosted cloud SaaS (like Grafana/PostHog).
- **C.** OSS core + enterprise features gated (SSO, SAML, RBAC, audit, SLA).

Impact: affects early architecture (multi-tenant concerns), license strategy, and contributor expectations.

**Deadline:** decide before Phase 8 launch. Default assumption for planning: (A).

#### Q2. Which language SDK comes second — Python, Go, or Ruby?

- Python: largest non-Node audience; Django/Flask/FastAPI cover ~60% of modern web backends.
- Go: smaller audience for app-level capture, but engine is Go so contributors exist.
- Ruby: Rails still massive; Sidekiq + Rails adapters would be very appealing.

**Deadline:** Phase 8 retrospective. Community demand will likely decide.

#### Q3. Does replay need a "dry run" mode that schedules everything but doesn't send?

Use case: validate that auth strategies and mutators work without stressing the SUT.

Leaning: yes, it's cheap to implement. Add as a `--dry-run` flag in Phase 2 if time.

### Architecture

#### Q4. ClickHouse + MinIO is the right storage — but DuckDB-embedded for self-host single-box?

ClickHouse is overkill for single-box dev. DuckDB has similar columnar performance and embeds in-process, zero ops.

Proposal: `storage.mode: embedded` uses DuckDB + local FS. `storage.mode: distributed` uses ClickHouse + S3.

**Deadline:** Phase 5. Low-effort add; high dev-experience payoff.

#### Q5. Should the engine expose a "sidecar" mode where it runs inside the SUT's pod/container?

Ultra-low latency capture (loopback gRPC), no network hops. Tradeoff: resource contention with SUT.

Leaning: document as deployment topology, no code change needed — it's just a compose/helm config choice. Add in Phase 8 docs.

#### Q6. How do we handle streaming HTTP responses (SSE, chunked)?

Currently captured as a single `HttpEvent` with the full body. SSE streams are unbounded → can't fit inline or even practically in a blob.

Options:
- **A.** Drop bodies for `text/event-stream` and `transfer-encoding: chunked` responses, keep headers + duration only.
- **B.** Capture chunks as separate events linked by a `stream_id`.

Leaning: (A) in v1, (B) as a later enhancement. Document limitation.

**Deadline:** Phase 1 design complete.

#### Q7. gRPC-web for browser-based capture?

Some SaaS products want to capture from a browser (e.g., intercept frontend telemetry). Browsers can't do raw gRPC; need gRPC-web or a proxy.

Leaning: out of scope for v1. Focus on backend capture. Noted for future.

### Implementation

#### Q8. Go Socket.io client library — use existing or port?

No production-grade Go Socket.io client exists. Options:
- **A.** Port a subset of `socket.io-client` (the protocol is documented).
- **B.** Spawn Node subprocesses per virtual user (ugly but works).
- **C.** Drop Socket.io replay for v1, add in v1.5.

Leaning: (A) with scope limited to what our captured sessions use. Budget 3 days in Phase 2.

#### Q9. How does the SDK discover the engine's address?

Options:
- **A.** Hardcoded env var `CLEARVOIANCE_ENGINE_URL`.
- **B.** DNS-based SRV record `_clearvoiance._tcp.<domain>`.
- **C.** A sidecar pattern where engine is always at `localhost:9100`.

Leaning: (A) simplest. Document (C) as a recommended K8s deployment pattern.

#### Q10. UUID v7 vs. ULID for event IDs?

Both are timestamp-ordered. UUID v7 is standardized (RFC 9562); ULID is more widely known but non-standard.

Leaning: UUID v7. Standards compliance > familiarity.

#### Q11. How do we handle the SUT changing versions between capture and replay?

If SUT deployed in Oct captures events, then is updated in Nov with new endpoints/schemas → Nov replay may break in weird ways.

Approach: 
- Session metadata captures SUT git SHA (configurable).
- Replay warns if target SUT's SHA differs from session's captured SHA.
- Operator decides to proceed or not.

**Deadline:** Phase 2. Low effort.

### Operational

#### Q12. What's the default retention for captured data?

30 days is proposed. Too long? Too short?

- Too long: huge storage bill.
- Too short: can't investigate month-old incidents.

Leaning: 30 days default, prominent warning about data sensitivity, documented how to change.

#### Q13. Multi-tenant engine, or one engine per environment?

For self-host: one engine per env (dev/staging/prod). Clean isolation. Easy.

For hosted cloud (if Q1 resolves to B): need multi-tenant. Orgs, users, quotas, etc.

**Deadline:** tied to Q1. Default plan: single-tenant v1.

#### Q14. Feature flags / experimental modes?

Do we ship features behind flags, or straight enable?

Leaning: flags for anything marked "experimental" in docs. E.g., `experimental.queue_adapter: true`. Stable features no flags.

### Community / OSS

#### Q15. CLA or DCO?

CLA (Contributor License Agreement) is more enterprise-friendly but adds friction. DCO is a sign-off, less friction, widely accepted.

Leaning: DCO. Enforce via `DCO` bot on PRs.

#### Q16. Governance model?

v1: BDFL (original author).

v1.5+: consider Apache-style meritocratic (committers, PMC). Worth deciding before ~10 significant external contributors.

#### Q17. Where does the project live — personal GitHub or an org?

If the author expects to spin up a company around it (Q1 → B or C), the repo under `<company>` org makes sense. If pure OSS forever, personal or foundation (e.g., CNCF Sandbox in future).

**Deadline:** decide before Phase 8.

### Naming

#### Q18. Is "clearvoiance" the final name?

Concerns:
- Spelling: intentional but may confuse ("clairvoyance"?).
- Trademark availability: needs check before launch.
- Domain availability: needs check (`.io`, `.com`, `.dev`).

**Deadline:** Phase 8 prep. If blocked, have 3 fallback names ready.

## Resolved

<!-- Format:
### Q#. Question (resolved YYYY-MM-DD)
Decision: ...
Rationale: ...
Alternatives considered: ...
-->

### Q0. Go vs Rust for engine (resolved 2026-04-17)

**Decision:** Go.

**Rationale:** User explicitly specified Go. Agrees with project's assessment: simpler contributor onboarding, sufficient performance for target workload, ecosystem fit.

**Alternatives:** Rust (rejected: contributor pool smaller, compile times, diminishing returns on perf for this workload).

### Q-initial. Mongo vs ClickHouse for event storage (resolved 2026-04-17)

**Decision:** ClickHouse.

**Rationale:** Columnar time-series storage is a much better fit than Mongo for the read pattern (replay = full ordered scan by timestamp). 5-10× storage efficiency. Faster ingest. Open source.

**Alternatives:** Mongo (author's initial suggestion, rejected after analysis), Postgres (doesn't scale for target volumes), Timescale (ClickHouse wins on ingest and compression).

## How to add an entry

1. Under "Open," add `### Q<next>. Short question` with context.
2. Discuss in PR, tickets, or design doc.
3. When decided: move to "Resolved" with date, decision, rationale, alternatives.
4. Update relevant phase docs to reference the decision.
5. If resolution is reopened later: add a "**Updated YYYY-MM-DD:**" section to the resolved entry, don't move it back.
