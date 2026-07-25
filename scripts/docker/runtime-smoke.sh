#!/usr/bin/env bash
set -euo pipefail

services=(xray proxyhub-agent proxyhub-server proxyhub-web caddy)
deadline=$((SECONDS + 150))

while (( SECONDS < deadline )); do
  all_healthy=true
  for service in "${services[@]}"; do
    container_id="$(docker compose ps -q --all "$service")"
    if [[ -z "$container_id" ]]; then
      all_healthy=false
      continue
    fi

    state="$(docker inspect --format '{{.State.Status}}' "$container_id")"
    if [[ "$state" == "exited" || "$state" == "dead" ]]; then
      echo "$service entered terminal state: $state" >&2
      docker compose logs --no-color "$service" >&2
      exit 1
    fi

    health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$container_id")"
    if [[ "$state" != "running" || "$health" != "healthy" ]]; then
      all_healthy=false
    fi
  done

  if [[ "$all_healthy" == "true" ]]; then
    break
  fi
  sleep 2
done

for service in "${services[@]}"; do
  container_id="$(docker compose ps -q --all "$service")"
  state="$(docker inspect --format '{{.State.Status}}' "$container_id")"
  health="$(docker inspect --format '{{.State.Health.Status}}' "$container_id")"
  restart_count="$(docker inspect --format '{{.RestartCount}}' "$container_id")"
  if [[ "$state" != "running" || "$health" != "healthy" || "$restart_count" != "0" ]]; then
    echo "$service failed runtime smoke: state=$state health=$health restarts=$restart_count" >&2
    docker compose logs --no-color "$service" >&2
    exit 1
  fi
  echo "$service: state=$state health=$health restarts=$restart_count"
done

docker compose exec -T proxyhub-server node -e \
  "fetch('http://127.0.0.1:3000/api/health').then(async response => { const body = await response.json(); const d=body?.data; if (!response.ok || body?.success !== true || d?.status !== 'ok' || typeof d?.version !== 'string' || typeof d?.gitSha !== 'string' || typeof d?.buildTime !== 'string' || d?.xrayVersion !== '26.5.9' || !/^[0-9a-f]{64}$/.test(d?.database?.migrationFingerprint ?? '')) process.exit(1); console.log(JSON.stringify(body)); }).catch(error => { console.error(error); process.exit(1); })"

docker compose exec -T proxyhub-server sqlite3 --version
database_integrity="$(
  docker compose exec -T proxyhub-server sqlite3 /app/data/proxyhub.db 'PRAGMA integrity_check;'
)"
if [[ "$database_integrity" != "ok" ]]; then
  echo "Runtime SQLite integrity check failed: $database_integrity" >&2
  exit 1
fi

for service in "${services[@]}"; do
  container_id="$(docker compose ps -q --all "$service")"
  log_driver="$(docker inspect --format '{{.HostConfig.LogConfig.Type}}' "$container_id")"
  max_size="$(docker inspect --format '{{index .HostConfig.LogConfig.Config "max-size"}}' "$container_id")"
  max_file="$(docker inspect --format '{{index .HostConfig.LogConfig.Config "max-file"}}' "$container_id")"
  if [[ "$log_driver" != "json-file" || "$max_size" != "10m" || "$max_file" != "3" ]]; then
    echo "$service log rotation is invalid: $log_driver $max_size $max_file" >&2
    exit 1
  fi
done

docker compose exec -T -w /app/apps/agent proxyhub-agent node --input-type=module \
  < scripts/runtime/verify-xray-lifecycle.mjs

for service in "${services[@]}"; do
  container_id="$(docker compose ps -q --all "$service")"
  state="$(docker inspect --format '{{.State.Status}}' "$container_id")"
  restart_count="$(docker inspect --format '{{.RestartCount}}' "$container_id")"
  if [[ "$state" != "running" || "$restart_count" != "0" ]]; then
    echo "$service changed state during Reality compatibility smoke: state=$state restarts=$restart_count" >&2
    exit 1
  fi
done

echo "Production Compose runtime smoke test passed."
