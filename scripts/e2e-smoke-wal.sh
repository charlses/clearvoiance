#!/usr/bin/env bash
# End-to-end durability smoke.
#
# Boots ClickHouse + engine, starts examples/express-basic with an explicit
# WAL directory, hits it online (one row should land in ClickHouse), kills
# the engine, hits it again (those batches must land on disk, not be lost),
# and verifies the WAL directory contains batch files we can decode back.
#
# Full drain-across-engine-restart requires session persistence on the engine
# side (Phase 1i / Phase 2); this smoke proves the write-to-WAL path which is
# the durability contract Phase 1h ships.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

ENGINE_BIN="$ROOT/bin/clearvoiance"
ENGINE_ADDR="127.0.0.1:9100"
APP_PORT="4200"
CH_CONTAINER="clearvoiance-smoke-ch-wal"
CH_HTTP_URL="http://127.0.0.1:18123"
CH_DSN="clickhouse://default:dev@127.0.0.1:19000/clearvoiance"
WAL_DIR="$(mktemp -d -t clearvoiance-wal-smoke-XXXXXX)"
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
  -e CLICKHOUSE_USER=default \
  -e CLICKHOUSE_PASSWORD=dev \
  -e CLICKHOUSE_DB=clearvoiance \
  clickhouse/clickhouse-server:24-alpine >/dev/null

echo "→ waiting for ClickHouse"
ready=0
for _ in $(seq 1 60); do
  if curl -fs -u default:dev "$CH_HTTP_URL/ping" >/dev/null 2>&1; then
    ready=1; break
  fi
  sleep 1
done
if [[ "$ready" -ne 1 ]]; then
  echo "✗ ClickHouse did not become ready in 60s"
  exit 1
fi

echo "→ building engine"
go build -o "$ENGINE_BIN" ./engine/cmd/clearvoiance

start_engine() {
  "$ENGINE_BIN" serve --grpc-addr "$ENGINE_ADDR" --clickhouse-dsn "$CH_DSN" \
    >>"$ENGINE_LOG" 2>&1 &
  echo $! >"$ENGINE_PID_FILE"
  for _ in $(seq 1 50); do
    if ss -tln 2>/dev/null | grep -q "$ENGINE_ADDR"; then return 0; fi
    sleep 0.1
  done
  echo "✗ engine failed to bind"; return 1
}

stop_engine() {
  if [[ -s "$ENGINE_PID_FILE" ]]; then
    kill "$(cat "$ENGINE_PID_FILE")" 2>/dev/null || true
    wait "$(cat "$ENGINE_PID_FILE")" 2>/dev/null || true
    : >"$ENGINE_PID_FILE"
  fi
  # Wait for socket to actually release.
  for _ in $(seq 1 50); do
    if ! ss -tln 2>/dev/null | grep -q "$ENGINE_ADDR"; then return 0; fi
    sleep 0.1
  done
}

echo "→ starting engine"
start_engine

echo "→ building SDK"
pnpm --filter @clearvoiance/node build >/dev/null

echo "→ starting express-basic on :$APP_PORT with WAL at $WAL_DIR"
CLEARVOIANCE_ENGINE_URL="$ENGINE_ADDR" \
CLEARVOIANCE_API_KEY="dev" \
CLEARVOIANCE_SESSION_NAME="wal-smoke" \
CLEARVOIANCE_WAL_DIR="$WAL_DIR" \
PORT="$APP_PORT" \
  pnpm --filter @clearvoiance/example-express-basic exec \
    tsx src/server.ts >"$APP_LOG" 2>&1 &
echo $! >"$APP_PID_FILE"

for _ in $(seq 1 50); do
  if ss -tln 2>/dev/null | grep -q ":$APP_PORT"; then break; fi
  sleep 0.1
done

echo "→ online phase: one request should land in ClickHouse"
curl -fs "http://127.0.0.1:$APP_PORT/health" >/dev/null
# Give the adapter IIFE time to send.
sleep 1

online_count=$(curl -fs -u default:dev --get "$CH_HTTP_URL/" \
  --data-urlencode "database=clearvoiance" \
  --data-urlencode "query=SELECT count() FROM events WHERE adapter = 'http.express'" \
  | tr -d '[:space:]')
if [[ "$online_count" -lt 1 ]]; then
  echo "✗ expected 1 online row in ClickHouse, got '$online_count'"
  tail -30 "$APP_LOG"; tail -30 "$ENGINE_LOG"
  exit 1
fi
echo "✓ online phase: $online_count row(s) in ClickHouse"

echo "→ killing engine (SDK should fail over to WAL)"
stop_engine

echo "→ offline phase: two requests should go to WAL"
# Hit twice; each req becomes one sendBatch → one WAL file.
curl -fs "http://127.0.0.1:$APP_PORT/users/1" >/dev/null || true
curl -fs "http://127.0.0.1:$APP_PORT/users/2" >/dev/null || true
# Give the adapter IIFE a beat to write to disk.
sleep 2

wal_files=$(find "$WAL_DIR" -name '*.pb' -type f 2>/dev/null | wc -l)
if [[ "$wal_files" -lt 2 ]]; then
  echo "✗ expected \u22652 WAL files, got '$wal_files'"
  echo "---wal dir contents---"
  find "$WAL_DIR" -type f 2>/dev/null || true
  echo "---app log---"; tail -30 "$APP_LOG"
  exit 1
fi
echo "✓ offline phase: $wal_files WAL file(s) on disk at $WAL_DIR"

# Verify the files are real protobuf by checking sizes are non-zero + sniffing
# for the adapter string we know will appear encoded in them.
for f in "$WAL_DIR"/*/*.pb; do
  size=$(wc -c < "$f")
  if [[ "$size" -lt 1 ]]; then
    echo "✗ WAL file $f is empty"; exit 1
  fi
  if ! grep -a -q "http.express" "$f"; then
    echo "✗ WAL file $f missing adapter marker"; exit 1
  fi
done
echo "✓ WAL files non-empty and contain adapter marker"

echo "→ engine log tail:"
tail -10 "$ENGINE_LOG"
