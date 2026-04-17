# Phase 4 — DB Observer

**Duration:** 1 week.
**Goal:** During replay, observe the SUT's Postgres and surface which **replay events** caused which **DB performance problems** — slow queries, lock contention, deadlocks, long transactions. This is clearvoiance's killer feature vs. load testing tools.

## The correlation trick

Without correlation, the observer can tell you "query X was slow at time Y." With correlation, it can tell you "**replay event `POST /api/leads` caused query X to take 800ms and wait on a lock held by replay event `GET /api/leads/import`**."

The correlation mechanism:

1. SDK injects a Postgres `application_name` setting on every connection checkout: `SET application_name = 'clv:<event_id>'`.
2. Observer queries `pg_stat_activity` where `application_name LIKE 'clv:%'` and extracts the event_id.
3. Slow query logs and `auto_explain` output include `application_name`, so observations correlate cleanly.

Requires the SUT's Postgres driver to set `application_name` per query or per connection. `pg-node` supports both; document how to wire it up.

## Deliverables

### `db-observer/` (Go)

Standalone binary that can run embedded in the engine process or as a sidecar.

Starts when a replay starts, stops when it stops.

#### `internal/postgres/activity.go`

Polls `pg_stat_activity` every 100ms (configurable):

```sql
SELECT
  pid, application_name, state, query_start, state_change,
  wait_event_type, wait_event, query,
  (now() - query_start) AS query_duration,
  (now() - state_change) AS state_duration
FROM pg_stat_activity
WHERE application_name LIKE 'clv:%'
  AND state != 'idle';
```

For each row:
- Parse event_id out of `application_name`.
- If query_duration > `slow_query_threshold_ms` (default 100ms), emit `DbObservationEvent{type: SLOW_QUERY, ...}`.
- If `wait_event_type = 'Lock'`, emit `DbObservationEvent{type: LOCK_WAIT, ...}`.

Debounce: same (pid, query) over multiple polls is one observation with updated duration.

#### `internal/postgres/slowlog.go`

Tails Postgres server log via `log_min_duration_statement` output. Matches with event_id from application_name in log line.

Config:
```yaml
db_observer:
  postgres:
    log_tail_path: /var/log/postgresql/postgresql-15-main.log
    slow_query_threshold_ms: 100
```

Alt: use `pg_stat_statements` diff:
- Snapshot before replay.
- Snapshot after replay.
- Compute per-query deltas.
- Attribute to replay by looking at `application_name` in interleaved `pg_stat_activity` history.

Both methods complement each other; ship both, flag which is preferred.

#### `internal/postgres/locks.go`

On deadlock detection (from log tail or pg error), capture full `pg_locks` snapshot:

```sql
SELECT
  locktype, relation::regclass, mode, granted, pid,
  (SELECT application_name FROM pg_stat_activity WHERE pid = l.pid) AS app
FROM pg_locks l;
```

Build a lock graph: who holds, who waits, event_ids involved. Emit `DbObservationEvent{type: DEADLOCK, locks: [...]}`.

#### `internal/postgres/autoexplain.go`

Enables `auto_explain` extension at replay start:

```sql
LOAD 'auto_explain';
SET auto_explain.log_min_duration = 100;
SET auto_explain.log_analyze = true;
SET auto_explain.log_buffers = true;
SET auto_explain.log_format = 'json';
```

Parses JSON EXPLAIN plans out of the log tail, attaches to DbObservationEvents.

Disables after replay to avoid impacting normal operation.

#### `internal/correlator/`

Joins DB observations with replay events by event_id:

- In-memory cache of recent replay events keyed by event_id.
- On DB observation, look up the event, enrich with endpoint / path / user for display.
- Writes enriched events to ClickHouse `db_observations` table:

```sql
CREATE TABLE db_observations (
    observation_id UUID,
    replay_id UUID,
    event_id UUID,
    caused_by_path String,
    caused_by_method LowCardinality(String),
    observation_type LowCardinality(String),
    query_fingerprint String,
    query_text String CODEC(ZSTD(6)),
    duration_ns Int64,
    rows_affected Int64,
    explain_plan String CODEC(ZSTD(9)),
    lock_info String CODEC(ZSTD(6)),
    observed_at_ns Int64
) ENGINE = MergeTree()
PARTITION BY (replay_id)
ORDER BY (replay_id, event_id, observed_at_ns);
```

### SDK: `application_name` injection

`@clearvoiance/node/db/postgres`:

```ts
import { instrumentPg } from '@clearvoiance/node/db/postgres';

// For node-postgres
instrumentPg(pgPool, client);

// For Strapi (uses Knex)
instrumentKnex(strapi.db.connection, client);
```

Implementation:
- Wraps the pool's `connect()` (or query()) to run `SET application_name` with the current event_id from AsyncLocalStorage before the first user query on that connection.
- Restores on connection release.

Works for `pg`, `pg-pool`, `knex` (used by Strapi), `prisma`, `typeorm`.

### Aggregation queries for UI

`engine/internal/api/rest/db_observations.go`:

- `GET /replays/:id/db/top-slow-queries?limit=20`
- `GET /replays/:id/db/lock-contention-timeline`
- `GET /replays/:id/db/by-endpoint` → "which endpoints caused the most DB time"
- `GET /replays/:id/db/deadlocks`
- `GET /replays/:id/db/explain/:fingerprint`

These power the UI flame graph and lock timeline.

### Observer lifecycle

- Engine signals observer on replay start/stop via gRPC.
- Observer detects replay via signal OR via detecting `clv:*` application_names (for sidecar deployments).
- Observer self-halts after replay ends to avoid impacting SUT.

### Config

```yaml
db_observer:
  enabled: true
  postgres:
    dsn: "postgres://observer:pass@sut-db:5432/sut?sslmode=disable"
    # READ-ONLY user, only needs:
    #   - pg_stat_activity access (default role)
    #   - pg_locks access (default role)
    #   - log file read (if log tail enabled)
    poll_interval_ms: 100
    slow_query_threshold_ms: 100
    enable_auto_explain: true
    enable_log_tail: true
    log_tail_path: "/var/log/postgresql/postgresql.log"
  emit_to_clickhouse: true
  emit_to_prometheus: true
```

## Acceptance criteria

1. Capture a session against a Strapi app with a known N+1 query bug (e.g. `/api/leads` that does a per-row query).
2. Replay at 12×. DB observer emits slow query events for each N+1 batch, correctly attributed to `GET /api/leads`.
3. `clearvoiance replay results <id> --db` prints:
   - Top 10 endpoints by total DB time
   - Top 10 slowest queries with EXPLAIN plans
   - Any deadlocks with full lock graph
4. Accuracy ≥ 80%: of all slow queries captured by observer, ≥ 80% are attributed to the correct replay event.
5. Overhead on SUT Postgres: < 2% CPU increase (measured against baseline Postgres with no observer).
6. Observer does not require superuser on SUT DB — runs with default-role user + log file read.

## Non-goals

- MySQL observer (later).
- Mongo observer (later).
- Query plan regression detection across replays (Phase 9+).
- Auto-remediation suggestions (future AI integration).

## Implementation order

1. `application_name` SDK injection + tests.
2. `pg_stat_activity` poller + parser.
3. In-memory correlator.
4. ClickHouse `db_observations` table + writer.
5. E2E test: N+1 example app → replay → verify observations.
6. Slow log tail + parser.
7. `auto_explain` integration.
8. `pg_locks` snapshot on deadlock.
9. Aggregation queries + REST endpoints.
10. Docs for SUT DB setup (observer user, auto_explain install, log config).

## Testing

### Unit
- `application_name` parser.
- Lock graph builder.
- EXPLAIN plan JSON parsing.

### Integration
- Real Postgres via testcontainers with synthetic slow/locking queries.
- Deadlock scenario → deadlock observation emitted.

### E2E
- Strapi app with deliberate N+1, run through clearvoiance, assert observer surfaces it.

## Open questions

- **Log file access in managed Postgres (RDS, Cloud SQL):** log files are not directly readable. Fall back to `pg_stat_statements` diff mode. Document both paths.
- **Connection overhead of per-query `SET application_name`:** use session-level set on checkout, revert on release. Measure.
- **Observer sharing across concurrent replays:** if two replays run on the same SUT (shouldn't, but possible), observations can be cross-attributed. Guard with replay_id prefix in application_name: `clv:<replay_id>:<event_id>`.
- **PII in captured queries:** query text may contain PII in parameterized values. Options: (a) log only the fingerprint (no params) by default; (b) configurable. Decision: (a) by default, with opt-in for full queries.

## Time budget

| Area | Estimate |
|---|---|
| SDK application_name injection | 1 day |
| pg_stat_activity poller + correlator | 2 days |
| Slow log tail + auto_explain | 1 day |
| Lock snapshot + deadlock | 1 day |
| REST aggregation queries | 1 day |
| Docs + E2E | 1 day |
| **Total** | **~7 days** |
