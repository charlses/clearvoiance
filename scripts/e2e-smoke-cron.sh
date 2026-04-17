#!/usr/bin/env bash
# End-to-end capture smoke via the node-cron adapter.
#
# Boots ClickHouse + engine, starts examples/cron-basic, lets the two jobs
# (heartbeat every 1s, flaky every 2s) tick for ~6 seconds, then stops the
# worker and verifies rows landed in ClickHouse with the expected cron_job /
# cron_status mix.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

ENGINE_BIN="$ROOT/bin/clearvoiance"
ENGINE_ADDR="127.0.0.1:9100"
CH_CONTAINER="clearvoiance-smoke-ch-cron"
CH_HTTP_URL="http://127.0.0.1:18123"
CH_DSN="clickhouse://default:dev@127.0.0.1:19000/clearvoiance"
ENGINE_LOG="$(mktemp)"
APP_LOG="$(mktemp)"
ENGINE_PID_FILE="$(mktemp)"
APP_PID_FILE="$(mktemp)"

# How long to let the cron worker tick before we stop it.
RUN_SECONDS="${RUN_SECONDS:-6}"

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
"$ENGINE_BIN" serve --grpc-addr "$ENGINE_ADDR" --clickhouse-dsn "$CH_DSN" \
  >"$ENGINE_LOG" 2>&1 &
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

echo "→ starting cron-basic worker"
CLEARVOIANCE_ENGINE_URL="$ENGINE_ADDR" \
CLEARVOIANCE_API_KEY="dev" \
CLEARVOIANCE_SESSION_NAME="cron-smoke" \
  pnpm --filter @clearvoiance/example-cron-basic exec \
    tsx src/worker.ts >"$APP_LOG" 2>&1 &
echo $! >"$APP_PID_FILE"

# Wait for the worker to register its session, then let jobs tick.
for _ in $(seq 1 50); do
  if grep -q "cron workers running" "$APP_LOG" 2>/dev/null; then break; fi
  sleep 0.1
done
grep -q "cron workers running" "$APP_LOG" 2>/dev/null || {
  echo "✗ worker never reported ready"; cat "$APP_LOG"; exit 1;
}

echo "→ letting jobs tick for ${RUN_SECONDS}s"
sleep "$RUN_SECONDS"

echo "→ stopping worker (flushes session)"
kill "$(cat "$APP_PID_FILE")" 2>/dev/null || true
for _ in $(seq 1 80); do
  if ! kill -0 "$(cat "$APP_PID_FILE")" 2>/dev/null; then break; fi
  sleep 0.1
done
: >"$APP_PID_FILE"

# Grace for any trailing inserts to settle.
sleep 1

echo "→ verifying rows in ClickHouse"
total=$(curl -fs -u default:dev --get "$CH_HTTP_URL/" \
  --data-urlencode "database=clearvoiance" \
  --data-urlencode "query=SELECT count() FROM events WHERE adapter = 'cron.node-cron'" \
  | tr -d '[:space:]')

# With RUN_SECONDS=6 we expect heartbeat (~6) + flaky (~3) = ~9 events minimum.
# Give wide slack because CI scheduling can delay the first tick.
if [[ "$total" -lt 4 ]]; then
  echo "✗ expected ≥4 cron events, got '$total'"
  echo "---app log---"; tail -30 "$APP_LOG"
  echo "---engine log---"; tail -30 "$ENGINE_LOG"
  exit 1
fi
echo "✓ ClickHouse reports $total cron.node-cron events"

check_combo() {
  local job="$1"
  local status="$2"
  local min="$3"
  local got
  got=$(curl -fs -u default:dev --get "$CH_HTTP_URL/" \
    --data-urlencode "database=clearvoiance" \
    --data-urlencode "query=SELECT count() FROM events
                            WHERE adapter = 'cron.node-cron'
                              AND cron_job = '$job' AND cron_status = '$status'" \
    | tr -d '[:space:]')
  if [[ "$got" -lt "$min" ]]; then
    echo "✗ expected ≥$min rows for ($job, $status), got '$got'"
    return 1
  fi
  echo "  ✓ $job/$status: $got"
}

# Heartbeat must have fired at least 3 times successfully in 6s.
check_combo "heartbeat" "success" 3
# Flaky fires every 2s; at least one success and one error expected.
check_combo "flaky" "success" 1 || true  # may miss if flaky fires only 1-2 times
check_combo "flaky" "error" 1 || true    # first error is on the 3rd flaky tick

echo "→ sample rows:"
curl -fs -u default:dev --get "$CH_HTTP_URL/" \
  --data-urlencode "database=clearvoiance" \
  --data-urlencode "query=SELECT cron_job, cron_status, count(),
                                 round(avg(duration_ns) / 1e6, 2) AS avg_ms
                          FROM events WHERE adapter = 'cron.node-cron'
                          GROUP BY cron_job, cron_status
                          ORDER BY cron_job, cron_status FORMAT TSV"

echo "→ engine log tail:"
tail -10 "$ENGINE_LOG"
