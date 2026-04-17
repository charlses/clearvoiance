-- clearvoiance metadata schema (v1).
-- Applied idempotently on engine startup when --postgres-dsn is set.

CREATE TABLE IF NOT EXISTS sessions (
    id                 TEXT PRIMARY KEY,
    name               TEXT NOT NULL,
    labels             JSONB NOT NULL DEFAULT '{}'::jsonb,
    status             TEXT NOT NULL,
    started_at         TIMESTAMPTZ NOT NULL,
    stopped_at         TIMESTAMPTZ,
    events_captured    BIGINT NOT NULL DEFAULT 0,
    bytes_captured     BIGINT NOT NULL DEFAULT 0,
    last_heartbeat_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Idempotent add for upgrades.
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS last_heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE INDEX IF NOT EXISTS sessions_started_at_idx     ON sessions (started_at DESC);
CREATE INDEX IF NOT EXISTS sessions_status_idx         ON sessions (status);
CREATE INDEX IF NOT EXISTS sessions_last_heartbeat_idx ON sessions (last_heartbeat_at)
    WHERE status = 'active';

CREATE TABLE IF NOT EXISTS replays (
    id                     TEXT PRIMARY KEY,
    source_session_id      TEXT NOT NULL REFERENCES sessions(id),
    target_url             TEXT NOT NULL,
    speedup                DOUBLE PRECISION NOT NULL,
    label                  TEXT NOT NULL DEFAULT '',
    status                 TEXT NOT NULL,
    started_at             TIMESTAMPTZ NOT NULL,
    finished_at            TIMESTAMPTZ,
    events_dispatched      BIGINT NOT NULL DEFAULT 0,
    events_failed          BIGINT NOT NULL DEFAULT 0,
    events_backpressured   BIGINT NOT NULL DEFAULT 0,
    p50_latency_ms         DOUBLE PRECISION,
    p95_latency_ms         DOUBLE PRECISION,
    p99_latency_ms         DOUBLE PRECISION,
    max_lag_ms             DOUBLE PRECISION,
    error_message          TEXT,
    created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- Idempotent add for upgrades from older schemas.
ALTER TABLE replays ADD COLUMN IF NOT EXISTS events_backpressured BIGINT NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS replays_source_idx  ON replays (source_session_id);
CREATE INDEX IF NOT EXISTS replays_status_idx  ON replays (status);

CREATE TABLE IF NOT EXISTS api_keys (
    id           TEXT PRIMARY KEY,
    key_hash     TEXT NOT NULL UNIQUE,
    name         TEXT NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    revoked_at   TIMESTAMPTZ,
    last_used_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS api_keys_revoked_idx ON api_keys (revoked_at);
