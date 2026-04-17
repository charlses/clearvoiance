# 03 — Event Schema

Canonical event format. Every captured input to the SUT serializes to an `Event` protobuf message. Versioned under `/v1/`.

## Design principles

1. **One wire format for all protocols.** HTTP, sockets, crons, webhooks, queue messages → same `Event` envelope, differentiated by `oneof payload`.
2. **Forward-compatible.** New protocols add new `oneof` variants; old readers ignore unknown variants gracefully.
3. **Blob-friendly.** Large payloads use `body_ref` (S3 URL) instead of inline `bytes`.
4. **Trace-correlated.** Every event has an `event_id` that becomes a DB query tag during replay for observer correlation.

## Core schema (`proto/clearvoiance/v1/event.proto`)

```protobuf
syntax = "proto3";

package clearvoiance.v1;

import "google/protobuf/timestamp.proto";

// Event is the canonical capture record.
message Event {
  // Unique event identifier (UUID v7 — timestamp-ordered).
  string id = 1;

  // Session this event belongs to.
  string session_id = 2;

  // Nanoseconds since Unix epoch. Monotonic within a session.
  int64 timestamp_ns = 3;

  // Nanoseconds since session start. Used by replay scheduler.
  int64 offset_ns = 4;

  // Adapter that captured this event (e.g. "http.express", "socket.io", "cron.node-cron").
  string adapter = 5;

  // SDK version (e.g. "@clearvoiance/node@0.1.0").
  string sdk_version = 6;

  // Arbitrary metadata from enrichers (user_id, tenant_id, trace_id, etc.).
  map<string, string> metadata = 7;

  // Redaction applied to this event, if any (for audit).
  repeated string redactions_applied = 8;

  // Protocol-specific payload.
  oneof payload {
    HttpEvent http = 20;
    SocketEvent socket = 21;
    CronEvent cron = 22;
    WebhookEvent webhook = 23;
    QueueEvent queue = 24;
    OutboundEvent outbound = 25;
    DbObservationEvent db = 26;
  }
}

// HttpEvent captures an inbound HTTP request and its response.
message HttpEvent {
  string method = 1;              // GET, POST, etc.
  string path = 2;                // raw path including query string
  string http_version = 3;        // "HTTP/1.1"
  map<string, HeaderValues> headers = 4;
  Body request_body = 5;
  int32 status = 6;
  map<string, HeaderValues> response_headers = 7;
  Body response_body = 8;
  int64 duration_ns = 9;
  string source_ip = 10;
  string user_id = 11;            // extracted by configured extractor
  string route_template = 12;     // e.g. "/users/:id" — for aggregation
}

// SocketEvent captures a single WebSocket/Socket.io operation.
message SocketEvent {
  string socket_id = 1;           // stable per connection
  SocketOp op = 2;
  string namespace = 3;           // socket.io namespace, "/" if default
  string event_name = 4;          // event name for EMIT/RECV
  Body data = 5;
  map<string, string> handshake = 6;  // only set on CONNECT
  string user_id = 7;
  int64 duration_ns = 8;

  enum SocketOp {
    UNKNOWN = 0;
    CONNECT = 1;
    DISCONNECT = 2;
    EMIT_TO_CLIENT = 3;   // server → client
    RECV_FROM_CLIENT = 4; // client → server
    JOIN_ROOM = 5;
    LEAVE_ROOM = 6;
    ERROR = 7;
  }
}

// CronEvent captures a scheduled job invocation.
message CronEvent {
  string job_name = 1;
  string scheduler = 2;          // "node-cron", "agenda", "bullmq"
  Body args = 3;
  int64 duration_ns = 4;
  string status = 5;             // "success", "error"
  string error_message = 6;
  string trigger_source = 7;     // "schedule", "manual", "retry"
}

// WebhookEvent captures an inbound webhook (structurally similar to HTTP
// but separated for filtering/aggregation).
message WebhookEvent {
  string provider = 1;           // "stripe", "github", "telegram"
  string event_type = 2;         // provider-specific event type
  HttpEvent http = 3;
  string signature_header = 4;   // for verification during replay
}

// QueueEvent captures a consumed message from a queue.
message QueueEvent {
  string queue_name = 1;
  string broker = 2;             // "bullmq", "rabbitmq", "kafka"
  string message_id = 3;
  Body payload = 4;
  int32 retry_count = 5;
  int64 duration_ns = 6;
  string status = 7;
  map<string, string> headers = 8;
}

// OutboundEvent captures an outbound request FROM the SUT.
// Used during capture to record what the SUT did in response to inbound events,
// so replay can mock the external response.
message OutboundEvent {
  string target = 1;             // "telegram.api", "openai.api", "s3.aws"
  HttpEvent http = 2;
  string caused_by_event_id = 3; // inbound event that triggered this outbound
  bytes response_hash = 4;       // for dedup when same outbound repeats
}

// DbObservationEvent is emitted by the DB observer, not the SDK.
// Captures slow queries, lock waits, and explain plans during replay.
message DbObservationEvent {
  string query_fingerprint = 1;
  string query_text = 2;
  int64 duration_ns = 3;
  int64 rows_affected = 4;
  string application_name = 5;   // set by SDK to event_id for correlation
  string caused_by_event_id = 6;
  DbObservationType observation_type = 7;
  string explain_plan = 8;       // JSON
  repeated LockInfo locks = 9;

  enum DbObservationType {
    UNKNOWN = 0;
    SLOW_QUERY = 1;
    LOCK_WAIT = 2;
    DEADLOCK = 3;
    LONG_TRANSACTION = 4;
  }
}

message LockInfo {
  string relation = 1;
  string lock_mode = 2;
  int64 wait_duration_ns = 3;
  string granted = 4;
}

// Body represents a payload that may be inline or blob-ref'd.
message Body {
  oneof data {
    bytes inline = 1;             // for payloads ≤ 64KB
    BlobRef blob = 2;             // for larger payloads
  }
  string content_type = 3;
  int64 size_bytes = 4;
  string encoding = 5;            // "utf-8", "binary", "msgpack"
}

message BlobRef {
  string bucket = 1;
  string key = 2;
  string sha256 = 3;
}

message HeaderValues {
  repeated string values = 1;
}
```

## ClickHouse schema

Events are stored in ClickHouse with a flat representation. The protobuf is kept for wire transport, but the storage schema flattens hot fields for query speed:

```sql
-- engine/storage/clickhouse/schema.sql

CREATE TABLE IF NOT EXISTS events (
    -- Identity
    id              UUID,
    session_id      String,
    timestamp_ns    Int64,
    offset_ns       Int64,
    adapter         LowCardinality(String),
    sdk_version     LowCardinality(String),
    event_type      LowCardinality(String),  -- 'http', 'socket', 'cron', ...

    -- Common
    user_id         String,
    metadata        Map(String, String),
    redactions      Array(String),

    -- HTTP/webhook hot fields
    http_method     LowCardinality(String),
    http_path       String,
    http_route      String,
    http_status     UInt16,
    duration_ns     Int64,
    source_ip       IPv6,

    -- Socket
    socket_id       String,
    socket_op       LowCardinality(String),
    socket_event    String,

    -- Cron
    cron_job        LowCardinality(String),
    cron_status     LowCardinality(String),

    -- Payload (inline OR blob_ref)
    body_inline     Nullable(String) CODEC(ZSTD(6)),
    body_ref        Nullable(String),  -- bucket/key
    body_size       Int64,

    -- Raw protobuf for completeness (compressed)
    raw_pb          String CODEC(ZSTD(9))
)
ENGINE = MergeTree()
PARTITION BY (session_id, toStartOfHour(fromUnixTimestamp64Nano(timestamp_ns)))
ORDER BY (session_id, timestamp_ns, id)
TTL toDateTime(fromUnixTimestamp64Nano(timestamp_ns)) + INTERVAL 30 DAY
SETTINGS index_granularity = 8192;
```

Rationale:

- `PARTITION BY session_id + hour` → replay reads a session hit a small set of partitions.
- `ORDER BY timestamp_ns` → replay scan is a single ordered read, no sort.
- `TTL 30 DAYS` default (configurable) — captures are data-heavy; retention is a policy decision per org.
- `raw_pb` stores the full protobuf for any field we didn't flatten, ensuring no data loss.

## Versioning rules

- `proto/clearvoiance/v1/` is frozen once Phase 1 ships. Breaking changes → `v2/`.
- New adapters add new `oneof` variants in `v1`. Readers use the `adapter` string to dispatch if the `oneof` tag is unknown.
- ClickHouse schema changes use forward-compatible migrations (new nullable columns, never dropped columns within `v1`).

## Redaction semantics

Redaction happens **before** the event enters transport. An event that reaches storage has already been redacted. The `redactions_applied` field records *what was redacted* without revealing the value.

Example:

```json
{
  "redactions_applied": [
    "header:authorization",
    "body.$.password",
    "body.$.creditCard",
    "header:cookie"
  ]
}
```

This gives auditability without leaking secrets.

## Size estimates

At the target scale (10K rps for 1h):

- Avg event size (inline body): 500 bytes
- Avg event size (blob-ref body): 300 bytes + ~200KB blob
- 10% of events have blob-ref bodies
- 36M events → ~18GB in ClickHouse (pre-compression) → ~4GB compressed with ZSTD
- 3.6M blobs → ~720GB in MinIO

A single ClickHouse node handles this. MinIO needs multi-node for anything over a few days of retention at this rate.
