#!/usr/bin/env bash
# End-to-end durability smoke: WAL drains across an engine restart.
#
# Flow:
#   1. Boot ClickHouse + Postgres + engine
#   2. Start examples/express-basic with a fixed WAL dir
#   3. Hit /health once — should land in ClickHouse (online path)
#   4. Kill engine
#   5. Hit /users/1 and /users/2 — should write to WAL
#   6. Restart engine (same Postgres — session row persists)
#   7. Wait for SDK to reconnect + drain WAL
#   8. Assert ClickHouse has all 3 requests
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

ENGINE_BIN="$ROOT/bin/clearvoiance"
ENGINE_ADDR="127.0.0.1:9100"
APP_PORT="4300"
CH_CONTAINER="clearvoiance-smoke-ch-walr"
CH_HTTP_URL="http://127.0.0.1:18123"
CH_DSN="clickhouse://default:dev@127.0.0.1:19000/clearvoiance"
PG_CONTAINER="clearvoiance-smoke-pg-walr"
PG_DSN="postgres://clv:clv@127.0.0.1:15432/clv?sslmode=disable"
WAL_DIR="$(mktemp -d -t clearvoiance-wal-restart-XXXXXX)"
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
  docker rm -f "$PG_CONTAINER" >/dev/null 2>&1 || true
  if [[ "${KEEP_LOG:-}" == "" ]]; then
    rm -f "$ENGINE_LOG" "$APP_LOG"
    rm -rf "$WAL_DIR"
  else
    echo "engine log: $ENGINE_LOG"
    echo "app log:    $APP_LOG"
    echo "wal dir:    $WAL_DIR"
  fi
}
trap cleanup EXIT

echo "→ starting ClickHouse ($CH_CONTAINER)"
docker rm -f "$CH_CONTAINER" >/dev/null 2>&1 || true
docker run -d --rm --name "$CH_CONTAINER" \
  -p 127.0.0.1:18123:8123 \
  -p 127.0.0.1:19000:9000 \
  -e CLICKHOUSE_USER=default -e CLICKHOUSE_PASSWORD=dev -e CLICKHOUSE_DB=clearvoiance \
  clickhouse/clickhouse-server:24-alpine >/dev/null

echo "→ starting Postgres ($PG_CONTAINER)"
docker rm -f "$PG_CONTAINER" >/dev/null 2>&1 || true
docker run -d --rm --name "$PG_CONTAINER" \
  -p 127.0.0.1:15432:5432 \
  -e POSTGRES_USER=clv -e POSTGRES_PASSWORD=clv -e POSTGRES_DB=clv \
  postgres:16-alpine >/dev/null

echo "→ waiting for ClickHouse + Postgres"
for _ in $(seq 1 60); do
  if curl -fs -u default:dev "$CH_HTTP_URL/ping" >/dev/null 2>&1 \
     && docker exec "$PG_CONTAINER" pg_isready -U clv -d clv >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
curl -fs -u default:dev "$CH_HTTP_URL/ping" >/dev/null
docker exec "$PG_CONTAINER" pg_isready -U clv -d clv >/dev/null

echo "→ building engine"
go build -o "$ENGINE_BIN" ./engine/cmd/clearvoiance

start_engine() {
  "$ENGINE_BIN" serve \
    --grpc-addr "$ENGINE_ADDR" \
    --clickhouse-dsn "$CH_DSN" \
    --postgres-dsn "$PG_DSN" \
    >>"$ENGINE_LOG" 2>&1 &
  echo $! >"$ENGINE_PID_FILE"
  for _ in $(seq 1 50); do
    if ss -tln 2>/dev/null | grep -q "$ENGINE_ADDR"; then return 0; fi
    sleep 0.1
  done
  echo "✗ engine failed to bind"
  return 1
}

stop_engine() {
  if [[ -s "$ENGINE_PID_FILE" ]]; then
    kill "$(cat "$ENGINE_PID_FILE")" 2>/dev/null || true
    wait "$(cat "$ENGINE_PID_FILE")" 2>/dev/null || true
    : >"$ENGINE_PID_FILE"
  fi
  for _ in $(seq 1 50); do
    if ! ss -tln 2>/dev/null | grep -q "$ENGINE_ADDR"; then return 0; fi
    sleep 0.1
  done
}

echo "→ starting engine (1st time)"
start_engine

echo "→ building SDK"
pnpm --filter @clearvoiance/node build >/dev/null

echo "→ starting express-basic with WAL dir $WAL_DIR"
CLEARVOIANCE_ENGINE_URL="$ENGINE_ADDR" \
CLEARVOIANCE_API_KEY="dev" \
CLEARVOIANCE_SESSION_NAME="wal-restart" \
CLEARVOIANCE_WAL_DIR="$WAL_DIR" \
PORT="$APP_PORT" \
  pnpm --filter @clearvoiance/example-express-basic exec \
    tsx src/server.ts >"$APP_LOG" 2>&1 &
echo $! >"$APP_PID_FILE"

for _ in $(seq 1 50); do
  if ss -tln 2>/dev/null | grep -q ":$APP_PORT"; then break; fi
  sleep 0.1
done

echo "→ online phase: 1 request (should land in ClickHouse immediately)"
curl -fs "http://127.0.0.1:$APP_PORT/health" >/dev/null
sleep 1

echo "→ killing engine (SDK fails over to WAL)"
stop_engine

echo "→ offline phase: 2 requests should queue in WAL"
curl -fs "http://127.0.0.1:$APP_PORT/users/1" >/dev/null || true
curl -fs "http://127.0.0.1:$APP_PORT/users/2" >/dev/null || true
sleep 2

wal_files=$(find "$WAL_DIR" -name '*.pb' -type f 2>/dev/null | wc -l)
if [[ "$wal_files" -lt 2 ]]; then
  echo "✗ expected \u22652 WAL files before restart, got $wal_files"
  tail -30 "$APP_LOG"; exit 1
fi
echo "✓ offline phase: $wal_files WAL files on disk"

echo "→ restarting engine"
start_engine

echo "→ waiting for SDK to reconnect + drain"
# Reconnect backoff starts at 500 ms and doubles. Given our 500ms→1s→2s… pattern
# and that the engine is up fast, we expect drain within ~10-15s. Poll for the
# expected row count.
for i in $(seq 1 40); do
  total=$(curl -fs -u default:dev --get "$CH_HTTP_URL/" \
    --data-urlencode "database=clearvoiance" \
    --data-urlencode "query=SELECT count() FROM events WHERE adapter = 'http.express'" \
    | tr -d '[:space:]' || echo "0")
  if [[ "$total" -ge 3 ]]; then
    echo "✓ drained after ${i} poll(s): $total rows in ClickHouse"
    break
  fi
  sleep 0.5
done

if [[ "${total:-0}" -lt 3 ]]; then
  echo "✗ WAL did not drain within ~20s; got '$total' rows"
  echo "---app log---"; tail -40 "$APP_LOG"
  echo "---engine log---"; tail -40 "$ENGINE_LOG"
  echo "---wal dir leftover---"; find "$WAL_DIR" -type f || true
  exit 1
fi

remaining=$(find "$WAL_DIR" -name '*.pb' -type f 2>/dev/null | wc -l)
echo "✓ WAL drained, $remaining file(s) remain on disk"

echo "→ sample rows:"
curl -fs -u default:dev --get "$CH_HTTP_URL/" \
  --data-urlencode "database=clearvoiance" \
  --data-urlencode "query=SELECT http_method, http_path, http_status
                          FROM events WHERE adapter = 'http.express'
                          ORDER BY timestamp_ns FORMAT TSV"

echo "→ engine log tail:"
tail -20 "$ENGINE_LOG"
