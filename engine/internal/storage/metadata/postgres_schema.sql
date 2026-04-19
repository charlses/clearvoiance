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

-- Remote-controlled capture clients (the "agents waiting for orders"
-- model — see proto/clearvoiance/v1/control.proto). Each row is one
-- logical SDK client (e.g. "coldfire-strapi"); horizontal replicas
-- collapse into the same row but all their live gRPC streams are
-- tracked in memory by the engine process.
CREATE TABLE IF NOT EXISTS monitors (
    name              TEXT PRIMARY KEY,
    display_name      TEXT NOT NULL DEFAULT '',
    labels            JSONB NOT NULL DEFAULT '{}'::jsonb,
    capture_enabled   BOOLEAN NOT NULL DEFAULT FALSE,
    active_session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
    sdk_language      TEXT NOT NULL DEFAULT '',
    sdk_version       TEXT NOT NULL DEFAULT '',
    last_seen_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS monitors_last_seen_idx ON monitors (last_seen_at DESC);
CREATE INDEX IF NOT EXISTS monitors_capturing_idx ON monitors (capture_enabled)
    WHERE capture_enabled = TRUE;

-- Dashboard users. Passwords are argon2id-hashed (PHC string format). v1 is
-- single-admin: the first visit to /setup creates the sole user, after which
-- /setup refuses until the row is deleted. Email is case-insensitive, stored
-- lowercased.
CREATE TABLE IF NOT EXISTS users (
    id             TEXT PRIMARY KEY,
    email          TEXT NOT NULL UNIQUE,
    password_hash  TEXT NOT NULL,
    role           TEXT NOT NULL DEFAULT 'admin',
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_login_at  TIMESTAMPTZ
);

-- Dashboard login sessions. Tokens are opaque 32-byte randoms; only sha256
-- hashes land here (same one-way pattern as api_keys so a DB leak doesn't
-- grant login access). The cookie carries the plaintext.
CREATE TABLE IF NOT EXISTS user_sessions (
    id            TEXT PRIMARY KEY,
    user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash    TEXT NOT NULL UNIQUE,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at    TIMESTAMPTZ NOT NULL,
    last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    user_agent    TEXT NOT NULL DEFAULT '',
    ip            TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS user_sessions_user_idx    ON user_sessions (user_id);
CREATE INDEX IF NOT EXISTS user_sessions_expires_idx ON user_sessions (expires_at);

-- Audit log for every REST API write (POST/PUT/PATCH/DELETE). The middleware
-- in engine/internal/api/rest/audit.go inserts here after each 2xx/3xx
-- response. GETs are not audited. Payloads are redacted for secret-ish keys
-- (token/password/secret/api_key) before persistence.
--
-- The actor columns cover both auth paths: api_key_id is set on Bearer-authed
-- requests (SDK / programmatic), user_id on session-cookie requests
-- (dashboard). Exactly one is populated per row.
CREATE TABLE IF NOT EXISTS audit_log (
    id           UUID PRIMARY KEY,
    ts           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    api_key_id   TEXT NOT NULL,
    action       TEXT NOT NULL,
    target_type  TEXT NOT NULL,
    target_id    TEXT,
    payload      JSONB,
    source_ip    TEXT
);

-- Idempotent upgrades for audit_log: api_key_id becomes nullable so
-- session-authed writes can leave it blank, and user_id is added for the
-- dashboard actor.
ALTER TABLE audit_log ALTER COLUMN api_key_id DROP NOT NULL;
ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS user_id TEXT;

CREATE INDEX IF NOT EXISTS audit_log_ts_idx   ON audit_log (ts DESC);
CREATE INDEX IF NOT EXISTS audit_log_key_idx  ON audit_log (api_key_id, ts DESC);
CREATE INDEX IF NOT EXISTS audit_log_user_idx ON audit_log (user_id, ts DESC);
