#!/usr/bin/env bash
# End-to-end capture smoke.
#
# Default (noop storage): builds engine → runs engine → SDK streams events → assert.
#
# With ClickHouse (WITH_CLICKHOUSE=1): also spins up a ClickHouse container,
# points the engine at it, and verifies rows actually landed in the events table.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

ENGINE_BIN="$ROOT/bin/clearvoiance"
ENGINE_ADDR="127.0.0.1:9100"
LOG="$(mktemp)"
PID_FILE="$(mktemp)"
CH_CONTAINER="clearvoiance-smoke-clickhouse"

with_clickhouse="${WITH_CLICKHOUSE:-}"
engine_dsn=""

cleanup() {
  if [[ -s "$PID_FILE" ]]; then
    local pid
    pid=$(cat "$PID_FILE")
    if kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
      wait "$pid" 2>/dev/null || true
    fi
  fi
  rm -f "$PID_FILE"
  if [[ -n "$with_clickhouse" ]]; then
    docker rm -f "$CH_CONTAINER" >/dev/null 2>&1 || true
  fi
  if [[ "${KEEP_LOG:-}" == "" ]]; then
    rm -f "$LOG"
  else
    echo "engine log kept at: $LOG"
  fi
}
trap cleanup EXIT

if [[ -n "$with_clickhouse" ]]; then
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
    if curl -fs -u "default:dev" "http://127.0.0.1:18123/ping" >/dev/null 2>&1; then
      break
    fi
    sleep 1
  done
  if ! curl -fs -u "default:dev" "http://127.0.0.1:18123/ping" >/dev/null 2>&1; then
    echo "✗ ClickHouse did not become ready in 60s"
    exit 1
  fi

  engine_dsn="clickhouse://default:dev@127.0.0.1:19000/clearvoiance"
fi

echo "→ building engine"
go build -o "$ENGINE_BIN" ./engine/cmd/clearvoiance

echo "→ starting engine at $ENGINE_ADDR${engine_dsn:+ (ClickHouse: $engine_dsn)}"
if [[ -n "$engine_dsn" ]]; then
  "$ENGINE_BIN" serve --grpc-addr "$ENGINE_ADDR" --clickhouse-dsn "$engine_dsn" >"$LOG" 2>&1 &
else
  "$ENGINE_BIN" serve --grpc-addr "$ENGINE_ADDR" >"$LOG" 2>&1 &
fi
echo $! >"$PID_FILE"

# Wait up to 5s for the engine to accept connections.
for _ in $(seq 1 50); do
  if ss -tln 2>/dev/null | grep -q "$ENGINE_ADDR"; then
    break
  fi
  sleep 0.1
done
if ! ss -tln 2>/dev/null | grep -q "$ENGINE_ADDR"; then
  echo "✗ engine failed to bind $ENGINE_ADDR within 5s"
  cat "$LOG"
  exit 1
fi

echo "→ running smoke"
CLEARVOIANCE_ENGINE_URL="$ENGINE_ADDR" \
  pnpm --filter @clearvoiance/node exec \
  tsx test/e2e/capture-smoke.ts

if [[ -n "$with_clickhouse" ]]; then
  echo "→ verifying rows in ClickHouse"
  count=$(curl -fs -u "default:dev" --get \
    "http://127.0.0.1:18123/" \
    --data-urlencode "database=clearvoiance" \
    --data-urlencode "query=SELECT count() FROM events WHERE session_id LIKE 'sess_%'" \
    | tr -d '[:space:]')
  if [[ "$count" == "5" ]]; then
    echo "✓ ClickHouse reports $count rows"
  else
    echo "✗ expected 5 rows, got '$count'"
    cat "$LOG"
    exit 1
  fi

  sample=$(curl -fs -u "default:dev" --get \
    "http://127.0.0.1:18123/" \
    --data-urlencode "database=clearvoiance" \
    --data-urlencode "query=SELECT event_type, http_method, http_path FROM events LIMIT 1 FORMAT TSV")
  echo "  sample row: $sample"
fi

echo "→ engine log tail:"
tail -20 "$LOG"
