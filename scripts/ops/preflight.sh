#!/usr/bin/env bash
set -Eeuo pipefail

# shellcheck source=lib/common.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/common.sh"

MANIFEST=""
ALLOW_LOW_RESOURCES=false
LIST_CHECKS=false
OPS_RESULTS='[]'

usage() {
  cat <<'EOF'
Usage: scripts/ops/preflight.sh --manifest <release-manifest.json> [options]

Read-only production readiness checks.

Options:
  --manifest PATH         Release manifest to validate
  --env-file PATH         Environment file (default: .env)
  --allow-low-resources   Override disk/RAM hard stops
  --dry-run               Explicit read-only mode (preflight is always read-only)
  --json                  Print machine-readable JSON only
  --list-checks           List stable check identifiers
  --help                  Show this help
EOF
}

check_result() {
  local id="$1"
  local status="$2"
  local message="$3"
  OPS_RESULTS="$(
    jq -c \
      --arg id "$id" \
      --arg status "$status" \
      --arg message "$message" \
      '. + [{id:$id,status:$status,message:$message}]' <<<"$OPS_RESULTS"
  )"
  [[ "$OPS_JSON" == "true" ]] || printf '%-34s %-5s %s\n' "$id" "$status" "$message"
}

pass() { check_result "$1" PASS "$2"; }
warn() { check_result "$1" WARN "$2"; }
fail() { check_result "$1" FAIL "$2"; }

readonly CHECK_IDS=(
  linux architecture docker-cli docker-daemon docker-compose git curl sha256sum tar gzip flock
  jq sqlite3 disk memory swap project-path state-path backup-path env-file required-environment
  compose-config release-manifest image-reference image-access database-access migration-status
  caddy-config xray-version ports dns domain
)

while (($#)); do
  case "$1" in
    --manifest) MANIFEST="${2:?Missing value for --manifest}"; shift 2 ;;
    --env-file) PROXYHUB_ENV_FILE="${2:?Missing value for --env-file}"; shift 2 ;;
    --allow-low-resources) ALLOW_LOW_RESOURCES=true; shift ;;
    --dry-run) OPS_DRY_RUN=true; shift ;;
    --json) OPS_JSON=true; shift ;;
    --list-checks) LIST_CHECKS=true; shift ;;
    --help) usage; exit 0 ;;
    *) ops_die OPS_ARGUMENT_INVALID "Unknown argument: $1" ;;
  esac
done

if [[ "$LIST_CHECKS" == "true" ]]; then
  printf '%s\n' "${CHECK_IDS[@]}"
  exit 0
fi

command -v jq >/dev/null 2>&1 ||
  ops_die OPS_PREREQUISITE_MISSING "jq is required to format preflight results"
if [[ "${PROXYHUB_PARENT_LOCK:-}" == "true" ]]; then
  ops_require_inherited_lock
else
  ops_lock_check_read_only
fi

[[ "$(uname -s 2>/dev/null || true)" == "Linux" ]] &&
  pass linux "Linux host detected" ||
  fail linux "Production operations require Linux"

architecture="$(uname -m 2>/dev/null || printf unknown)"
case "$architecture" in
  x86_64 | amd64 | aarch64 | arm64) pass architecture "Supported architecture: $architecture" ;;
  *) fail architecture "Unsupported architecture: $architecture" ;;
esac

for command in docker git curl sha256sum tar gzip flock jq sqlite3; do
  id="$command"
  [[ "$command" == "docker" ]] && id=docker-cli
  command -v "$command" >/dev/null 2>&1 &&
    pass "$id" "$command is available" ||
    fail "$id" "$command is required"
done

if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  pass docker-daemon "Docker daemon is reachable"
else
  fail docker-daemon "Docker daemon is not reachable"
fi
if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  pass docker-compose "Docker Compose plugin is available"
else
  fail docker-compose "Docker Compose plugin is required"
fi

available_kb="$(df -Pk "$OPS_ROOT" 2>/dev/null | awk 'NR==2 {print $4}' || printf 0)"
available_kb="${available_kb:-0}"
if ((available_kb < 1048576)); then
  [[ "$ALLOW_LOW_RESOURCES" == "true" ]] &&
    warn disk "Less than 1 GiB free; hard stop overridden" ||
    fail disk "At least 1 GiB free is required"
elif ((available_kb < 2097152)); then
  warn disk "Less than 2 GiB free; deployment may be constrained"
else
  pass disk "Disk space is sufficient"
fi

memory_kb="$(awk '/^MemTotal:/ {print $2}' /proc/meminfo 2>/dev/null || printf 0)"
memory_kb="${memory_kb:-0}"
if ((memory_kb < 524288)); then
  [[ "$ALLOW_LOW_RESOURCES" == "true" ]] &&
    warn memory "Less than 512 MiB RAM; hard stop overridden" ||
    fail memory "At least 512 MiB RAM is required"
elif ((memory_kb < 1048576)); then
  warn memory "Less than 1 GiB RAM; sequential low-resource mode will be used"
else
  pass memory "Memory is sufficient"
fi

swap_kb="$(awk '/^SwapTotal:/ {print $2}' /proc/meminfo 2>/dev/null || printf 0)"
swap_kb="${swap_kb:-0}"
((swap_kb > 0)) && pass swap "Swap is configured" || warn swap "No swap is configured"

[[ -d "$OPS_ROOT" && -r "$OPS_ROOT" ]] &&
  pass project-path "Project path is readable" ||
  fail project-path "Project path is not readable"
[[ -d "$PROXYHUB_STATE_DIR" ]] && [[ -w "$PROXYHUB_STATE_DIR" ]] &&
  pass state-path "State directory is writable" ||
  if [[ ! -e "$PROXYHUB_STATE_DIR" && -w "$(dirname "$PROXYHUB_STATE_DIR")" ]]; then
    pass state-path "State directory can be created"
  else
    fail state-path "State directory is not writable"
  fi
[[ -d "$PROXYHUB_BACKUP_DIR" ]] && [[ -w "$PROXYHUB_BACKUP_DIR" ]] &&
  pass backup-path "Backup directory is writable" ||
  if [[ ! -e "$PROXYHUB_BACKUP_DIR" && -w "$(dirname "$PROXYHUB_BACKUP_DIR")" ]]; then
    pass backup-path "Backup directory can be created"
  else
    fail backup-path "Backup directory is not writable"
  fi

if [[ -f "$PROXYHUB_ENV_FILE" && -r "$PROXYHUB_ENV_FILE" ]]; then
  pass env-file "Environment file is readable"
else
  fail env-file "Environment file is missing or unreadable"
fi

environment_valid=true
for key in ENCRYPTION_KEY AGENT_TOKEN PANEL_DOMAIN WEB_ORIGIN; do
  value="$(sed -n "s/^${key}=//p" "$PROXYHUB_ENV_FILE" 2>/dev/null | head -n1)"
  if [[ -z "$value" || "$value" == replace-with-* ]]; then
    environment_valid=false
  fi
done
[[ "$environment_valid" == "true" ]] &&
  pass required-environment "Required environment values are present" ||
  fail required-environment "Required environment values are missing or still placeholders"

manifest_valid=false
if [[ -n "$MANIFEST" ]] && (
  ops_manifest_validate "$MANIFEST" true
) >/dev/null 2>&1; then
  manifest_valid=true
  pass release-manifest "Release manifest is structurally valid"
else
  fail release-manifest "A valid digest-pinned release manifest is required"
fi

if [[ "$manifest_valid" == "true" ]]; then
  ops_manifest_export_images "$MANIFEST"
  if [[ "$(jq -r '[.images[].digest | startswith("sha256:")] | all' "$MANIFEST")" == "true" ]]; then
    pass image-reference "All release images are digest pinned"
  else
    fail image-reference "Every release image must be digest pinned"
  fi
  if [[ "${PROXYHUB_SKIP_REMOTE_IMAGE_CHECK:-false}" == "true" ]]; then
    warn image-access "Remote image access check skipped by explicit isolated-test override"
  else
    images_accessible=true
    while IFS= read -r image; do
      docker manifest inspect "$image" >/dev/null 2>&1 || images_accessible=false
    done < <(jq -r '.images[] | .repository + "@" + .digest' "$MANIFEST")
    [[ "$images_accessible" == "true" ]] &&
      pass image-access "All release images are accessible" ||
      fail image-access "One or more release images are not accessible"
  fi
else
  fail image-reference "Image references cannot be checked without a valid manifest"
  fail image-access "Image access cannot be checked without a valid manifest"
fi

if [[ "$manifest_valid" == "true" ]] &&
  ops_compose config --quiet >/dev/null 2>&1; then
  pass compose-config "Merged release Compose configuration is valid"
else
  fail compose-config "Merged release Compose configuration is invalid"
fi

server_id="$(proxyhub_compose_service_container_id ops_compose proxyhub-server true || true)"
if [[ -n "$server_id" ]] &&
  ops_compose exec -T proxyhub-server sh -c 'test -r /app/data/proxyhub.db && test -w /app/data/proxyhub.db' \
    >/dev/null 2>&1; then
  pass database-access "SQLite database is readable and writable"
else
  warn database-access "No running Server database was found; valid for a fresh deployment"
fi
if [[ -n "$server_id" ]] &&
  ops_compose exec -T proxyhub-server pnpm --filter @proxyhub/server exec prisma migrate status \
    >/dev/null 2>&1; then
  pass migration-status "Prisma migration state is healthy"
else
  warn migration-status "Migration status is unavailable before the Server is running"
fi

if ops_compose exec -T caddy caddy validate --config /etc/caddy/Caddyfile >/dev/null 2>&1; then
  pass caddy-config "Caddy configuration is valid"
else
  warn caddy-config "Caddy is not running or its configuration could not be validated"
fi

expected_xray="$(jq -r '.xrayVersion // empty' "$MANIFEST" 2>/dev/null || true)"
actual_xray="$(ops_compose exec -T xray xray version 2>/dev/null | head -n1 || true)"
if [[ -n "$actual_xray" && "$actual_xray" == *"$expected_xray"* ]]; then
  pass xray-version "Xray $expected_xray is active"
else
  warn xray-version "Xray version cannot be confirmed before services are running"
fi

if command -v ss >/dev/null 2>&1; then
  pass ports "Host port inspection is available"
else
  warn ports "ss is unavailable; port conflicts require manual verification"
fi

panel_domain="$(sed -n 's/^PANEL_DOMAIN=//p' "$PROXYHUB_ENV_FILE" 2>/dev/null | head -n1)"
if [[ "$panel_domain" =~ ^([A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)*[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?$ ]]; then
  pass domain "Panel domain syntax is valid"
else
  fail domain "PANEL_DOMAIN has invalid syntax"
fi
if [[ "$panel_domain" == "localhost" ]] || getent ahosts "$panel_domain" >/dev/null 2>&1; then
  pass dns "Panel domain resolves"
else
  fail dns "Panel domain does not resolve"
fi

failures="$(jq '[.[] | select(.status == "FAIL")] | length' <<<"$OPS_RESULTS")"
warnings="$(jq '[.[] | select(.status == "WARN")] | length' <<<"$OPS_RESULTS")"
if [[ "$OPS_JSON" == "true" ]]; then
  jq -cn \
    --argjson checks "$OPS_RESULTS" \
    --argjson failures "$failures" \
    --argjson warnings "$warnings" \
    '{success:($failures == 0),summary:{failures:$failures,warnings:$warnings},checks:$checks}'
fi
((failures == 0)) || exit 1
