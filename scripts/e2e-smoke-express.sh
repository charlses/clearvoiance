#!/usr/bin/env bash
# End-to-end capture smoke via the Express adapter.
#
# Boots ClickHouse + MinIO + engine, starts examples/express-basic, hits it with
# both small and large bodies, verifies the resulting rows landed in ClickHouse
# with the right method/path and that the large body landed in MinIO as a blob.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

ENGINE_BIN="$ROOT/bin/clearvoiance"
ENGINE_ADDR="127.0.0.1:9100"
APP_PORT="4000"
CH_CONTAINER="clearvoiance-smoke-ch-express"
CH_HTTP_URL="http://127.0.0.1:18123"
CH_DSN="clickhouse://default:dev@127.0.0.1:19000/clearvoiance"
MINIO_CONTAINER="clearvoiance-smoke-minio-express"
MINIO_ENDPOINT="http://127.0.0.1:19002"
MINIO_USER="dev"
MINIO_SECRET="devdevdev"
MINIO_BUCKET="clearvoiance-blobs"
ENGINE_LOG="$(mktemp)"
APP_LOG="$(mktemp)"
ENGINE_PID_FILE="$(mktemp)"
APP_PID_FILE="$(mktemp)"
LARGE_BODY_FILE="$(mktemp)"

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
  rm -f "$ENGINE_PID_FILE" "$APP_PID_FILE" "$LARGE_BODY_FILE"
  docker rm -f "$CH_CONTAINER" >/dev/null 2>&1 || true
  docker rm -f "$MINIO_CONTAINER" >/dev/null 2>&1 || true
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

echo "→ starting MinIO ($MINIO_CONTAINER)"
docker rm -f "$MINIO_CONTAINER" >/dev/null 2>&1 || true
docker run -d --rm --name "$MINIO_CONTAINER" \
  -p 127.0.0.1:19002:9000 \
  -p 127.0.0.1:19003:9001 \
  -e MINIO_ROOT_USER="$MINIO_USER" \
  -e MINIO_ROOT_PASSWORD="$MINIO_SECRET" \
  minio/minio:RELEASE.2024-12-18T13-15-44Z \
  server /data --console-address ":9001" >/dev/null

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

echo "→ waiting for MinIO"
ready=0
for _ in $(seq 1 60); do
  if curl -fs "$MINIO_ENDPOINT/minio/health/live" >/dev/null 2>&1; then
    ready=1; break
  fi
  sleep 1
done
if [[ "$ready" -ne 1 ]]; then
  echo "✗ MinIO did not become ready in 60s"
  exit 1
fi

echo "→ creating bucket via mc-in-container"
docker run --rm --network host \
  -e MC_HOST_local="http://${MINIO_USER}:${MINIO_SECRET}@127.0.0.1:19002" \
  minio/mc:RELEASE.2024-11-21T17-21-54Z mb -p "local/${MINIO_BUCKET}" >/dev/null 2>&1 || true

echo "→ building engine"
go build -o "$ENGINE_BIN" ./engine/cmd/clearvoiance

echo "→ starting engine"
"$ENGINE_BIN" serve \
  --grpc-addr "$ENGINE_ADDR" \
  --clickhouse-dsn "$CH_DSN" \
  --minio-endpoint "$MINIO_ENDPOINT" \
  --minio-access-key "$MINIO_USER" \
  --minio-secret-key "$MINIO_SECRET" \
  --minio-bucket "$MINIO_BUCKET" \
  --minio-path-style \
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

echo "→ generating a 200KB POST (should take the blob path)"
python3 -c "
import json, sys
obj = {'payload': 'x' * 200_000}
sys.stdout.write(json.dumps(obj))" >"$LARGE_BODY_FILE"
curl -fs -X POST "http://127.0.0.1:$APP_PORT/echo" \
  -H 'content-type: application/json' \
  --data-binary "@$LARGE_BODY_FILE" >/dev/null

# Small grace period so res.on('finish') fires + the async IIFE registers
# with client.track() before we send SIGTERM.
sleep 1

echo "→ stopping example (flushes session)"
kill "$(cat "$APP_PID_FILE")" 2>/dev/null || true
for _ in $(seq 1 80); do
  if ! kill -0 "$(cat "$APP_PID_FILE")" 2>/dev/null; then break; fi
  sleep 0.1
done
: >"$APP_PID_FILE"

# Small grace period so ClickHouse writers see any trailing inserts flushed.
sleep 1

echo "→ verifying rows in ClickHouse"
count=$(curl -fs -u default:dev --get "$CH_HTTP_URL/" \
  --data-urlencode "database=clearvoiance" \
  --data-urlencode "query=SELECT count() FROM events WHERE adapter = 'http.express'" \
  | tr -d '[:space:]')

if [[ "$count" -lt 4 ]]; then
  echo "✗ expected ≥4 http.express events, got '$count'"
  echo "---app log---"; tail -30 "$APP_LOG"
  echo "---engine log---"; tail -30 "$ENGINE_LOG"
  echo "---rows in ClickHouse:---"
  curl -fs -u default:dev --get "$CH_HTTP_URL/" \
    --data-urlencode "database=clearvoiance" \
    --data-urlencode "query=SELECT http_method, http_path, http_status, body_size, has(redactions, 'body:truncated') as trunc
                            FROM events ORDER BY timestamp_ns FORMAT TSV"
  exit 1
fi
echo "✓ ClickHouse reports $count http.express events"

echo "→ sample rows:"
curl -fs -u default:dev --get "$CH_HTTP_URL/" \
  --data-urlencode "database=clearvoiance" \
  --data-urlencode "query=SELECT http_method, http_path, http_status, http_route, body_size
                          FROM events WHERE adapter = 'http.express'
                          ORDER BY timestamp_ns FORMAT TSV"

echo "→ verifying blob landed in MinIO"
blob_count=$(docker run --rm --network host \
  -e MC_HOST_local="http://${MINIO_USER}:${MINIO_SECRET}@127.0.0.1:19002" \
  minio/mc:RELEASE.2024-11-21T17-21-54Z \
  --json ls -r "local/${MINIO_BUCKET}" 2>/dev/null | wc -l)

if [[ "$blob_count" -lt 1 ]]; then
  echo "✗ expected ≥1 blob in MinIO, found $blob_count"
  echo "---engine log---"; tail -25 "$ENGINE_LOG"
  exit 1
fi
echo "✓ MinIO reports $blob_count blob(s)"

echo "→ engine log tail:"
tail -20 "$ENGINE_LOG"
