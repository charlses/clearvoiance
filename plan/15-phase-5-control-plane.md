# Phase 5 — Control Plane API

**Duration:** 1 week.
**Goal:** Everything the CLI can do, the REST/WebSocket API can do. UI (Phase 6) is built against it. Third-party integrations (CI, Slackbots, etc.) use it.

## Deliverables

### REST API

`engine/internal/api/rest/`. OpenAPI 3.1 spec generated from code; Swagger UI at `/docs`.

#### Base

- Base URL: `http://engine:8080/api/v1` (port configurable).
- Auth: `Authorization: Bearer <api_key>`.
- Content type: `application/json`.
- Pagination: cursor-based. `?cursor=<opaque>&limit=<n>`.
- Error format:
  ```json
  {
    "error": {
      "code": "SESSION_NOT_FOUND",
      "message": "Session abc123 not found",
      "details": {}
    }
  }
  ```

#### Endpoints

**Sessions**

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/sessions` | Create a capture session |
| `GET` | `/sessions` | List sessions (filters: `status`, `label`, `created_after`) |
| `GET` | `/sessions/:id` | Session detail |
| `POST` | `/sessions/:id/stop` | Stop active capture |
| `DELETE` | `/sessions/:id` | Delete session + its events/blobs |
| `GET` | `/sessions/:id/events` | Paginated event browser with filters |
| `GET` | `/sessions/:id/stats` | Aggregates: event counts by type, top endpoints, etc. |
| `GET` | `/sessions/:id/export` | Download as portable bundle (tarball) |
| `POST` | `/sessions/import` | Upload a portable bundle |

**Replays**

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/replays` | Start a replay (body: source_session_id, target_url, speedup, auth, mutator) |
| `GET` | `/replays` | List replays |
| `GET` | `/replays/:id` | Replay detail + live status |
| `POST` | `/replays/:id/cancel` | Cancel running replay |
| `GET` | `/replays/:id/metrics` | Aggregate metrics |
| `GET` | `/replays/:id/events` | Per-event replay results |
| `GET` | `/replays/:id/db/top-slow-queries` | DB observer: slowest queries |
| `GET` | `/replays/:id/db/by-endpoint` | DB observer: DB time grouped by endpoint |
| `GET` | `/replays/:id/db/deadlocks` | DB observer: deadlocks |
| `GET` | `/replays/:id/db/explain/:fingerprint` | Full EXPLAIN plan |

**API keys**

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api-keys` | Create new API key (returns plaintext once) |
| `GET` | `/api-keys` | List keys (no plaintext) |
| `DELETE` | `/api-keys/:id` | Revoke |

**Config & health**

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/health` | Liveness |
| `GET` | `/ready` | Readiness (storage reachable) |
| `GET` | `/version` | Engine version + SDK compatibility range |
| `GET` | `/config` | Read-only config inspection |
| `GET` | `/metrics` | Prometheus metrics |

#### Example: Create replay

```http
POST /api/v1/replays
Authorization: Bearer <key>
Content-Type: application/json

{
  "source_session_id": "sess_abc",
  "target_url": "http://staging-strapi:1337",
  "speedup": 12.0,
  "virtual_users": 1,
  "auth_strategy": {
    "type": "jwt_resign",
    "signing_key_ref": "kms://staging-jwt-key"
  },
  "mutator": {
    "type": "unique_fields",
    "json_paths": ["$.email", "$.username"]
  },
  "db_observer": {
    "enabled": true,
    "postgres_dsn_ref": "secret://staging-pg-observer"
  }
}

→ 202 Accepted
{
  "id": "rep_xyz",
  "status": "pending",
  "estimated_duration_seconds": 300,
  "_links": {
    "self": "/api/v1/replays/rep_xyz",
    "metrics": "/api/v1/replays/rep_xyz/metrics",
    "ws": "ws://engine:8080/ws/replays/rep_xyz"
  }
}
```

### WebSocket API

`engine/internal/api/ws/`. For live views.

#### Topics

| Topic | Payload |
|---|---|
| `session.{id}.events` | Streams captured events in real-time (during active capture) |
| `session.{id}.stats` | Rolling stats updates every 1s |
| `replay.{id}.progress` | Replay progress updates every 250ms |
| `replay.{id}.events` | Per-event dispatch results |
| `replay.{id}.db` | DB observations as they're found |

#### Protocol

- Client connects to `ws://engine:8080/ws`.
- Authenticates with first message: `{"type": "auth", "api_key": "..."}`.
- Subscribes: `{"type": "subscribe", "topic": "session.abc.events"}`.
- Server streams: `{"type": "message", "topic": "...", "data": {...}}`.
- Unsubscribes: `{"type": "unsubscribe", "topic": "..."}`.
- Heartbeat: client sends `{"type": "ping"}` every 30s; server replies `pong`.

#### Backpressure

If consumer can't keep up, server drops messages on that topic (not the whole connection) and sends `{"type": "drop_notice", "topic": "...", "dropped_count": N}`.

### CLI uses REST API

Refactor CLI (Phase 1/2) to call REST endpoints instead of direct DB access. This gives us:

- Single API surface for humans, CLIs, CI, UI.
- Free auth enforcement.
- Remote CLI usage (`clearvoiance --engine=https://engine.example.com session list`).

### OpenAPI spec

Generated from Go code via `swaggo/swag` annotations:

```go
// @Summary Create a capture session
// @Description Starts a new capture session and returns the session ID + API key.
// @Tags sessions
// @Accept json
// @Produce json
// @Param body body CreateSessionRequest true "session config"
// @Success 201 {object} SessionResponse
// @Router /sessions [post]
func (h *SessionHandler) Create(w http.ResponseWriter, r *http.Request) { ... }
```

Serves OpenAPI at `/api/v1/openapi.json` and Swagger UI at `/docs`.

### SDK for the control plane (optional, Phase 6 consumer)

`@clearvoiance/api-client`:

- Typed TS client generated from OpenAPI spec (`openapi-typescript-codegen`).
- Consumed by UI and external integrations.

### Audit log

All write operations (create session, create replay, delete, etc.) insert into `audit_log`:

```sql
CREATE TABLE audit_log (
    id UUID PRIMARY KEY,
    ts TIMESTAMPTZ DEFAULT NOW(),
    api_key_id UUID,
    action TEXT,
    target_type TEXT,
    target_id TEXT,
    payload JSONB,
    source_ip INET
);
```

Queryable via `GET /api/v1/audit` (admin API keys only).

## Acceptance criteria

1. All Phase 1+2+4 functionality is accessible via REST.
2. `clearvoiance` CLI uses REST under the hood (same binary; REST mode and embedded mode both supported via a `--engine` flag).
3. WebSocket subscribers receive live events during an active capture with < 1s latency.
4. Auth: requests without or with invalid API key → 401; with revoked key → 401; with valid key → 200.
5. OpenAPI spec at `/api/v1/openapi.json` validates against spec.
6. Swagger UI at `/docs` is usable (try endpoints with auth).
7. Every write action produces an audit log entry.

## Non-goals

- Multi-tenant org model (single-tenant for v1).
- OAuth/SSO (proxy-able via Auth header; Phase 8 docs cover integration).
- Rate limiting per API key (basic global rate limit only in v1).

## Implementation order

1. `chi` router + auth middleware.
2. Session endpoints (CRUD + stop).
3. Replay endpoints.
4. DB observer endpoints.
5. API key endpoints.
6. OpenAPI annotations + generation.
7. WebSocket hub + topic routing.
8. WS subscriptions for session/replay events.
9. Refactor CLI to use REST.
10. Audit log.
11. Rate limiting (basic).
12. Integration tests.

## Testing

### Unit
- Auth middleware (valid/invalid/revoked).
- Error formatting.
- Cursor pagination.

### Integration
- Full endpoint coverage via supertest-style HTTP tests against compose-up engine.
- WebSocket: subscribe, receive events, unsubscribe.

### Contract tests
- OpenAPI spec validates against all implementations (spec must match handlers).

## Open questions

- **Body size limits:** `POST /sessions/import` may be large (GBs). Use streaming uploads. Document limits.
- **Long-running replays status:** a 5-minute replay at 12× of a 1-hour capture. Polling via REST or pushing via WS? Both; UI uses WS, CI polls REST.
- **Idempotency keys:** `POST /replays` is not idempotent. Support `Idempotency-Key` header for retry safety.
- **Admin vs. user keys:** simple role split: `admin` can manage API keys + delete sessions; `user` can capture/replay only. v1: single role. v2: split.

## Time budget

| Area | Estimate |
|---|---|
| Router + auth + error handling | 1 day |
| Session endpoints | 1 day |
| Replay endpoints | 1 day |
| DB observer endpoints | ½ day |
| API key mgmt + audit | 1 day |
| OpenAPI generation + Swagger | ½ day |
| WebSocket hub + topics | 1.5 days |
| CLI refactor to REST | 1 day |
| Tests + docs | 1 day |
| **Total** | **~7–8 days** |
