#!/bin/sh
set -eu

CONFIG=/etc/xray/config.json
SIGNAL=/var/run/proxyhub/restart
PID_FILE=/var/run/proxyhub/xray.pid
HEARTBEAT=/var/run/proxyhub/xray.heartbeat
APPLIED=/var/run/proxyhub/applied

if [ ! -f "$CONFIG" ]; then
  mkdir -p /etc/xray /var/run/proxyhub
  printf '%s\n' '{"log":{"loglevel":"warning"},"inbounds":[],"outbounds":[{"protocol":"freedom","tag":"direct"}]}' > "$CONFIG"
fi

start_xray() {
  xray run -test -config "$CONFIG"
  xray run -config "$CONFIG" &
  pid=$!
  printf '%s\n' "$pid" > "$PID_FILE"
}

start_xray
last_signal=""

cleanup() {
  rm -f "$PID_FILE" "$HEARTBEAT" "$APPLIED"
  kill "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
}

trap 'cleanup; exit 0' TERM INT
trap cleanup EXIT

while true; do
  date -u +%Y-%m-%dT%H:%M:%SZ > "$HEARTBEAT"
  if ! kill -0 "$pid" 2>/dev/null; then
    wait "$pid" || true
    start_xray
  fi
  if [ -f "$SIGNAL" ]; then
    current_signal=$(cat "$SIGNAL")
    if [ "$current_signal" != "$last_signal" ]; then
      xray run -test -config "$CONFIG"
      kill "$pid"
      wait "$pid" || true
      start_xray
      printf '%s\n' "$current_signal" > "$APPLIED"
      last_signal="$current_signal"
    fi
  fi
  sleep 2
done
