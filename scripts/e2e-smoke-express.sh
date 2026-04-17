#!/usr/bin/env bash
# End-to-end capture smoke via the Express adapter.
#
# Boots ClickHouse + engine, starts examples/express-basic, hits it with curl,
# verifies the resulting rows landed in ClickHouse with the right method/path.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

ENGINE_BIN="$ROOT/bin/clearvoiance"
ENGINE_ADDR="127.0.0.1:9100"
APP_PORT="4000"
CH_CONTAINER="clearvoiance-smoke-ch-express"
CH_HTTP_URL="http://127.0.0.1:18123"
CH_DSN="clickhouse://default:dev@127.0.0.1:19000/clearvoiance"
ENGINE_LOG="$(mktemp)"
APP_LOG="$(mktemp)"
ENGINE_PID_FILE="$(mktemp)"
APP_PID_FILE="$(mktemp)"

cleanup() {
  for pidfile in "$ENGINE_PID_FILE" "$APP_PID_FILE"; do
    if [[ -s "$pidfile" ]]; then
      local pid
      pid=$(cat "$pidfile")
      if kill -0 "$pid" 2>/dev/null; then
        kill "$pid" 2>/dev/null || true
        wait "$pid" 2>/dev/null || true
      fi
    fi
  done
  rm -f "$ENGINE_PID_FILE" "$APP_PID_FILE"
  docker rm -f "$CH_CONTAINER" >/dev/null 2>&1 || true
  if [[ "${KEEP_LOG:-}" == "" ]]; then
    rm -f "$ENGINE_LOG" "$APP_LOG"
  else
    echo "engine log: $ENGINE_LOG"
    echo "app log:    $APP_LOG"
  fi
}
trap cleanup EXIT

echo "→ starting ClickHouse ($CH_CONTAINER)"
docker rm -f "$CH_CONTAINER" >/dev/null 2>&1 || true
docker run -d --rm --name "$CH_CONTAINER" \
  -p 127.0.0.1:18123:8123 \
  -p 127.0.0.1:19000:9000 \
  -e CLICKHOUSE_USER=default \
  -e CLICKHOUSE_PASSWORD=dev \
  -e CLICKHOUSE_DB=clearvoiance \
  clickhouse/clickhouse-server:24-alpine >/dev/null

echo "→ waiting for ClickHouse"
for _ in $(seq 1 60); do
  if curl -fs -u default:dev "$CH_HTTP_URL/ping" >/dev/null 2>&1; then break; fi
  sleep 1
done
curl -fs -u default:dev "$CH_HTTP_URL/ping" >/dev/null || {
  echo "✗ ClickHouse did not become ready"; exit 1;
}

echo "→ building engine"
go build -o "$ENGINE_BIN" ./engine/cmd/clearvoiance

echo "→ starting engine"
"$ENGINE_BIN" serve --grpc-addr "$ENGINE_ADDR" --clickhouse-dsn "$CH_DSN" >"$ENGINE_LOG" 2>&1 &
echo $! >"$ENGINE_PID_FILE"

for _ in $(seq 1 50); do
  if ss -tln 2>/dev/null | grep -q "$ENGINE_ADDR"; then break; fi
  sleep 0.1
done
ss -tln 2>/dev/null | grep -q "$ENGINE_ADDR" || {
  echo "✗ engine failed to bind $ENGINE_ADDR"; cat "$ENGINE_LOG"; exit 1;
}

echo "→ building SDK (workspace dist required by example)"
pnpm --filter @clearvoiance/node build >/dev/null

echo "→ starting express-basic on :$APP_PORT"
CLEARVOIANCE_ENGINE_URL="$ENGINE_ADDR" \
CLEARVOIANCE_API_KEY="dev" \
CLEARVOIANCE_SESSION_NAME="express-smoke" \
PORT="$APP_PORT" \
  pnpm --filter @clearvoiance/example-express-basic exec \
    tsx src/server.ts >"$APP_LOG" 2>&1 &
echo $! >"$APP_PID_FILE"

for _ in $(seq 1 50); do
  if ss -tln 2>/dev/null | grep -q ":$APP_PORT"; then break; fi
  sleep 0.1
done
ss -tln 2>/dev/null | grep -q ":$APP_PORT" || {
  echo "✗ example failed to bind :$APP_PORT"; cat "$APP_LOG"; exit 1;
}

echo "→ generating traffic"
curl -fs "http://127.0.0.1:$APP_PORT/health" >/dev/null
curl -fs "http://127.0.0.1:$APP_PORT/users/42" >/dev/null
curl -fs -X POST "http://127.0.0.1:$APP_PORT/echo" \
  -H 'content-type: application/json' \
  -d '{"hello":"smoke"}' >/dev/null

echo "→ stopping example (flushes session)"
kill "$(cat "$APP_PID_FILE")" 2>/dev/null || true
for _ in $(seq 1 50); do
  if ! kill -0 "$(cat "$APP_PID_FILE")" 2>/dev/null; then break; fi
  sleep 0.1
done
: >"$APP_PID_FILE"

echo "→ verifying rows in ClickHouse"
# Express adapter writes method+path for every request. We expect at least 3.
count=$(curl -fs -u default:dev --get "$CH_HTTP_URL/" \
  --data-urlencode "database=clearvoiance" \
  --data-urlencode "query=SELECT count() FROM events WHERE adapter = 'http.express'" \
  | tr -d '[:space:]')

if [[ "$count" -lt 3 ]]; then
  echo "✗ expected ≥3 http.express events, got '$count'"
  echo "---app log---"; tail -20 "$APP_LOG"
  echo "---engine log---"; tail -20 "$ENGINE_LOG"
  exit 1
fi
echo "✓ ClickHouse reports $count http.express events"

echo "→ sample rows:"
curl -fs -u default:dev --get "$CH_HTTP_URL/" \
  --data-urlencode "database=clearvoiance" \
  --data-urlencode "query=SELECT http_method, http_path, http_status, http_route
                          FROM events WHERE adapter = 'http.express'
                          ORDER BY timestamp_ns FORMAT TSV"

echo "→ engine log tail:"
tail -15 "$ENGINE_LOG"
