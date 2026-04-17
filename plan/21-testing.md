# 21 — Testing Strategy

Testing philosophy: **high confidence, fast feedback, real dependencies where it matters**. No test doubles for ClickHouse or Postgres — we use testcontainers. No test doubles for HTTP — we use real servers. The alternative is bugs that only manifest in prod.

## Test pyramid

```
                  /\
                 /  \
                / E2E\            ~5%, slow, real stack
               /------\
              / Integ  \          ~25%, realistic, testcontainers
             /----------\
            /    Unit    \        ~70%, fast, isolated
           /--------------\
```

## Per-language conventions

### Go (engine, db-observer)

- Framework: stdlib `testing` + `github.com/stretchr/testify/require`.
- File layout: `foo.go` + `foo_test.go` colocated.
- Unit tests: no network, no fs, < 100ms per test.
- Integration tests: behind build tag `//go:build integration`.
  - Use `github.com/testcontainers/testcontainers-go` for ClickHouse, Postgres, MinIO.
  - Parallel-safe.
- Coverage target: 70% for `internal/`, 90% for `storage/`, `replay/scheduler`.
- Coverage gate in CI: fail PR if coverage drops > 2% from main.

### TypeScript (SDK, UI)

- SDK: `vitest`.
- UI: `vitest` + React Testing Library.
- File layout: `foo.ts` + `foo.test.ts` colocated (or `__tests__/` for larger suites).
- Unit tests: no network, stubbed IO.
- Integration tests: in `sdk-node/test/integration/`, use testcontainers to run real engine.
- E2E (UI): Playwright against compose-up stack.

## Test categories

### 1. Unit tests

Per-function or per-module logic. Fast, isolated.

Examples:
- Event builder: input request → expected Event shape.
- Redaction: input body + rules → expected redacted body.
- Timer wheel: insert N events, verify fire times.
- API key validator: various key formats.

### 2. Component integration tests

One component with real dependencies.

Examples:
- gRPC capture server with real ClickHouse → verify events land.
- Replay scheduler with real HTTP dispatcher → verify requests sent.
- SDK client + engine → verify round-trip.

Using testcontainers to spin up ClickHouse/Postgres/MinIO in ~5-10s per suite.

### 3. Cross-component integration tests

Multiple components together, but not the full stack.

Examples:
- Capture → storage → replay → results (engine-only).
- SDK + engine in a compose, run capture, verify.

### 4. End-to-end tests

Full stack. Slow. High confidence.

Examples:
- Strapi example app + engine + UI via compose. Run capture, stop, replay, verify in UI.
- Playwright: "User clicks through the whole flow and sees expected results."

Run via `just e2e`.

Frequency: every PR (optimized to < 10 min), every merge to main (full suite).

### 5. Performance / load tests

Benchmarks that fail CI if performance regresses.

Examples:
- `SDK overhead bench`: measure req/s with and without SDK; fail if delta > 5%.
- `Ingest throughput bench`: 100k events/s → fail if throughput < 80k/s.
- `Timer wheel bench`: 1M events scheduled; fail if p99 lag > 50ms.

Run on merge to main only (not every PR) since they need dedicated hardware.

### 6. Chaos / failure-mode tests

Things that must work even when stuff breaks.

Examples:
- Kill engine mid-stream → SDK writes to WAL → SDK resumes on engine return → no events lost.
- ClickHouse unavailable for 30s → engine retries → no crash.
- Corrupt WAL file → SDK skips with warning, not crash.
- 100× replay against a target that can only handle 10× → engine applies backpressure, doesn't crash.

Run nightly + on release candidates.

### 7. Security tests

- Redaction: fuzz-test with random payloads containing secrets; verify stored events have no secrets.
- Auth: fuzz-test API key verification.
- Input validation: send malformed protos, verify graceful rejection.
- Path traversal: verify no file IO endpoints accept `../` inputs.

CI job: weekly run with extended fuzz budgets.

## Test data management

- **Seed data**: `scripts/seed-test-data.sh` creates a reproducible session with known-shape events. Used in deterministic integration tests.
- **Fixtures**: checked in under `test/fixtures/` as JSON/protobuf files.
- **Synthetic traffic generator**: `scripts/generate-traffic.ts` — hits the example Strapi app with configurable req/s, endpoint mix, body sizes. Used for perf tests.

## CI matrix

```yaml
# .github/workflows/ci.yml

jobs:
  go-unit:
    runs-on: ubuntu-latest
    steps: [..., go test ./... -short]

  go-integration:
    runs-on: ubuntu-latest
    services: {} # testcontainers-go manages its own
    steps: [..., go test -tags=integration ./...]

  sdk-unit:
    runs-on: ubuntu-latest
    steps: [..., pnpm --filter sdk-node test]

  sdk-integration:
    runs-on: ubuntu-latest
    steps: [..., pnpm --filter sdk-node test:integration]

  ui-unit:
    runs-on: ubuntu-latest
    steps: [..., pnpm --filter ui test]

  ui-e2e:
    runs-on: ubuntu-latest
    steps: [..., docker compose up -d, pnpm --filter ui test:e2e]

  typecheck-lint:
    runs-on: ubuntu-latest
    steps: [..., pnpm lint, pnpm typecheck, golangci-lint run]

  proto-check:
    runs-on: ubuntu-latest
    steps: [..., buf lint, buf breaking --against origin/main]

# parallel: all jobs
# blocking for merge: all jobs must pass
```

Timing targets:
- `go-unit`: < 2 min.
- `go-integration`: < 8 min.
- `sdk-*`: < 5 min combined.
- `ui-e2e`: < 12 min.
- Total PR CI: < 15 min.

## Flaky test policy

- Zero tolerance. A flaky test is a broken test.
- Flaky test → auto-marked `flaky` and ticketed.
- Three flakes in 7 days → quarantine (`t.Skip("flaky, see #123")` with link) until fixed.
- Quarantined tests auto-failed weekly until resolved.

## Coverage philosophy

- Coverage is a signal, not a goal. 100% coverage of trivial code is worthless; 60% coverage of mission-critical code is shipping malpractice.
- Target per package:
  - `internal/storage/*`: 90%+ (data loss is forever).
  - `internal/replay/scheduler`: 95%+ (the hardest code, most important).
  - `internal/auth`: 95%+ (security-critical).
  - `internal/api/*`: 80%+.
  - `adapters/*`: 70%+ (pragmatic — adapters are thin).

## Golden file tests

For protobuf events and JSON responses, use golden file testing:

```go
func TestBuildHttpEvent(t *testing.T) {
    input := loadFixture(t, "testdata/inputs/post_users.json")
    got := BuildHttpEvent(input)
    assertGolden(t, "testdata/golden/post_users.event.json", got)
}
```

`UPDATE_GOLDEN=1 go test` regenerates golden files. Reviewers scrutinize golden file diffs in PRs.

## Mutation testing (aspirational)

- Run monthly with `go-mutesting` on critical packages.
- Target mutation score > 60% for `storage`, `scheduler`, `auth`.
- Not a gate; informational to find weak tests.

## Test environments

### Local developer

- `just bootstrap` installs everything.
- `just test` runs unit tests only (fast feedback).
- `just test-integration` runs integration with testcontainers.
- `just e2e` spins up full stack.

### CI

- Same `just` targets. No CI-specific test scripts.

### Preview environments

- Every PR gets a preview stack deployed via Helm to a staging cluster (optional, Phase 8+).
- Review feature behavior manually before merge.

## Writing good tests

- **Arrange, Act, Assert** structure.
- **One assertion per test** (or one logical behavior).
- **Real data, not mocks**: mock only what you can't reach (time, randomness, external APIs outside test boundary).
- **Descriptive names**: `Test_ReplayScheduler_HandlesMillionEventsWithin100ms`, not `TestScheduler1`.
- **Failure messages that help**: `require.Equal(t, expected, got, "events should be ordered by timestamp")`.
- **No sleeps**: use signals, channels, `require.Eventually`.

## Documentation of test strategy

Every phase doc has a "Testing" section specifying which tests are required to consider the phase done. This doc is the general reference; phase docs are the contract.
