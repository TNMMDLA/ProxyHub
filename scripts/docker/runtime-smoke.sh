#!/usr/bin/env bash
set -euo pipefail

services=(xray proxyhub-agent proxyhub-server)
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
  "fetch('http://127.0.0.1:3000/api/health').then(async response => { const body = await response.json(); if (!response.ok || body?.success !== true || body?.data?.status !== 'ok') process.exit(1); console.log(JSON.stringify(body)); }).catch(error => { console.error(error); process.exit(1); })"

docker compose exec -T -w /app/apps/agent proxyhub-agent node --input-type=module \
  < scripts/runtime/verify-xray-lifecycle.mjs

echo "Production Compose runtime smoke test passed."
