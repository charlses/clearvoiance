# 04 — Protocol Spec (SDK ↔ Engine)

Wire protocol between SDK clients (Node first, others later) and the engine. Versioned, binary, streaming.

## Transport

- **gRPC over HTTP/2** with optional TLS.
- Default port: `9000` (configurable via `CLEARVOIANCE_GRPC_PORT`).
- `grpc-go` (engine) and `@grpc/grpc-js` (Node SDK) — no native deps on either side.

## Service definition

`proto/clearvoiance/v1/capture.proto`:

```protobuf
syntax = "proto3";

package clearvoiance.v1;

import "clearvoiance/v1/event.proto";

service Capture {
  // Client-streaming: SDK sends a stream of events, engine ACKs in batches.
  rpc StreamEvents(stream StreamEventsRequest) returns (stream StreamEventsResponse);

  // Unary: request a presigned URL to upload a large blob directly.
  rpc GetBlobUploadURL(GetBlobUploadURLRequest) returns (GetBlobUploadURLResponse);

  // Unary: session lifecycle.
  rpc StartSession(StartSessionRequest) returns (StartSessionResponse);
  rpc StopSession(StopSessionRequest) returns (StopSessionResponse);
  rpc Heartbeat(HeartbeatRequest) returns (HeartbeatResponse);
}

message StreamEventsRequest {
  oneof msg {
    Handshake handshake = 1;     // first message in stream
    EventBatch batch = 2;         // zero or more events
    FlushRequest flush = 3;       // request ack of pending events
  }
}

message Handshake {
  string session_id = 1;
  string sdk_version = 2;
  string api_key = 3;              // authentication
  map<string, string> client_metadata = 4;
}

message EventBatch {
  repeated Event events = 1;
  int64 batch_id = 2;              // client-assigned monotonic
}

message FlushRequest {
  int64 up_to_batch_id = 1;
}

message StreamEventsResponse {
  oneof msg {
    HandshakeAck ack = 1;
    BatchAck batch_ack = 2;
    BackpressureNotice backpressure = 3;
    FatalError error = 4;
  }
}

message HandshakeAck {
  string server_version = 1;
  int32 max_batch_size = 2;
  int32 max_events_per_second = 3;
  int64 recommended_flush_interval_ms = 4;
}

message BatchAck {
  int64 batch_id = 1;
  int32 events_persisted = 2;
  int32 events_rejected = 3;
  repeated string rejection_reasons = 4;
}

message BackpressureNotice {
  int32 slowdown_factor_percent = 1;  // 0=no slowdown, 100=stop
  string reason = 2;
}

message FatalError {
  string code = 1;
  string message = 2;
}

message GetBlobUploadURLRequest {
  string session_id = 1;
  string sha256 = 2;
  int64 size_bytes = 3;
  string content_type = 4;
}

message GetBlobUploadURLResponse {
  string upload_url = 1;
  string bucket = 2;
  string key = 3;
  map<string, string> required_headers = 4;
  int64 expires_at_ns = 5;
}

message StartSessionRequest {
  string name = 1;
  string api_key = 2;
  map<string, string> labels = 3;
  SessionConfig config = 4;
}

message SessionConfig {
  repeated string captured_event_types = 1;  // e.g. ["http", "socket", "cron"]
  RedactionConfig redaction = 2;
  int64 max_body_inline_bytes = 3;           // default 64KB
  double sample_rate = 4;                    // 0.0–1.0, default 1.0
}

message RedactionConfig {
  repeated string denied_headers = 1;        // lowercased names
  repeated string denied_jsonpaths = 2;      // e.g. "$.password"
  bool redact_authorization = 3;             // shortcut
  bool redact_cookies = 4;
}

message StartSessionResponse {
  string session_id = 1;
  int64 started_at_ns = 2;
}

message StopSessionRequest {
  string session_id = 1;
  string api_key = 2;
}

message StopSessionResponse {
  int64 stopped_at_ns = 1;
  int64 events_captured = 2;
  int64 bytes_captured = 3;
}

message HeartbeatRequest {
  string session_id = 1;
  string api_key = 2;
  ClientHealth health = 2;
}

message ClientHealth {
  int64 events_buffered = 1;
  int64 events_dropped = 2;
  int64 bytes_buffered = 3;
  double cpu_percent = 4;
  int64 memory_bytes = 5;
}

message HeartbeatResponse {
  bool session_active = 1;
  BackpressureNotice backpressure = 2;
}
```

## Authentication

- `api_key` in handshake and on every non-streaming RPC.
- Server verifies against Postgres `api_keys` table.
- Keys are hashed (bcrypt) at rest.
- Rotation: multiple active keys per session allowed; revoke by key id.

## Batching & backpressure

### SDK side

1. Events are enqueued on an in-memory ring buffer (default 10k events).
2. Background flusher sends a batch when:
   - Buffer reaches `max_batch_size` (from HandshakeAck, default 100)
   - `recommended_flush_interval_ms` elapses since last send (default 100ms)
   - Client is explicitly flushed via `client.flush()`
3. Each batch gets a monotonically increasing `batch_id`.

### Engine side

1. Engine processes events, writes to ClickHouse (buffered inserts).
2. Responds with `BatchAck { events_persisted, events_rejected }`.
3. If ingest queue depth > threshold, sends `BackpressureNotice { slowdown_factor_percent }` — SDK slows flush accordingly (sleep proportional to factor).

### SDK behavior under pressure

| Condition | Behavior |
|---|---|
| Engine unreachable | Write batches to local WAL file. Retry with exponential backoff. |
| Engine returns backpressure | Sleep per factor. Continue buffering. |
| Local buffer > 80% full | Start sampling at 50%, log warning. |
| Local buffer full | Drop events. Increment `events_dropped`. Log error every 10s. |

**Never** drop events silently — always count and report via `ClientHealth`.

## Large blob upload flow

For bodies > `max_body_inline_bytes`:

1. SDK computes sha256 of body.
2. SDK calls `GetBlobUploadURL` with sha256 and size.
3. Engine returns presigned PUT URL on MinIO/S3 (10 minute expiry).
4. SDK PUTs the body directly to blob storage.
5. SDK includes `BlobRef{bucket, key, sha256}` in the Event instead of inline bytes.

Dedup: if engine detects the sha256 already exists in the session's blob index, it can return an "already exists" marker and SDK skips the upload.

## WAL format (SDK local)

When engine is unreachable, SDK persists batches to disk:

```
/var/lib/clearvoiance/wal/{session_id}/{batch_id}.pb
```

- Each file is a length-prefixed `EventBatch` protobuf.
- File is fsync'd on write.
- Background task drains oldest files first when connection restores.
- TTL: 7 days; older files purged.

## Connection lifecycle

```
SDK                           Engine
 |                              |
 |--(1)---- StartSession ------>|
 |<---(2)-- StartSessionResp ---|
 |                              |
 |--(3)--- StreamEvents open -->|
 |--(3a)-- Handshake --------->|
 |<--(3b)- HandshakeAck -------|
 |                              |
 |--(4)--- EventBatch 1 ------>|
 |<--(5)-- BatchAck 1 ---------|
 |--(4)--- EventBatch 2 ------>|
 |<--(5)-- BatchAck 2 ---------|
 |  ... (heartbeats every 30s)  |
 |                              |
 |--(6)---- StopSession ------>|
 |<---(7)-- StopSessionResp ---|
```

## Versioning

- Protocol version pinned in Handshake `sdk_version`.
- Engine supports N and N-1 SDK versions simultaneously.
- Deprecation notice: 6 months before removing N-2 support.

## Error codes

| Code | Meaning | SDK action |
|---|---|---|
| `AUTH_FAILED` | Invalid API key | Stop, surface to user |
| `SESSION_NOT_FOUND` | Handshake session_id not started | Stop, surface to user |
| `SESSION_CLOSED` | Session was stopped remotely | Drain buffer, stop |
| `RATE_LIMITED` | Engine rate limit hit | Respect backpressure, retry |
| `INTERNAL` | Engine bug | Log, retry with backoff |
| `VERSION_UNSUPPORTED` | SDK too old or too new | Stop, log upgrade instructions |

## TLS

- Production deployments should use TLS. Engine accepts `--tls-cert` and `--tls-key` flags.
- Self-host compose default: no TLS, bind to localhost only.
- SDK verifies cert by default; `insecure: true` option for dev.
