#!/usr/bin/env bash
set -Eeuo pipefail

# shellcheck source=lib/common.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/common.sh"

MANIFEST=""
ALLOW_DOWNGRADE=false
ALLOW_LOW_RESOURCES=false
TRANSACTION_ID=""
ACTIVE=false
PREVIOUS_STATE=""
OLD_MANIFEST=""
NEW_FINGERPRINT=""
OLD_FINGERPRINT=""

usage() {
  cat <<'EOF'
Usage: scripts/ops/update.sh --manifest <release-manifest.json> [options]

Transactional update: lock, preflight, consistent backup, immutable pull, migration,
health verification and release commit. A same-version or downgrade update is blocked by default.

Options:
  --manifest PATH         Required target release manifest
  --env-file PATH         Environment file
  --state-dir PATH        Operation state directory
  --backup-dir PATH       Backup directory
  --allow-downgrade       Permit lower semantic version after schema checks
  --allow-low-resources   Override documented disk/RAM hard stops
  --dry-run               Validate only; make no mutation
  --json                  Print machine-readable final result
  --yes                   Allow non-interactive update
  --help                  Show this help
EOF
}

while (($#)); do
  case "$1" in
    --manifest) MANIFEST="${2:?Missing value for --manifest}"; shift 2 ;;
    --env-file) PROXYHUB_ENV_FILE="${2:?Missing value for --env-file}"; shift 2 ;;
    --state-dir) PROXYHUB_STATE_DIR="${2:?Missing value for --state-dir}"; shift 2 ;;
    --backup-dir) PROXYHUB_BACKUP_DIR="${2:?Missing value for --backup-dir}"; shift 2 ;;
    --allow-downgrade) ALLOW_DOWNGRADE=true; shift ;;
    --allow-low-resources) ALLOW_LOW_RESOURCES=true; shift ;;
    --dry-run) OPS_DRY_RUN=true; shift ;;
    --json) OPS_JSON=true; shift ;;
    --yes) OPS_YES=true; shift ;;
    --help) usage; exit 0 ;;
    *) ops_die OPS_ARGUMENT_INVALID "Unknown argument: $1" ;;
  esac
done

[[ -n "$MANIFEST" ]] || ops_die OPS_ARGUMENT_INVALID "update requires --manifest"
MANIFEST="$(realpath "$MANIFEST")"
ops_refresh_paths
# shellcheck source=lib/state.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/state.sh"

rollback_after_failure() {
  ops_transaction_stage "$TRANSACTION_ID" ROLLBACK_STARTED || true
  if [[ "$OLD_FINGERPRINT" != "$NEW_FINGERPRINT" ]]; then
    ops_transaction_set "$TRANSACTION_ID" \
      '.failureCode="OPS_DATABASE_RESTORE_MANUAL_REQUIRED"' \
      "OPS_DATABASE_RESTORE_MANUAL_REQUIRED" || true
    ops_transaction_stage "$TRANSACTION_ID" ROLLBACK_FAILED || true
    ops_compose stop proxyhub-web proxyhub-server proxyhub-agent xray caddy >/dev/null 2>&1 || true
    ops_log ERROR "Database migrations changed; automatic DB restore is intentionally refused"
    return 1
  fi
  ops_manifest_export_images "$OLD_MANIFEST"
  if ops_compose up -d --remove-orphans &&
    "$OPS_ROOT/scripts/ops/health.sh" \
      --manifest "$OLD_MANIFEST" \
      --env-file "$PROXYHUB_ENV_FILE" \
      --timeout 180 >/dev/null; then
    ops_transaction_stage "$TRANSACTION_ID" ROLLED_BACK
    ops_log WARN "Failed update rolled back to the previous immutable release"
    return 0
  fi
  ops_transaction_stage "$TRANSACTION_ID" ROLLBACK_FAILED || true
  return 1
}

on_failure() {
  local exit_code=$?
  trap - ERR
  if [[ "$ACTIVE" == "true" && -n "$TRANSACTION_ID" ]]; then
    ops_transaction_fail "$TRANSACTION_ID" OPS_UPDATE_FAILED || true
    ops_capture_diagnostics "$TRANSACTION_ID" || true
    rollback_after_failure || true
  fi
  exit "$exit_code"
}
trap on_failure ERR

[[ -f "$OPS_CURRENT_STATE" ]] ||
  ops_die OPS_RELEASE_STATE_MISSING "A current release is required; use deploy for a fresh host"
ops_manifest_validate "$MANIFEST" true
current_version="$(jq -r '.version' "$OPS_CURRENT_STATE")"
target_version="$(jq -r '.version' "$MANIFEST")"
if [[ "$current_version" == "$target_version" ]]; then
  ops_die OPS_SAME_VERSION "Target version equals current version: $target_version"
fi
comparison="$(ops_semver_compare "$target_version" "$current_version")"
if [[ "$comparison" == "-1" && "$ALLOW_DOWNGRADE" != "true" ]]; then
  ops_die OPS_DOWNGRADE_BLOCKED "Downgrade from $current_version to $target_version requires --allow-downgrade"
fi

preflight_arguments=(--manifest "$MANIFEST" --env-file "$PROXYHUB_ENV_FILE")
[[ "$ALLOW_LOW_RESOURCES" == "true" ]] && preflight_arguments+=(--allow-low-resources)
if [[ "$OPS_DRY_RUN" == "true" ]]; then
  "$OPS_ROOT/scripts/ops/preflight.sh" "${preflight_arguments[@]}" --dry-run >/dev/null
  [[ "$OPS_JSON" == "true" ]] &&
    jq -cn --arg from "$current_version" --arg to "$target_version" \
      '{success:true,dryRun:true,operation:"update",fromVersion:$from,toVersion:$to,mutations:[]}' ||
    ops_log INFO "DRY RUN: update validation passed; no mutations performed"
  exit 0
fi

ops_lock_acquire update
export PROXYHUB_PARENT_LOCK=true PROXYHUB_LOCK_OWNER_PID=$$
"$OPS_ROOT/scripts/ops/preflight.sh" "${preflight_arguments[@]}" >/dev/null
ops_confirm "Update ProxyHub from $current_version to $target_version?"
ops_state_prepare
stored_manifest="$(ops_manifest_store "$MANIFEST")"
MANIFEST="$stored_manifest"
PREVIOUS_STATE="$OPS_TRANSACTIONS/previous-$(date -u +%Y%m%dT%H%M%SZ)-$$.json"
cp -- "$OPS_CURRENT_STATE" "$PREVIOUS_STATE"
chmod 0400 "$PREVIOUS_STATE"
OLD_MANIFEST="$(jq -r '.manifestPath' "$PREVIOUS_STATE")"
[[ -f "$OLD_MANIFEST" ]] || ops_die OPS_MANIFEST_NOT_FOUND "Previous release manifest is missing"
OLD_FINGERPRINT="$(jq -r '.databaseMigrationFingerprint' "$PREVIOUS_STATE")"
NEW_FINGERPRINT="$(jq -r '.databaseMigrationFingerprint' "$MANIFEST")"

TRANSACTION_ID="$(date -u +%Y%m%dT%H%M%SZ)-update-$(jq -r '.gitShortSha' "$MANIFEST")"
ops_transaction_start "$TRANSACTION_ID" update "$MANIFEST"
ACTIVE=true
ops_transaction_stage "$TRANSACTION_ID" LOCKED
ops_transaction_set "$TRANSACTION_ID" '.previousReleaseStatePath=$value' "$PREVIOUS_STATE"
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
ops_manifest_validate "$MANIFEST" true
ops_manifest_export_images "$MANIFEST"
ops_transaction_stage "$TRANSACTION_ID" RELEASE_VALIDATED

for service in proxyhub-web proxyhub-server proxyhub-agent xray; do
  ops_log INFO "Pulling $service sequentially"
  ops_compose pull "$service"
done
ops_transaction_stage "$TRANSACTION_ID" IMAGES_PULLED

ops_manifest_export_images "$OLD_MANIFEST"
ops_compose exec -T proxyhub-server pnpm --filter @proxyhub/server exec prisma migrate status \
  >/dev/null
ops_manifest_export_images "$MANIFEST"
ops_transaction_stage "$TRANSACTION_ID" MIGRATION_VALIDATED
ops_compose up -d proxyhub-server
ops_transaction_stage "$TRANSACTION_ID" MIGRATION_APPLIED
ops_compose up -d --remove-orphans
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
    --arg from "$current_version" \
    --arg to "$target_version" \
    --arg backup "$backup_path" \
    '{success:true,operation:"update",transactionId:$transactionId,fromVersion:$from,toVersion:$to,backup:$backup}'
else
  ops_log INFO "Update committed: $current_version -> $target_version"
fi
