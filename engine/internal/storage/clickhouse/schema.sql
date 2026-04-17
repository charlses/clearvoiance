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
