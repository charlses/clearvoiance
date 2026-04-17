#!/usr/bin/env bash
# End-to-end replay with virtual users + unique-email mutator (Phase 2b).
#
# Flow:
#   1. Boot ClickHouse + Postgres + engine
#   2. Start examples/express-basic
#   3. POST /echo once with {"email":"user@example.com"} — captured
#   4. Stop source (session closes)
#   5. Start a tracking target that logs every received body
#   6. Replay with --virtual-users=3 --mutator=unique-fields --mutator-path='$.email'
#      Plus --auth=static-swap --auth-token=staging-token to exercise auth too
#   7. Verify target received 3 requests, each with a different email
#      (user@..., user+vu1@..., user+vu2@...) and Authorization=Bearer staging-token
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

ENGINE_BIN="$ROOT/bin/clearvoiance"
ENGINE_ADDR="127.0.0.1:9100"
APP_PORT="4500"
TARGET_PORT="4501"
CH_CONTAINER="clearvoiance-smoke-ch-replayvu"
CH_HTTP_URL="http://127.0.0.1:18123"
CH_DSN="clickhouse://default:dev@127.0.0.1:19000/clearvoiance"
PG_CONTAINER="clearvoiance-smoke-pg-replayvu"
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
CLEARVOIANCE_SESSION_NAME="replayvu-source" \
PORT="$APP_PORT" \
  pnpm --filter @clearvoiance/example-express-basic exec \
    tsx src/server.ts >"$APP_LOG" 2>&1 &
echo $! >"$APP_PID_FILE"
for _ in $(seq 1 50); do
  if ss -tln 2>/dev/null | grep -q ":$APP_PORT"; then break; fi
  sleep 0.1
done

echo "→ capturing one POST /echo with an email in the body"
curl -fs -X POST "http://127.0.0.1:$APP_PORT/echo" \
  -H 'content-type: application/json' \
  -H 'authorization: Bearer original-will-be-swapped' \
  -d '{"email":"ada@example.com","username":"ada"}' >/dev/null
sleep 1

echo "→ stopping capture-side example"
kill "$(cat "$APP_PID_FILE")" 2>/dev/null || true
for _ in $(seq 1 50); do
  if ! kill -0 "$(cat "$APP_PID_FILE")" 2>/dev/null; then break; fi
  sleep 0.1
done
: >"$APP_PID_FILE"

SESSION_ID=$(docker exec "$PG_CONTAINER" psql -U clv -d clv -t -A \
  -c "SELECT id FROM sessions WHERE name = 'replayvu-source' ORDER BY started_at DESC LIMIT 1" \
  | tr -d '[:space:]')
echo "  session = $SESSION_ID"

echo "→ starting tracking target on :$TARGET_PORT"
node -e "
const http = require('http');
const fs = require('fs');
const log = fs.createWriteStream('$TARGET_LOG', { flags: 'a' });
http.createServer((req, res) => {
  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString('utf-8');
    const auth = req.headers['authorization'] || '';
    log.write(req.method + ' ' + req.url + ' ' + JSON.stringify({body, auth}) + '\n');
    res.writeHead(200, {'content-type': 'application/json'});
    res.end(JSON.stringify({ok: true}));
  });
}).listen($TARGET_PORT, '127.0.0.1');
" &
echo $! >"$TARGET_PID_FILE"
for _ in $(seq 1 50); do
  if ss -tln 2>/dev/null | grep -q ":$TARGET_PORT"; then break; fi
  sleep 0.1
done

echo "→ replay: 3 VUs + unique-fields on \$.email + static-swap auth"
REPLAY_ID=$("$ENGINE_BIN" replay start \
  --source="$SESSION_ID" \
  --target="http://127.0.0.1:$TARGET_PORT" \
  --speedup=10 \
  --virtual-users=3 \
  --mutator=unique-fields \
  --mutator-path='$.email' \
  --auth=static-swap \
  --auth-prefix='Bearer ' \
  --auth-token='staging-token' \
  --engine "$ENGINE_ADDR" | tr -d '[:space:]')
echo "  replay = $REPLAY_ID"

echo "→ polling for completion"
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
  echo "✗ replay status=$status"
  tail -30 "$ENGINE_LOG"
  exit 1
fi
echo "✓ replay completed"

echo "→ verifying target received 3 requests with distinct emails + swapped auth"
target_count=$(wc -l < "$TARGET_LOG" | tr -d '[:space:]')
if [[ "$target_count" -lt 3 ]]; then
  echo "✗ expected 3 requests, got '$target_count'"
  cat "$TARGET_LOG"
  exit 1
fi
echo "✓ target received $target_count request(s):"
cat "$TARGET_LOG"

# Extract distinct emails.
emails=$(grep -oE 'ada[^"]*@example\.com' "$TARGET_LOG" | sort -u)
echo "  distinct emails: $emails"
if ! echo "$emails" | grep -q '^ada@example\.com$'; then
  echo "✗ missing original email ada@example.com"; exit 1
fi
if ! echo "$emails" | grep -q '^ada+vu1@example\.com$'; then
  echo "✗ missing vu1 email"; exit 1
fi
if ! echo "$emails" | grep -q '^ada+vu2@example\.com$'; then
  echo "✗ missing vu2 email"; exit 1
fi
echo "✓ all 3 VUs got unique emails"

# Verify auth was swapped.
if ! grep -q 'Bearer staging-token' "$TARGET_LOG"; then
  echo "✗ authorization header was not swapped"
  cat "$TARGET_LOG"
  exit 1
fi
if grep -q 'original-will-be-swapped' "$TARGET_LOG"; then
  echo "✗ original Authorization leaked through"
  cat "$TARGET_LOG"
  exit 1
fi
echo "✓ static-swap auth applied: Bearer staging-token on every request"

echo "→ replay_events:"
sleep 1
curl -fs -u default:dev --get "$CH_HTTP_URL/" \
  --data-urlencode "database=clearvoiance" \
  --data-urlencode "query=SELECT event_id, http_method, http_path, response_status
                          FROM replay_events WHERE replay_id = '$REPLAY_ID'
                          ORDER BY scheduled_fire_ns, event_id FORMAT TSV"

echo "→ engine log tail:"
tail -10 "$ENGINE_LOG"
