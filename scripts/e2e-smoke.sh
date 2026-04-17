#!/usr/bin/env bash
# Phase 1a end-to-end smoke:
#   1. build the engine
#   2. start it in the background
#   3. run the Node smoke test
#   4. always tear the engine down on exit
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

ENGINE_BIN="$ROOT/bin/clearvoiance"
ENGINE_ADDR="127.0.0.1:9100"
LOG="$(mktemp)"
PID_FILE="$(mktemp)"

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
  if [[ "${KEEP_LOG:-}" == "" ]]; then
    rm -f "$LOG"
  else
    echo "engine log kept at: $LOG"
  fi
}
trap cleanup EXIT

echo "→ building engine"
go build -o "$ENGINE_BIN" ./engine/cmd/clearvoiance

echo "→ starting engine at $ENGINE_ADDR"
"$ENGINE_BIN" serve --grpc-addr "$ENGINE_ADDR" >"$LOG" 2>&1 &
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

echo "→ engine log tail:"
tail -20 "$LOG"
