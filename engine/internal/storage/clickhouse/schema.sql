-- clearvoiance event storage schema (v1).
--
-- Single flat events table; hot fields promoted out of the protobuf for fast
-- range scans during replay. raw_pb preserves the full Event message so nothing
-- we don't flatten is lost.
--
-- Partitioning by (session_id, hour) means a replay scan for one session reads
-- a handful of partitions. ORDER BY timestamp_ns lets replay do a single
-- ordered read — no sort required.

CREATE TABLE IF NOT EXISTS events (
    id              String,
    session_id      String,
    timestamp_ns    Int64,
    offset_ns       Int64,
    adapter         LowCardinality(String),
    sdk_version     LowCardinality(String),
    event_type      LowCardinality(String),

    user_id         String,
    metadata        Map(String, String),
    redactions      Array(String),

    -- HTTP / webhook hot fields
    http_method     LowCardinality(String),
    http_path       String,
    http_route      String,
    http_status     UInt16,
    duration_ns     Int64,
    source_ip       String,

    -- Socket
    socket_id       String,
    socket_op       LowCardinality(String),
    socket_event    String,

    -- Cron
    cron_job        LowCardinality(String),
    cron_status     LowCardinality(String),

    -- Body summary (full content lives in raw_pb or, when large, in blob storage)
    body_size       Int64,

    -- Full Event protobuf, zstd-compressed.
    raw_pb          String CODEC(ZSTD(9))
)
ENGINE = MergeTree()
PARTITION BY (session_id, toStartOfHour(fromUnixTimestamp64Nano(timestamp_ns)))
ORDER BY (session_id, timestamp_ns, id)
SETTINGS index_granularity = 8192;

-- Slow-query / lock-wait observations emitted by the db-observer. Either
-- the observer creates this table at start-up (sidecar mode) or the engine
-- creates it here (embedded mode). Both DDLs are idempotent.
CREATE TABLE IF NOT EXISTS db_observations (
    observation_id    String,
    replay_id         String,
    event_id          String,
    observation_type  LowCardinality(String),
    observed_at_ns    Int64,
    duration_ns       Int64,
    query_text        String CODEC(ZSTD(6)),
    query_fingerprint String,
    wait_event_type   LowCardinality(String),
    wait_event        String
) ENGINE = MergeTree()
PARTITION BY (replay_id)
ORDER BY (replay_id, event_id, observed_at_ns)
SETTINGS index_granularity = 8192;

-- Per-event replay results. Written by the replay engine for every dispatched
-- event so operators can slice latency/lag by endpoint, status, etc.
CREATE TABLE IF NOT EXISTS replay_events (
    replay_id            String,
    event_id             String,
    scheduled_fire_ns    Int64,
    actual_fire_ns       Int64,
    lag_ns               Int64,
    response_status      UInt16,
    response_duration_ns Int64,
    error_code           LowCardinality(String),
    error_message        String CODEC(ZSTD(6)),
    bytes_sent           UInt32,
    bytes_received       UInt32,

    -- Useful slicing dims copied from the source event at dispatch time.
    http_method          LowCardinality(String),
    http_path            String,
    http_route           String
)
ENGINE = MergeTree()
PARTITION BY replay_id
ORDER BY (replay_id, scheduled_fire_ns, event_id)
SETTINGS index_granularity = 8192;
