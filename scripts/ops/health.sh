#!/usr/bin/env bash
set -Eeuo pipefail

# shellcheck source=lib/common.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/common.sh"

MANIFEST=""
EXPECTED_VERSION=""
EXPECTED_SHA=""
TIMEOUT=120
RESULTS='[]'

usage() {
  cat <<'EOF'
Usage: scripts/ops/health.sh [options]

Options:
  --manifest PATH          Load expected version/SHA and image references
  --env-file PATH          Environment file (default: .env)
  --timeout SECONDS        Health polling timeout (default: 120)
  --expected-version VALUE Require this ProxyHub version
  --expected-sha VALUE     Require this full Git SHA
  --json                   Print machine-readable JSON only
  --help                   Show this help
EOF
}

result() {
  local id="$1"
  local status="$2"
  local message="$3"
  RESULTS="$(
    jq -c --arg id "$id" --arg status "$status" --arg message "$message" \
      '. + [{id:$id,status:$status,message:$message}]' <<<"$RESULTS"
  )"
  [[ "$OPS_JSON" == "true" ]] || printf '%-28s %-5s %s\n' "$id" "$status" "$message"
}

while (($#)); do
  case "$1" in
    --manifest) MANIFEST="${2:?Missing value for --manifest}"; shift 2 ;;
    --env-file) PROXYHUB_ENV_FILE="${2:?Missing value for --env-file}"; shift 2 ;;
    --timeout) TIMEOUT="${2:?Missing value for --timeout}"; shift 2 ;;
    --expected-version) EXPECTED_VERSION="${2:?Missing value for --expected-version}"; shift 2 ;;
    --expected-sha) EXPECTED_SHA="${2:?Missing value for --expected-sha}"; shift 2 ;;
    --json) OPS_JSON=true; shift ;;
    --help) usage; exit 0 ;;
    *) ops_die OPS_ARGUMENT_INVALID "Unknown argument: $1" ;;
  esac
done

ops_require_command jq
ops_require_command docker
ops_require_command curl
[[ "$TIMEOUT" =~ ^[1-9][0-9]*$ ]] || ops_die OPS_ARGUMENT_INVALID "Timeout must be positive"

if [[ -n "$MANIFEST" ]]; then
  ops_manifest_validate "$MANIFEST" true
  ops_manifest_export_images "$MANIFEST"
  [[ -n "$EXPECTED_VERSION" ]] || EXPECTED_VERSION="$(jq -r '.version' "$MANIFEST")"
  [[ -n "$EXPECTED_SHA" ]] || EXPECTED_SHA="$(jq -r '.gitSha' "$MANIFEST")"
elif [[ -f "$PROXYHUB_STATE_DIR/releases/current.json" ]]; then
  state_manifest="$(jq -r '.manifestPath' "$PROXYHUB_STATE_DIR/releases/current.json")"
  if [[ -f "$state_manifest" ]]; then
    ops_manifest_export_images "$state_manifest"
  fi
fi

services=(proxyhub-web proxyhub-server proxyhub-agent xray caddy)
deadline=$((SECONDS + TIMEOUT))
all_ready=false
while ((SECONDS < deadline)); do
  all_ready=true
  for service in "${services[@]}"; do
    container_id="$(ops_compose ps -q --all "$service" 2>/dev/null || true)"
    if [[ -z "$container_id" ]]; then
      all_ready=false
      continue
    fi
    state="$(docker inspect --format '{{.State.Status}}' "$container_id" 2>/dev/null || printf missing)"
    health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$container_id" 2>/dev/null || printf missing)"
    if [[ "$state" == "exited" || "$state" == "dead" ]]; then
      break 2
    fi
    [[ "$state" == "running" && "$health" == "healthy" ]] || all_ready=false
  done
  [[ "$all_ready" == "true" ]] && break
  sleep 2
done

for service in "${services[@]}"; do
  container_id="$(ops_compose ps -q --all "$service" 2>/dev/null || true)"
  if [[ -z "$container_id" ]]; then
    result "service:$service" FAIL "Container is missing"
    continue
  fi
  state="$(docker inspect --format '{{.State.Status}}' "$container_id" 2>/dev/null || printf missing)"
  health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$container_id" 2>/dev/null || printf missing)"
  restarts="$(docker inspect --format '{{.RestartCount}}' "$container_id" 2>/dev/null || printf unknown)"
  if [[ "$state" == "running" && "$health" == "healthy" && "$restarts" == "0" ]]; then
    result "service:$service" PASS "running, healthy, restartCount=0"
  else
    result "service:$service" FAIL "state=$state health=$health restartCount=$restarts"
  fi
done

health_payload="$(
  ops_compose exec -T proxyhub-server node -e \
    "fetch('http://127.0.0.1:3000/api/health').then(async r=>{const b=await r.text();if(!r.ok)process.exit(2);process.stdout.write(b)}).catch(()=>process.exit(3))" \
    2>/dev/null || true
)"
if jq -e '.success == true and .data.status == "ok"' >/dev/null 2>&1 <<<"$health_payload"; then
  result server-api PASS "Server health endpoint returned ok"
else
  result server-api FAIL "Server health endpoint is unavailable or invalid"
fi

actual_version="$(jq -r '.data.version // empty' <<<"$health_payload" 2>/dev/null || true)"
actual_sha="$(jq -r '.data.gitSha // empty' <<<"$health_payload" 2>/dev/null || true)"
if [[ -z "$EXPECTED_VERSION" || "$actual_version" == "$EXPECTED_VERSION" ]]; then
  result release-version PASS "Version ${actual_version:-not constrained}"
else
  result release-version FAIL "Expected $EXPECTED_VERSION but received ${actual_version:-missing}"
fi
if [[ -z "$EXPECTED_SHA" || "$actual_sha" == "$EXPECTED_SHA" ]]; then
  result release-sha PASS "Git SHA ${actual_sha:-not constrained}"
else
  result release-sha FAIL "Expected $EXPECTED_SHA but received ${actual_sha:-missing}"
fi

agent_ok="$(
  ops_compose exec -T proxyhub-agent node -e \
    "fetch('http://127.0.0.1:3001/status',{headers:{authorization:'Bearer '+process.env.AGENT_TOKEN}}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" \
    >/dev/null 2>&1 && printf true || printf false
)"
[[ "$agent_ok" == "true" ]] &&
  result agent-api PASS "Agent status endpoint is healthy" ||
  result agent-api FAIL "Agent status endpoint failed"

ops_compose exec -T xray xray run -test -config /etc/xray/config.json >/dev/null 2>&1 &&
  result xray-config PASS "Xray active configuration is valid" ||
  result xray-config FAIL "Xray active configuration validation failed"

ops_compose exec -T caddy caddy validate --config /etc/caddy/Caddyfile >/dev/null 2>&1 &&
  result caddy-config PASS "Caddy configuration is valid" ||
  result caddy-config FAIL "Caddy configuration validation failed"

panel_domain="$(sed -n 's/^PANEL_DOMAIN=//p' "$PROXYHUB_ENV_FILE" | head -n1)"
if [[ "$panel_domain" == "localhost" ]]; then
  https_url=https://localhost/api/health
  curl_arguments=(-ksSf)
else
  https_url="https://$panel_domain/api/health"
  curl_arguments=(-sSf)
fi
if curl "${curl_arguments[@]}" --max-time 15 "$https_url" |
  jq -e '.success == true and .data.status == "ok"' >/dev/null 2>&1; then
  result https PASS "Caddy HTTPS route returned Server health"
else
  result https FAIL "Caddy HTTPS route is unavailable"
fi

ops_compose exec -T proxyhub-server pnpm --filter @proxyhub/server exec prisma migrate status \
  >/dev/null 2>&1 &&
  result database-migrations PASS "Database migrations are healthy" ||
  result database-migrations FAIL "Database migration status is unhealthy"

failures="$(jq '[.[] | select(.status == "FAIL")] | length' <<<"$RESULTS")"
if [[ "$OPS_JSON" == "true" ]]; then
  jq -cn --argjson checks "$RESULTS" --argjson failures "$failures" \
    '{success:($failures == 0),failures:$failures,checks:$checks}'
fi
((failures == 0)) || exit 1
