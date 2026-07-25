#!/usr/bin/env bash
set -Eeuo pipefail

# shellcheck source=lib/common.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/common.sh"

TARGET=previous
TRANSACTION_ID=""
ACTIVE=false
CURRENT_MANIFEST=""

usage() {
  cat <<'EOF'
Usage: scripts/ops/rollback.sh [options]

Rolls back images and Compose state to an immutable prior release. Automatic database
restore is deliberately refused when migration fingerprints differ.

Options:
  --to RELEASE_ID         Target release history ID (default: previous)
  --env-file PATH         Environment file
  --state-dir PATH        Operation state directory
  --backup-dir PATH       Backup directory
  --dry-run               Validate only; make no mutation
  --json                  Print machine-readable final result
  --yes                   Allow non-interactive rollback
  --help                  Show this help
EOF
}

while (($#)); do
  case "$1" in
    --to) TARGET="${2:?Missing value for --to}"; shift 2 ;;
    --env-file) PROXYHUB_ENV_FILE="${2:?Missing value for --env-file}"; shift 2 ;;
    --state-dir) PROXYHUB_STATE_DIR="${2:?Missing value for --state-dir}"; shift 2 ;;
    --backup-dir) PROXYHUB_BACKUP_DIR="${2:?Missing value for --backup-dir}"; shift 2 ;;
    --dry-run) OPS_DRY_RUN=true; shift ;;
    --json) OPS_JSON=true; shift ;;
    --yes) OPS_YES=true; shift ;;
    --help) usage; exit 0 ;;
    *) ops_die OPS_ARGUMENT_INVALID "Unknown argument: $1" ;;
  esac
done

ops_refresh_paths
# shellcheck source=lib/state.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/state.sh"
[[ -f "$OPS_CURRENT_STATE" ]] || ops_die OPS_RELEASE_STATE_MISSING "Current release state is missing"
target_state="$(ops_release_history_target "$TARGET")"
[[ -n "$target_state" && -f "$target_state" ]] ||
  ops_die OPS_ROLLBACK_TARGET_NOT_FOUND "Rollback target was not found: $TARGET"
target_manifest="$(jq -r '.manifestPath' "$target_state")"
CURRENT_MANIFEST="$(jq -r '.manifestPath' "$OPS_CURRENT_STATE")"
ops_manifest_validate "$target_manifest" true
ops_manifest_validate "$CURRENT_MANIFEST" true
[[ "$(jq -r '.releaseId' "$target_state")" != "$(jq -r '.releaseId' "$OPS_CURRENT_STATE")" ]] ||
  ops_die OPS_ROLLBACK_SAME_RELEASE "Rollback target is already active"
current_fingerprint="$(jq -r '.databaseMigrationFingerprint' "$OPS_CURRENT_STATE")"
target_fingerprint="$(jq -r '.databaseMigrationFingerprint' "$target_state")"
[[ "$current_fingerprint" == "$target_fingerprint" ]] ||
  ops_die OPS_ROLLBACK_SCHEMA_INCOMPATIBLE \
    "Migration fingerprint differs; verified manual database restore is required"

if [[ "$OPS_DRY_RUN" == "true" ]]; then
  ops_lock_check_read_only
  [[ "$OPS_JSON" == "true" ]] &&
    jq -cn --arg target "$(jq -r '.releaseId' "$target_state")" \
      '{success:true,dryRun:true,operation:"rollback",targetReleaseId:$target,mutations:[]}' ||
    ops_log INFO "DRY RUN: rollback target is compatible; no mutations performed"
  exit 0
fi

restore_current_on_failure() {
  local exit_code=$?
  trap - ERR
  if [[ "$ACTIVE" == "true" && -n "$TRANSACTION_ID" ]]; then
    ops_capture_diagnostics "$TRANSACTION_ID" || true
    ops_manifest_export_images "$CURRENT_MANIFEST"
    if ops_compose up -d --remove-orphans &&
      "$OPS_ROOT/scripts/ops/health.sh" \
        --manifest "$CURRENT_MANIFEST" \
        --env-file "$PROXYHUB_ENV_FILE" \
        --timeout 180 >/dev/null; then
      ops_transaction_stage "$TRANSACTION_ID" ROLLBACK_FAILED || true
    else
      ops_transaction_fail "$TRANSACTION_ID" OPS_ROLLBACK_FAILED || true
    fi
  fi
  exit "$exit_code"
}
trap restore_current_on_failure ERR

ops_lock_acquire rollback
export PROXYHUB_PARENT_LOCK=true PROXYHUB_LOCK_OWNER_PID=$$
ops_confirm "Rollback to $(jq -r '.releaseId' "$target_state")?"
ops_state_prepare
TRANSACTION_ID="$(date -u +%Y%m%dT%H%M%SZ)-rollback-$(jq -r '.gitSha[0:12]' "$target_state")"
ops_transaction_start "$TRANSACTION_ID" rollback "$target_manifest"
ACTIVE=true
ops_transaction_stage "$TRANSACTION_ID" LOCKED
ops_transaction_stage "$TRANSACTION_ID" PREFLIGHT_PASSED
backup_path="$(
  PROXYHUB_PARENT_LOCK=true PROXYHUB_LOCK_OWNER_PID=$$ \
    "$OPS_ROOT/scripts/ops/backup.sh" create \
    --state-dir "$PROXYHUB_STATE_DIR" \
    --backup-dir "$PROXYHUB_BACKUP_DIR" \
    --env-file "$PROXYHUB_ENV_FILE"
)"
ops_transaction_set "$TRANSACTION_ID" '.backupPath=$value' "$backup_path"
ops_transaction_stage "$TRANSACTION_ID" BACKUP_CREATED
ops_manifest_export_images "$target_manifest"
ops_transaction_stage "$TRANSACTION_ID" RELEASE_VALIDATED
for service in proxyhub-web proxyhub-server proxyhub-agent xray; do
  ops_compose pull "$service"
done
ops_transaction_stage "$TRANSACTION_ID" IMAGES_PULLED
ops_transaction_stage "$TRANSACTION_ID" MIGRATION_VALIDATED
ops_transaction_stage "$TRANSACTION_ID" ROLLBACK_STARTED
ops_compose up -d --remove-orphans
ops_transaction_stage "$TRANSACTION_ID" SERVICES_STARTED
"$OPS_ROOT/scripts/ops/health.sh" \
  --manifest "$target_manifest" \
  --env-file "$PROXYHUB_ENV_FILE" \
  --timeout 180 >/dev/null
ops_transaction_stage "$TRANSACTION_ID" HEALTH_VERIFIED
ops_release_state_commit "$target_manifest" "$TRANSACTION_ID"
ops_transaction_stage "$TRANSACTION_ID" ROLLED_BACK
ops_transaction_stage "$TRANSACTION_ID" RELEASE_COMMITTED
ACTIVE=false

if [[ "$OPS_JSON" == "true" ]]; then
  jq -cn \
    --arg transactionId "$TRANSACTION_ID" \
    --arg releaseId "$(jq -r '.releaseId' "$target_state")" \
    --arg backup "$backup_path" \
    '{success:true,operation:"rollback",transactionId:$transactionId,releaseId:$releaseId,backup:$backup}'
else
  ops_log INFO "Rollback committed: $(jq -r '.releaseId' "$target_state")"
fi
