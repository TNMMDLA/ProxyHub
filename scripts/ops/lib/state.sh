#!/usr/bin/env bash

# shellcheck source=common.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"

readonly OPS_CURRENT_STATE="$PROXYHUB_STATE_DIR/releases/current.json"
readonly OPS_RELEASE_HISTORY="$PROXYHUB_STATE_DIR/releases/history"
readonly OPS_TRANSACTIONS="$PROXYHUB_STATE_DIR/transactions"

ops_state_prepare() {
  ops_secure_directory "$PROXYHUB_STATE_DIR"
  ops_secure_directory "$PROXYHUB_STATE_DIR/releases"
  ops_secure_directory "$OPS_RELEASE_HISTORY"
  ops_secure_directory "$PROXYHUB_STATE_DIR/releases/manifests"
  ops_secure_directory "$OPS_TRANSACTIONS"
  ops_secure_directory "$PROXYHUB_STATE_DIR/diagnostics"
}

ops_manifest_store() {
  local manifest="$1"
  local release_id target
  release_id="$(jq -r '.releaseId' "$manifest")"
  target="$PROXYHUB_STATE_DIR/releases/manifests/$release_id.json"
  if [[ -f "$target" ]]; then
    cmp -s "$manifest" "$target" ||
      ops_die OPS_MANIFEST_IMMUTABLE "Stored release manifest differs for $release_id"
  else
    ops_atomic_write "$target" <"$manifest"
    chmod 0400 "$target"
  fi
  printf '%s\n' "$target"
}

ops_transaction_start() {
  local transaction_id="$1"
  local operation="$2"
  local manifest="$3"
  local previous_version previous_sha
  previous_version="$(jq -r '.version // null' "$OPS_CURRENT_STATE" 2>/dev/null || printf null)"
  previous_sha="$(jq -r '.gitSha // null' "$OPS_CURRENT_STATE" 2>/dev/null || printf null)"
  ops_json_write "$OPS_TRANSACTIONS/$transaction_id.json" "$(
    jq -n \
      --arg transactionId "$transaction_id" \
      --arg operation "$operation" \
      --argjson fromVersion "$(jq -cn --arg value "$previous_version" '$value | if . == "null" then null else . end')" \
      --argjson fromGitSha "$(jq -cn --arg value "$previous_sha" '$value | if . == "null" then null else . end')" \
      --arg toVersion "$(jq -r '.version' "$manifest")" \
      --arg toGitSha "$(jq -r '.gitSha' "$manifest")" \
      --arg startedAt "$(ops_timestamp)" \
      --arg manifestPath "$(realpath "$manifest")" \
      '{
        transactionId:$transactionId,
        operation:$operation,
        fromVersion:$fromVersion,
        toVersion:$toVersion,
        fromGitSha:$fromGitSha,
        toGitSha:$toGitSha,
        startedAt:$startedAt,
        updatedAt:$startedAt,
        currentStage:"INITIALIZED",
        backupPath:null,
        previousReleaseStatePath:null,
        newReleaseManifestPath:$manifestPath,
        failureCode:null,
        failureStage:null
      }'
  )"
}

ops_transaction_stage() {
  local transaction_id="$1"
  local stage="$2"
  local transaction="$OPS_TRANSACTIONS/$transaction_id.json"
  local temporary
  [[ -f "$transaction" ]] || ops_die OPS_TRANSACTION_NOT_FOUND "Transaction not found: $transaction_id"
  temporary="$(
    jq \
      --arg stage "$stage" \
      --arg updatedAt "$(ops_timestamp)" \
      '.currentStage=$stage | .updatedAt=$updatedAt' \
      "$transaction"
  )"
  ops_json_write "$transaction" "$temporary"
  ops_log INFO "Transaction $transaction_id entered $stage"
}

ops_transaction_set() {
  local transaction_id="$1"
  local expression="$2"
  local value="$3"
  local transaction="$OPS_TRANSACTIONS/$transaction_id.json"
  ops_json_write "$transaction" "$(
    jq --arg value "$value" --arg updatedAt "$(ops_timestamp)" \
      "$expression | .updatedAt=\$updatedAt" "$transaction"
  )"
}

ops_transaction_fail() {
  local transaction_id="$1"
  local code="$2"
  local transaction="$OPS_TRANSACTIONS/$transaction_id.json"
  local stage
  stage="$(jq -r '.currentStage' "$transaction")"
  ops_json_write "$transaction" "$(
    jq \
      --arg code "$code" \
      --arg stage "$stage" \
      --arg updatedAt "$(ops_timestamp)" \
      '.failureCode=$code | .failureStage=$stage | .currentStage="FAILED" | .updatedAt=$updatedAt' \
      "$transaction"
  )"
}

ops_release_state_commit() {
  local manifest="$1"
  local transaction_id="$2"
  local deployed_at
  deployed_at="$(ops_timestamp)"
  local content
  content="$(
    jq \
      --arg deployedAt "$deployed_at" \
      --arg transactionId "$transaction_id" \
      --arg manifestPath "$(realpath "$manifest")" \
      '{
        releaseId,
        version,
        gitSha,
        manifestPath:$manifestPath,
        deployMode,
        imageDigests:{
          web:.images.web.digest,
          server:.images.server.digest,
          agent:.images.agent.digest,
          xray:.images.xray.digest
        },
        databaseMigrationFingerprint,
        deployedAt:$deployedAt,
        transactionId:$transactionId
      }' "$manifest"
  )"
  ops_json_write "$OPS_CURRENT_STATE" "$content"
  local history
  history="$OPS_RELEASE_HISTORY/$(jq -r '.releaseId' "$manifest").json"
  if [[ -e "$history" ]]; then
    [[ "$(jq -r '.releaseId' "$history")" == "$(jq -r '.releaseId' "$manifest")" ]] ||
      ops_die OPS_RELEASE_HISTORY_INVALID "Immutable release history is inconsistent"
  else
    ops_json_write "$history" "$content"
    chmod 0400 "$history"
  fi
}

ops_release_history_target() {
  local release_id="${1:-previous}"
  if [[ "$release_id" != "previous" ]]; then
    printf '%s\n' "$OPS_RELEASE_HISTORY/$release_id.json"
    return
  fi
  local current_release
  current_release="$(jq -r '.releaseId' "$OPS_CURRENT_STATE")"
  find "$OPS_RELEASE_HISTORY" -maxdepth 1 -type f -name '*.json' -print0 |
    xargs -0 -r ls -1t |
    while IFS= read -r candidate; do
      if [[ "$(jq -r '.releaseId' "$candidate")" != "$current_release" ]]; then
        printf '%s\n' "$candidate"
        break
      fi
    done
}
