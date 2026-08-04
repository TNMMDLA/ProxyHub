#!/usr/bin/env bash

if [[ -n "${PROXYHUB_OPS_COMMON_LOADED:-}" ]]; then
  return 0
fi
readonly PROXYHUB_OPS_COMMON_LOADED=1
OPS_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
readonly OPS_ROOT

# shellcheck source=verification.sh
source "$OPS_ROOT/scripts/ops/lib/verification.sh"

: "${PROXYHUB_STATE_DIR:=$OPS_ROOT/.proxyhub/state}"
: "${PROXYHUB_BACKUP_DIR:=$OPS_ROOT/backups}"
: "${PROXYHUB_ENV_FILE:=$OPS_ROOT/.env}"
: "${PROXYHUB_COMPOSE_PROJECT:=${COMPOSE_PROJECT_NAME:-proxyhub}}"
: "${PROXYHUB_COMPOSE_FILE:=$OPS_ROOT/docker-compose.yml}"
: "${PROXYHUB_RELEASE_COMPOSE_FILE:=$OPS_ROOT/docker-compose.release.yml}"

OPS_DRY_RUN="${OPS_DRY_RUN:-false}"
OPS_JSON="${OPS_JSON:-false}"
OPS_YES="${OPS_YES:-false}"
OPS_LOCK_HELD=false
OPS_LOCK_METADATA="$PROXYHUB_STATE_DIR/locks/operation.json"
OPS_LOCK_FILE="$PROXYHUB_STATE_DIR/locks/operation.lock"

ops_refresh_paths() {
  OPS_LOCK_METADATA="$PROXYHUB_STATE_DIR/locks/operation.json"
  OPS_LOCK_FILE="$PROXYHUB_STATE_DIR/locks/operation.lock"
}

ops_timestamp() {
  date -u +%Y-%m-%dT%H:%M:%SZ
}

ops_redact() {
  sed -E \
    -e 's/((TOKEN|SECRET|PASSWORD|ENCRYPTION_KEY|AUTHORIZATION)[=:][[:space:]]*)[^[:space:]]+/\1[REDACTED]/Ig' \
    -e 's#(https?://)[^/@[:space:]]+:[^/@[:space:]]+@#\1[REDACTED]@#g' \
    -e 's/(Bearer[[:space:]]+)[A-Za-z0-9._~+\/=-]+/\1[REDACTED]/Ig'
}

ops_log() {
  local level="$1"
  shift
  if [[ "$OPS_JSON" != "true" ]]; then
    printf '%s [%s] %s\n' "$(ops_timestamp)" "$level" "$*" >&2
  fi
}

ops_die() {
  local code="$1"
  shift
  if [[ "$OPS_JSON" == "true" ]]; then
    jq -cn --arg code "$code" --arg message "$*" \
      '{success:false,error:{code:$code,message:$message}}'
  else
    ops_log ERROR "$code: $*"
  fi
  exit 1
}

ops_require_command() {
  command -v "$1" >/dev/null 2>&1 || ops_die OPS_PREREQUISITE_MISSING "Required command not found: $1"
}

ops_secure_directory() {
  local directory="$1"
  mkdir -p -- "$directory"
  chmod 0700 -- "$directory"
}

ops_atomic_write() {
  local target="$1"
  local directory temporary
  directory="$(dirname "$target")"
  ops_secure_directory "$directory"
  temporary="$(mktemp "$directory/.atomic.XXXXXX")"
  chmod 0600 "$temporary"
  cat >"$temporary"
  sync -f "$temporary" 2>/dev/null || sync "$temporary" 2>/dev/null || true
  mv -f -- "$temporary" "$target"
  sync -f "$directory" 2>/dev/null || true
}

ops_json_write() {
  local target="$1"
  local content="$2"
  jq -e . >/dev/null 2>&1 <<<"$content" ||
    ops_die OPS_STATE_INVALID "Refusing to write invalid JSON to $target"
  ops_atomic_write "$target" <<<"$content"
}

ops_lock_release() {
  if [[ "$OPS_LOCK_HELD" == "true" ]]; then
    rm -f -- "$OPS_LOCK_METADATA"
    flock -u 9 || true
    exec 9>&-
    OPS_LOCK_HELD=false
  fi
}

ops_lock_acquire() {
  local operation="$1"
  ops_require_command flock
  ops_require_command jq
  ops_secure_directory "$PROXYHUB_STATE_DIR"
  ops_secure_directory "$PROXYHUB_STATE_DIR/locks"
  exec 9>"$OPS_LOCK_FILE"
  if ! flock -n 9; then
    local owner="unknown"
    if [[ -f "$OPS_LOCK_METADATA" ]]; then
      owner="$(jq -r '"\(.operation // "unknown") pid=\(.pid // "unknown") since=\(.startedAt // "unknown")"' "$OPS_LOCK_METADATA" 2>/dev/null || printf unknown)"
    fi
    exec 9>&-
    ops_die PROXYHUB_OPERATION_BUSY "Another ProxyHub operation holds the global lock ($owner)"
  fi
  OPS_LOCK_HELD=true
  ops_json_write "$OPS_LOCK_METADATA" "$(
    jq -cn \
      --arg operation "$operation" \
      --argjson pid "$$" \
      --arg startedAt "$(ops_timestamp)" \
      '{operation:$operation,pid:$pid,startedAt:$startedAt}'
  )"
  trap ops_lock_release EXIT
}

ops_lock_check_read_only() {
  if [[ ! -e "$OPS_LOCK_FILE" ]]; then
    return 0
  fi
  exec 8<"$OPS_LOCK_FILE"
  if ! flock -n 8; then
    exec 8>&-
    ops_die PROXYHUB_OPERATION_BUSY "Another ProxyHub operation holds the global lock"
  fi
  flock -u 8 || true
  exec 8>&-
}

ops_require_inherited_lock() {
  [[ "${PROXYHUB_PARENT_LOCK:-}" == "true" ]] ||
    ops_die OPS_LOCK_REQUIRED "An inherited update/rollback lock is required"
  [[ -f "$OPS_LOCK_METADATA" ]] ||
    ops_die OPS_LOCK_REQUIRED "Global lock metadata is missing"
  local owner expected_owner
  owner="$(jq -r '.pid // 0' "$OPS_LOCK_METADATA")"
  expected_owner="${PROXYHUB_LOCK_OWNER_PID:-$PPID}"
  [[ "$owner" == "$expected_owner" ]] ||
    ops_die OPS_LOCK_REQUIRED "Global lock is not owned by the parent operation"
  kill -0 "$owner" 2>/dev/null ||
    ops_die OPS_LOCK_REQUIRED "Global lock owner process is no longer running"
}

ops_manifest_validate() {
  local manifest="$1"
  local require_digests="${2:-true}"
  [[ -f "$manifest" ]] || ops_die OPS_MANIFEST_NOT_FOUND "Release manifest not found: $manifest"
  jq -e '
    .schemaVersion == 1 and
    (.releaseId | type == "string" and length > 2) and
    (.version | test("^\\d+\\.\\d+\\.\\d+(-[0-9A-Za-z.-]+)?$")) and
    (.gitSha | test("^[0-9a-f]{40}$")) and
    .gitShortSha == (.gitSha[0:12]) and
    (.buildTime | type == "string") and
    (.xrayVersion | test("^\\d+\\.\\d+\\.\\d+$")) and
    (.databaseMigrationFingerprint | test("^[0-9a-f]{64}$")) and
    (.images | keys | sort) == ["agent","server","web","xray"] and
    ([.images[] | (.repository | type == "string" and length > 3) and
      (.tag | type == "string" and length > 0) and
      (.digest == null or (.digest | test("^sha256:[0-9a-f]{64}$")))] | all)
  ' "$manifest" >/dev/null ||
    ops_die OPS_MANIFEST_INVALID "Release manifest failed structural validation"
  if [[ "$require_digests" == "true" ]] &&
    ! jq -e '[.images[].digest | type == "string"] | all' "$manifest" >/dev/null; then
    ops_die OPS_MANIFEST_DIGEST_REQUIRED "Release operations require all image digests"
  fi
  if jq -e '.. | objects | keys[] | select(test("secret|password|token|encryption.?key|private.?key"; "i"))' \
    "$manifest" >/dev/null; then
    ops_die OPS_MANIFEST_SECRET_FIELD "Release manifest contains a forbidden secret-like field"
  fi
}

ops_manifest_export_images() {
  local manifest="$1"
  export PROXYHUB_WEB_IMAGE
  export PROXYHUB_SERVER_IMAGE
  export PROXYHUB_AGENT_IMAGE
  export PROXYHUB_XRAY_IMAGE
  PROXYHUB_WEB_IMAGE="$(jq -r '.images.web.repository + "@" + .images.web.digest' "$manifest")"
  PROXYHUB_SERVER_IMAGE="$(jq -r '.images.server.repository + "@" + .images.server.digest' "$manifest")"
  PROXYHUB_AGENT_IMAGE="$(jq -r '.images.agent.repository + "@" + .images.agent.digest' "$manifest")"
  PROXYHUB_XRAY_IMAGE="$(jq -r '.images.xray.repository + "@" + .images.xray.digest' "$manifest")"
}

ops_compose() {
  docker compose \
    --project-name "$PROXYHUB_COMPOSE_PROJECT" \
    --env-file "$PROXYHUB_ENV_FILE" \
    -f "$PROXYHUB_COMPOSE_FILE" \
    -f "$PROXYHUB_RELEASE_COMPOSE_FILE" \
    "$@"
}

ops_start_runtime_services() {
  local xray_container_id agent_container_id agent_pid_mode
  ops_compose up -d --no-deps xray
  xray_container_id="$(proxyhub_compose_service_container_id ops_compose xray)" ||
    ops_die OPS_CONTAINER_NOT_FOUND "Xray service did not resolve to exactly one container"

  ops_compose up -d --no-deps --force-recreate proxyhub-agent
  agent_container_id="$(proxyhub_compose_service_container_id ops_compose proxyhub-agent)" ||
    ops_die OPS_CONTAINER_NOT_FOUND "Agent service did not resolve to exactly one container"
  agent_pid_mode="$(docker inspect --format '{{.HostConfig.PidMode}}' "$agent_container_id")"
  [[ "$agent_pid_mode" == "container:$xray_container_id" ]] ||
    ops_die OPS_AGENT_PID_NAMESPACE_MISMATCH \
      "Agent PID namespace does not reference the current Xray service container"

  ops_compose up -d --remove-orphans proxyhub-server proxyhub-web caddy
}

ops_capture_diagnostics() {
  local transaction_id="$1"
  local directory="$PROXYHUB_STATE_DIR/diagnostics/$transaction_id"
  ops_secure_directory "$directory"
  ops_compose ps --all >"$directory/compose-ps.txt" 2>&1 || true
  ops_compose logs --no-color --tail=300 >"$directory/compose.log" 2>&1 || true
  {
    printf 'capturedAt=%s\n' "$(ops_timestamp)"
    printf 'transactionId=%s\n' "$transaction_id"
    printf 'host=%s\n' "$(hostname)"
  } >"$directory/context.txt"
  chmod 0600 "$directory"/*
  ops_log INFO "Diagnostics captured at $directory"
}

ops_confirm() {
  local prompt="$1"
  if [[ "$OPS_YES" == "true" ]]; then
    return 0
  fi
  [[ -t 0 ]] || ops_die OPS_CONFIRMATION_REQUIRED "Use --yes for non-interactive execution"
  read -r -p "$prompt [y/N] " answer
  [[ "$answer" =~ ^[Yy]$ ]] || ops_die OPS_CANCELLED "Operation cancelled"
}

ops_semver_core() {
  sed -E 's/-.*$//' <<<"$1"
}

ops_semver_compare() {
  local left right first
  left="$(ops_semver_core "$1")"
  right="$(ops_semver_core "$2")"
  if [[ "$left" == "$right" ]]; then
    printf '0\n'
    return
  fi
  first="$(printf '%s\n%s\n' "$left" "$right" | sort -V | head -n1)"
  [[ "$first" == "$left" ]] && printf '%s\n' '-1' || printf '1\n'
}
