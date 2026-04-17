-- clearvoiance metadata schema (v1).
-- Applied idempotently on engine startup when --postgres-dsn is set.

CREATE TABLE IF NOT EXISTS sessions (
    id               TEXT PRIMARY KEY,
    name             TEXT NOT NULL,
    labels           JSONB NOT NULL DEFAULT '{}'::jsonb,
    status           TEXT NOT NULL,
    started_at       TIMESTAMPTZ NOT NULL,
    stopped_at       TIMESTAMPTZ,
    events_captured  BIGINT NOT NULL DEFAULT 0,
    bytes_captured   BIGINT NOT NULL DEFAULT 0,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS sessions_started_at_idx ON sessions (started_at DESC);
CREATE INDEX IF NOT EXISTS sessions_status_idx     ON sessions (status);
