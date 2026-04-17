#!/usr/bin/env bash
# End-to-end replay smoke (Phase 2a).
#
# Flow:
#   1. Boot ClickHouse + Postgres + engine
#   2. Start examples/express-basic — generate 3 small captures
#   3. Stop the example (session closes)
#   4. Start a tiny tracking target HTTP server on a different port
#   5. `clearvoiance replay start --source=<id> --target=http://localhost:TARGET --speedup=10`
#   6. Poll replay status until completed
#   7. Verify the target actually received the 3 requests (file-log count)
#   8. Verify ClickHouse replay_events rows exist with scheduled/actual/lag columns
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

ENGINE_BIN="$ROOT/bin/clearvoiance"
ENGINE_ADDR="127.0.0.1:9100"
APP_PORT="4400"
TARGET_PORT="4401"
CH_CONTAINER="clearvoiance-smoke-ch-replay"
CH_HTTP_URL="http://127.0.0.1:18123"
CH_DSN="clickhouse://default:dev@127.0.0.1:19000/clearvoiance"
PG_CONTAINER="clearvoiance-smoke-pg-replay"
PG_DSN="postgres://clv:clv@127.0.0.1:15432/clv?sslmode=disable"
ENGINE_LOG="$(mktemp)"
APP_LOG="$(mktemp)"
TARGET_LOG="$(mktemp)"
ENGINE_PID_FILE="$(mktemp)"
APP_PID_FILE="$(mktemp)"
TARGET_PID_FILE="$(mktemp)"

cleanup() {
  for pidfile in "$ENGINE_PID_FILE" "$APP_PID_FILE" "$TARGET_PID_FILE"; do
    if [[ -s "$pidfile" ]]; then
      local pid
      pid=$(cat "$pidfile")
      if kill -0 "$pid" 2>/dev/null; then
        kill "$pid" 2>/dev/null || true
        wait "$pid" 2>/dev/null || true
      fi
    fi
  done
  rm -f "$ENGINE_PID_FILE" "$APP_PID_FILE" "$TARGET_PID_FILE"
  docker rm -f "$CH_CONTAINER" "$PG_CONTAINER" >/dev/null 2>&1 || true
  if [[ "${KEEP_LOG:-}" == "" ]]; then
    rm -f "$ENGINE_LOG" "$APP_LOG" "$TARGET_LOG"
  else
    echo "engine log: $ENGINE_LOG"
    echo "app log:    $APP_LOG"
    echo "target log: $TARGET_LOG"
  fi
}
trap cleanup EXIT

echo "→ starting ClickHouse + Postgres"
docker rm -f "$CH_CONTAINER" "$PG_CONTAINER" >/dev/null 2>&1 || true
docker run -d --rm --name "$CH_CONTAINER" \
  -p 127.0.0.1:18123:8123 -p 127.0.0.1:19000:9000 \
  -e CLICKHOUSE_USER=default -e CLICKHOUSE_PASSWORD=dev -e CLICKHOUSE_DB=clearvoiance \
  clickhouse/clickhouse-server:24-alpine >/dev/null
docker run -d --rm --name "$PG_CONTAINER" \
  -p 127.0.0.1:15432:5432 \
  -e POSTGRES_USER=clv -e POSTGRES_PASSWORD=clv -e POSTGRES_DB=clv \
  postgres:16-alpine >/dev/null

echo "→ waiting for ClickHouse + Postgres"
ready=0
for _ in $(seq 1 60); do
  if curl -fs -u default:dev "$CH_HTTP_URL/ping" >/dev/null 2>&1 \
     && docker exec "$PG_CONTAINER" pg_isready -U clv -d clv >/dev/null 2>&1; then
    ready=1; break
  fi
  sleep 1
done
if [[ "$ready" -ne 1 ]]; then
  echo "✗ ClickHouse + Postgres did not become ready in 60s"
  exit 1
fi

echo "→ building engine"
go build -o "$ENGINE_BIN" ./engine/cmd/clearvoiance

echo "→ starting engine"
"$ENGINE_BIN" serve \
  --grpc-addr "$ENGINE_ADDR" \
  --clickhouse-dsn "$CH_DSN" \
  --postgres-dsn "$PG_DSN" \
  >"$ENGINE_LOG" 2>&1 &
echo $! >"$ENGINE_PID_FILE"
for _ in $(seq 1 50); do
  if ss -tln 2>/dev/null | grep -q "$ENGINE_ADDR"; then break; fi
  sleep 0.1
done

echo "→ building SDK"
pnpm --filter @clearvoiance/node build >/dev/null

echo "→ starting express-basic (capture side)"
CLEARVOIANCE_ENGINE_URL="$ENGINE_ADDR" \
CLEARVOIANCE_API_KEY="dev" \
CLEARVOIANCE_SESSION_NAME="replay-source" \
PORT="$APP_PORT" \
  pnpm --filter @clearvoiance/example-express-basic exec \
    tsx src/server.ts >"$APP_LOG" 2>&1 &
echo $! >"$APP_PID_FILE"
for _ in $(seq 1 50); do
  if ss -tln 2>/dev/null | grep -q ":$APP_PORT"; then break; fi
  sleep 0.1
done

echo "→ generating 3 captured requests"
curl -fs "http://127.0.0.1:$APP_PORT/health" >/dev/null
curl -fs "http://127.0.0.1:$APP_PORT/users/42" >/dev/null
curl -fs -X POST "http://127.0.0.1:$APP_PORT/echo" \
  -H 'content-type: application/json' \
  -d '{"hello":"replay"}' >/dev/null
sleep 1

echo "→ stopping capture-side example (closes session)"
kill "$(cat "$APP_PID_FILE")" 2>/dev/null || true
for _ in $(seq 1 50); do
  if ! kill -0 "$(cat "$APP_PID_FILE")" 2>/dev/null; then break; fi
  sleep 0.1
done
: >"$APP_PID_FILE"

echo "→ fetching session id from Postgres"
SESSION_ID=$(docker exec "$PG_CONTAINER" psql -U clv -d clv -t -A \
  -c "SELECT id FROM sessions WHERE name = 'replay-source' ORDER BY started_at DESC LIMIT 1" \
  | tr -d '[:space:]')
if [[ -z "$SESSION_ID" ]]; then
  echo "✗ no session found in Postgres"
  tail -20 "$ENGINE_LOG"
  exit 1
fi
echo "  session = $SESSION_ID"

echo "→ starting tracking target on :$TARGET_PORT"
node -e "
const http = require('http');
const fs = require('fs');
const log = fs.createWriteStream('$TARGET_LOG', { flags: 'a' });
http.createServer((req, res) => {
  log.write(req.method + ' ' + req.url + '\n');
  res.writeHead(200, {'content-type': 'application/json'});
  res.end(JSON.stringify({ok: true}));
}).listen($TARGET_PORT, '127.0.0.1');
" &
echo $! >"$TARGET_PID_FILE"
for _ in $(seq 1 50); do
  if ss -tln 2>/dev/null | grep -q ":$TARGET_PORT"; then break; fi
  sleep 0.1
done
ss -tln 2>/dev/null | grep -q ":$TARGET_PORT" || {
  echo "✗ target failed to bind :$TARGET_PORT"; exit 1;
}

echo "→ kicking off replay at 10x"
REPLAY_ID=$("$ENGINE_BIN" replay start \
  --source="$SESSION_ID" \
  --target="http://127.0.0.1:$TARGET_PORT" \
  --speedup=10 \
  --engine "$ENGINE_ADDR")
REPLAY_ID=$(echo "$REPLAY_ID" | tr -d '[:space:]')
if [[ -z "$REPLAY_ID" ]]; then
  echo "✗ replay start returned no id"
  tail -30 "$ENGINE_LOG"
  exit 1
fi
echo "  replay = $REPLAY_ID"

echo "→ polling for replay completion"
status=""
for i in $(seq 1 60); do
  status=$("$ENGINE_BIN" replay status "$REPLAY_ID" --engine "$ENGINE_ADDR" 2>/dev/null \
    | python3 -c 'import sys,json; print(json.load(sys.stdin)["status"])' 2>/dev/null || echo "pending")
  if [[ "$status" == "completed" || "$status" == "failed" ]]; then
    break
  fi
  sleep 0.5
done
if [[ "$status" != "completed" ]]; then
  echo "✗ replay status=$status after ${i} polls"
  "$ENGINE_BIN" replay status "$REPLAY_ID" --engine "$ENGINE_ADDR"
  tail -40 "$ENGINE_LOG"
  exit 1
fi
echo "✓ replay completed"

echo "→ verifying target received requests"
target_count=$(wc -l < "$TARGET_LOG" | tr -d '[:space:]')
if [[ "$target_count" -lt 3 ]]; then
  echo "✗ expected ≥3 requests at target, got '$target_count'"
  cat "$TARGET_LOG"
  exit 1
fi
echo "✓ target received $target_count request(s):"
cat "$TARGET_LOG"

echo "→ verifying replay_events rows"
sleep 1  # let the final batch flush
ch_count=$(curl -fs -u default:dev --get "$CH_HTTP_URL/" \
  --data-urlencode "database=clearvoiance" \
  --data-urlencode "query=SELECT count() FROM replay_events WHERE replay_id = '$REPLAY_ID'" \
  | tr -d '[:space:]')
if [[ "$ch_count" -lt 3 ]]; then
  echo "✗ expected ≥3 replay_events rows, got '$ch_count'"
  exit 1
fi
echo "✓ replay_events has $ch_count rows"

echo "→ sample rows:"
curl -fs -u default:dev --get "$CH_HTTP_URL/" \
  --data-urlencode "database=clearvoiance" \
  --data-urlencode "query=SELECT http_method, http_path, response_status,
                                 round(response_duration_ns / 1e6, 2) AS duration_ms,
                                 round(lag_ns / 1e6, 2) AS lag_ms
                          FROM replay_events WHERE replay_id = '$REPLAY_ID'
                          ORDER BY scheduled_fire_ns FORMAT TSV"

echo "→ engine log tail:"
tail -15 "$ENGINE_LOG"
