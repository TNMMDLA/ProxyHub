#!/usr/bin/env bash
set -Eeuo pipefail

# shellcheck source=lib/common.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/common.sh"

MANIFEST=""
ALLOW_LOW_RESOURCES=false
TRANSACTION_ID=""
ACTIVE=false

usage() {
  cat <<'EOF'
Usage: scripts/ops/deploy.sh --manifest <release-manifest.json> [options]

Performs a fresh, digest-pinned image deployment. Existing data volumes are never deleted.

Options:
  --manifest PATH         Required release manifest
  --env-file PATH         Environment file (default: .env)
  --state-dir PATH        Operation state directory
  --backup-dir PATH       Backup directory
  --allow-low-resources   Override documented disk/RAM hard stops
  --dry-run               Validate only; no pull, container, database or state mutation
  --json                  Print machine-readable final result
  --yes                   Allow non-interactive deployment
  --help                  Show this help
EOF
}

while (($#)); do
  case "$1" in
    --manifest) MANIFEST="${2:?Missing value for --manifest}"; shift 2 ;;
    --env-file) PROXYHUB_ENV_FILE="${2:?Missing value for --env-file}"; shift 2 ;;
    --state-dir) PROXYHUB_STATE_DIR="${2:?Missing value for --state-dir}"; shift 2 ;;
    --backup-dir) PROXYHUB_BACKUP_DIR="${2:?Missing value for --backup-dir}"; shift 2 ;;
    --allow-low-resources) ALLOW_LOW_RESOURCES=true; shift ;;
    --dry-run) OPS_DRY_RUN=true; shift ;;
    --json) OPS_JSON=true; shift ;;
    --yes) OPS_YES=true; shift ;;
    --help) usage; exit 0 ;;
    *) ops_die OPS_ARGUMENT_INVALID "Unknown argument: $1" ;;
  esac
done

[[ -n "$MANIFEST" ]] || ops_die OPS_ARGUMENT_INVALID "deploy requires --manifest"
MANIFEST="$(realpath "$MANIFEST")"
ops_refresh_paths
# shellcheck source=lib/state.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/state.sh"

on_failure() {
  local exit_code=$?
  trap - ERR
  if [[ "$ACTIVE" == "true" && -n "$TRANSACTION_ID" ]]; then
    ops_transaction_fail "$TRANSACTION_ID" OPS_DEPLOY_FAILED || true
    ops_capture_diagnostics "$TRANSACTION_ID" || true
    ops_compose stop proxyhub-web proxyhub-server proxyhub-agent xray caddy >/dev/null 2>&1 || true
  fi
  exit "$exit_code"
}
trap on_failure ERR

preflight_arguments=(--manifest "$MANIFEST" --env-file "$PROXYHUB_ENV_FILE")
[[ "$ALLOW_LOW_RESOURCES" == "true" ]] && preflight_arguments+=(--allow-low-resources)

if [[ "$OPS_DRY_RUN" == "true" ]]; then
  "$OPS_ROOT/scripts/ops/preflight.sh" "${preflight_arguments[@]}" --dry-run >/dev/null
  [[ "$OPS_JSON" == "true" ]] &&
    jq -cn '{success:true,dryRun:true,operation:"deploy",mutations:[]}' ||
    ops_log INFO "DRY RUN: deploy validation passed; no state, images, containers or database changed"
  exit 0
fi

ops_lock_acquire deploy
export PROXYHUB_PARENT_LOCK=true PROXYHUB_LOCK_OWNER_PID=$$
"$OPS_ROOT/scripts/ops/preflight.sh" "${preflight_arguments[@]}" >/dev/null
ops_confirm "Deploy release $(jq -r '.releaseId' "$MANIFEST")?"

ops_state_prepare
stored_manifest="$(ops_manifest_store "$MANIFEST")"
MANIFEST="$stored_manifest"
ops_manifest_export_images "$MANIFEST"
TRANSACTION_ID="$(date -u +%Y%m%dT%H%M%SZ)-deploy-$(jq -r '.gitShortSha' "$MANIFEST")"
ops_transaction_start "$TRANSACTION_ID" deploy "$MANIFEST"
ACTIVE=true
ops_transaction_stage "$TRANSACTION_ID" LOCKED
ops_transaction_stage "$TRANSACTION_ID" PREFLIGHT_PASSED
ops_transaction_stage "$TRANSACTION_ID" RELEASE_VALIDATED

for service in proxyhub-web proxyhub-server proxyhub-agent xray; do
  ops_log INFO "Pulling $service sequentially"
  ops_compose pull "$service"
done
ops_transaction_stage "$TRANSACTION_ID" IMAGES_PULLED
for image in "$PROXYHUB_WEB_IMAGE" "$PROXYHUB_SERVER_IMAGE" "$PROXYHUB_AGENT_IMAGE" "$PROXYHUB_XRAY_IMAGE"; do
  docker image inspect "$image" >/dev/null
done

ops_transaction_stage "$TRANSACTION_ID" MIGRATION_VALIDATED
ops_compose up -d --remove-orphans
ops_transaction_stage "$TRANSACTION_ID" MIGRATION_APPLIED
ops_transaction_stage "$TRANSACTION_ID" SERVICES_STARTED
"$OPS_ROOT/scripts/ops/health.sh" \
  --manifest "$MANIFEST" \
  --env-file "$PROXYHUB_ENV_FILE" \
  --timeout 180 >/dev/null
ops_transaction_stage "$TRANSACTION_ID" HEALTH_VERIFIED
ops_release_state_commit "$MANIFEST" "$TRANSACTION_ID"
ops_transaction_stage "$TRANSACTION_ID" RELEASE_COMMITTED
ACTIVE=false

if [[ "$OPS_JSON" == "true" ]]; then
  jq -cn \
    --arg transactionId "$TRANSACTION_ID" \
    --arg releaseId "$(jq -r '.releaseId' "$MANIFEST")" \
    '{success:true,operation:"deploy",transactionId:$transactionId,releaseId:$releaseId}'
else
  ops_log INFO "Release deployed: $(jq -r '.releaseId' "$MANIFEST")"
fi
