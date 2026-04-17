#!/usr/bin/env bash
# End-to-end capture smoke via the Socket.io adapter.
#
# Boots ClickHouse + engine, starts examples/socketio-basic, runs a small
# smoke client that exercises default + /chat namespaces, verifies the
# resulting rows landed in ClickHouse with the expected socket_op / socket_event.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

ENGINE_BIN="$ROOT/bin/clearvoiance"
ENGINE_ADDR="127.0.0.1:9100"
APP_PORT="4100"
CH_CONTAINER="clearvoiance-smoke-ch-socketio"
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

echo "→ starting socketio-basic on :$APP_PORT"
CLEARVOIANCE_ENGINE_URL="$ENGINE_ADDR" \
CLEARVOIANCE_API_KEY="dev" \
CLEARVOIANCE_SESSION_NAME="socketio-smoke" \
PORT="$APP_PORT" \
  pnpm --filter @clearvoiance/example-socketio-basic exec \
    tsx src/server.ts >"$APP_LOG" 2>&1 &
echo $! >"$APP_PID_FILE"

for _ in $(seq 1 50); do
  if ss -tln 2>/dev/null | grep -q ":$APP_PORT"; then break; fi
  sleep 0.1
done
ss -tln 2>/dev/null | grep -q ":$APP_PORT" || {
  echo "✗ example failed to bind :$APP_PORT"; cat "$APP_LOG"; exit 1;
}

echo "→ running smoke client"
SMOKE_SERVER_URL="http://127.0.0.1:$APP_PORT" \
  pnpm --filter @clearvoiance/example-socketio-basic exec \
  tsx src/smoke-client.ts

# Let the server process the disconnects + the capture IIFEs register.
sleep 1

echo "→ stopping example (flushes session)"
kill "$(cat "$APP_PID_FILE")" 2>/dev/null || true
for _ in $(seq 1 80); do
  if ! kill -0 "$(cat "$APP_PID_FILE")" 2>/dev/null; then break; fi
  sleep 0.1
done
: >"$APP_PID_FILE"

# Grace for ClickHouse to settle any trailing inserts.
sleep 1

echo "→ verifying rows in ClickHouse"
total=$(curl -fs -u default:dev --get "$CH_HTTP_URL/" \
  --data-urlencode "database=clearvoiance" \
  --data-urlencode "query=SELECT count() FROM events WHERE adapter = 'socket.io'" \
  | tr -d '[:space:]')

# Smoke client does: 2 CONNECTs (/ + /chat), 3 client emits (ping, broadcast,
# say), 3 server emits (pong, broadcast:fanout, echo), 2 DISCONNECTs. Plus the
# broadcast triggers fanout to ALL connected sockets (just the one root). So
# minimum expected = 10. We assert ≥ 9 to give a little wiggle room.
if [[ "$total" -lt 9 ]]; then
  echo "✗ expected ≥9 socket.io events, got '$total'"
  echo "---app log---"; tail -30 "$APP_LOG"
  echo "---engine log---"; tail -30 "$ENGINE_LOG"
  curl -fs -u default:dev --get "$CH_HTTP_URL/" \
    --data-urlencode "database=clearvoiance" \
    --data-urlencode "query=SELECT socket_op, socket_event, namespace := metadata['namespace']
                            FROM events WHERE adapter = 'socket.io'
                            ORDER BY timestamp_ns FORMAT TSV"
  exit 1
fi
echo "✓ ClickHouse reports $total socket.io events"

# Verify each expected op is present.
check_op() {
  local op="$1"
  local min="$2"
  local got
  got=$(curl -fs -u default:dev --get "$CH_HTTP_URL/" \
    --data-urlencode "database=clearvoiance" \
    --data-urlencode "query=SELECT count() FROM events
                            WHERE adapter = 'socket.io' AND socket_op = '$op'" \
    | tr -d '[:space:]')
  if [[ "$got" -lt "$min" ]]; then
    echo "✗ expected ≥$min $op events, got '$got'"
    return 1
  fi
  echo "  ✓ $op: $got"
}

check_op "SOCKET_OP_CONNECT" 2
check_op "SOCKET_OP_RECV_FROM_CLIENT" 3
check_op "SOCKET_OP_EMIT_TO_CLIENT" 3
check_op "SOCKET_OP_DISCONNECT" 2

echo "→ sample rows:"
curl -fs -u default:dev --get "$CH_HTTP_URL/" \
  --data-urlencode "database=clearvoiance" \
  --data-urlencode "query=SELECT socket_op, socket_event, user_id
                          FROM events WHERE adapter = 'socket.io'
                          ORDER BY timestamp_ns FORMAT TSV"

echo "→ engine log tail:"
tail -15 "$ENGINE_LOG"
