#!/usr/bin/env bash
set -Eeuo pipefail

# shellcheck source=lib/common.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/common.sh"

COMMAND="${1:-}"
[[ -n "$COMMAND" ]] && shift || true
COUNT=10
DAYS=30
ARCHIVE=""
EXPECTED_FINGERPRINT=""
CREATE_TEMP=""
VERIFY_TEMP=""

usage() {
  cat <<'EOF'
Usage: scripts/ops/backup.sh <create|list|verify|prune> [options]

Commands:
  create                 Create and immediately verify a consistent SQLite backup
  list                   List recognized backup archives
  verify --archive PATH  Safely inspect and verify an archive without restoring it
  prune                  Apply count/age retention to valid ProxyHub archives only

Options:
  --archive PATH         Archive for verify
  --backup-dir PATH      Backup directory (default: ./backups)
  --state-dir PATH       Release state directory
  --env-file PATH        Environment file (default: .env)
  --count NUMBER         Keep at least this many newest backups (default: 10)
  --days NUMBER          Keep backups newer than this many days (default: 30)
  --expected-fingerprint SHA256
  --dry-run              Show mutations without creating/deleting files
  --json                 Print machine-readable output
  --yes                  Allow non-interactive prune
  --help                 Show this help
EOF
}

cleanup_create() {
  if [[ -n "$CREATE_TEMP" && -d "$CREATE_TEMP" ]]; then
    rm -rf -- "$CREATE_TEMP"
  fi
}

cleanup_all() {
  if [[ -n "$VERIFY_TEMP" && -d "$VERIFY_TEMP" ]]; then
    rm -rf -- "$VERIFY_TEMP"
  fi
  cleanup_create
  ops_lock_release
}

trap cleanup_all EXIT

verify_archive() {
  local archive="$1"
  local expected="${2:-}"
  [[ -f "$archive" && ! -L "$archive" ]] ||
    ops_die OPS_BACKUP_NOT_FOUND "Backup archive is missing or is a symlink: $archive"
  [[ -s "$archive" ]] || ops_die OPS_BACKUP_EMPTY "Backup archive is empty"
  gzip -t -- "$archive" >/dev/null 2>&1 ||
    ops_die OPS_BACKUP_ARCHIVE_INVALID "Backup is not a valid gzip stream"

  local listing verbose duplicate_count
  listing="$(tar -tzf "$archive")" ||
    ops_die OPS_BACKUP_ARCHIVE_INVALID "Backup tar index cannot be read"
  [[ -n "$listing" ]] || ops_die OPS_BACKUP_ARCHIVE_INVALID "Backup tar index is empty"
  while IFS= read -r entry; do
    [[ "$entry" != /* && "$entry" != *'..'* && "$entry" != *'\'* ]] ||
      ops_die OPS_BACKUP_PATH_UNSAFE "Unsafe archive path: $entry"
    case "$entry" in
      database.sqlite | manifest.json | SHA256SUMS | README.txt) ;;
      *) ops_die OPS_BACKUP_UNKNOWN_ENTRY "Unknown archive entry: $entry" ;;
    esac
  done <<<"$listing"
  for required in database.sqlite manifest.json SHA256SUMS README.txt; do
    duplicate_count="$(grep -Fxc "$required" <<<"$listing" || true)"
    [[ "$duplicate_count" == "1" ]] ||
      ops_die OPS_BACKUP_ENTRY_INVALID "Archive must contain exactly one $required"
  done
  verbose="$(tar -tvzf "$archive")"
  if grep -Eq '^[lh]' <<<"$verbose"; then
    ops_die OPS_BACKUP_LINK_FORBIDDEN "Archive links are forbidden"
  fi

  VERIFY_TEMP="$(mktemp -d "${TMPDIR:-/tmp}/proxyhub-verify.XXXXXX")"
  chmod 0700 "$VERIFY_TEMP"
  tar -xzf "$archive" -C "$VERIFY_TEMP" --no-same-owner --no-same-permissions
  chmod 0600 "$VERIFY_TEMP"/*

  jq -e '
    .schemaVersion == 1 and
    .application.name == "ProxyHub" and
    (.application.version | type == "string") and
    (.application.gitSha | test("^[0-9a-f]{40}$")) and
    (.application.xrayVersion | test("^\\d+\\.\\d+\\.\\d+$")) and
    (.createdAt | type == "string") and
    .database.filename == "database.sqlite" and
    (.database.sizeBytes | type == "number" and . > 0) and
    (.database.sha256 | test("^[0-9a-f]{64}$")) and
    .database.integrity == "ok" and
    (.database.migrationFingerprint | test("^[0-9a-f]{64}$")) and
    .encryptionKeyIncluded == false and
    (keys | sort) == ["application","createdAt","database","encryptionKeyIncluded","schemaVersion"]
  ' "$VERIFY_TEMP/manifest.json" >/dev/null ||
    ops_die OPS_BACKUP_MANIFEST_INVALID "Backup manifest schema validation failed"
  if jq -e '.. | objects | keys[] | select(test("secret|password|token|private.?key"; "i"))' \
    "$VERIFY_TEMP/manifest.json" >/dev/null; then
    ops_die OPS_BACKUP_MANIFEST_SECRET "Backup manifest contains a forbidden secret-like field"
  fi
  (
    cd "$VERIFY_TEMP"
    sha256sum -c SHA256SUMS >/dev/null
  ) || ops_die OPS_BACKUP_CHECKSUM_FAILED "Backup checksums do not match"

  local header integrity size actual_sha manifest_sha manifest_size fingerprint
  header="$(head -c 16 "$VERIFY_TEMP/database.sqlite")"
  [[ "$header" == "SQLite format 3" ]] ||
    ops_die OPS_BACKUP_SQLITE_HEADER_INVALID "Snapshot does not have a SQLite header"
  integrity="$(sqlite3 "$VERIFY_TEMP/database.sqlite" 'PRAGMA integrity_check;' 2>/dev/null)"
  [[ "$integrity" == "ok" ]] ||
    ops_die OPS_BACKUP_INTEGRITY_FAILED "SQLite integrity_check returned: $integrity"
  size="$(wc -c <"$VERIFY_TEMP/database.sqlite" | tr -d ' ')"
  actual_sha="$(sha256sum "$VERIFY_TEMP/database.sqlite" | awk '{print $1}')"
  manifest_sha="$(jq -r '.database.sha256' "$VERIFY_TEMP/manifest.json")"
  manifest_size="$(jq -r '.database.sizeBytes' "$VERIFY_TEMP/manifest.json")"
  [[ "$actual_sha" == "$manifest_sha" && "$size" == "$manifest_size" ]] ||
    ops_die OPS_BACKUP_METADATA_MISMATCH "Snapshot size or hash does not match manifest"
  fingerprint="$(jq -r '.database.migrationFingerprint' "$VERIFY_TEMP/manifest.json")"
  [[ -z "$expected" || "$fingerprint" == "$expected" ]] ||
    ops_die OPS_BACKUP_FINGERPRINT_MISMATCH "Backup migration fingerprint does not match expectation"

  rm -rf -- "$VERIFY_TEMP"
  VERIFY_TEMP=""
  if [[ "$OPS_JSON" == "true" ]]; then
    jq -cn \
      --arg archive "$(realpath "$archive")" \
      --arg sha256 "$(sha256sum "$archive" | awk '{print $1}')" \
      --arg fingerprint "$fingerprint" \
      '{success:true,archive:$archive,sha256:$sha256,migrationFingerprint:$fingerprint}'
  else
    ops_log INFO "Backup verified: $archive"
  fi
}

create_backup() {
  ops_require_command jq
  ops_require_command sqlite3
  ops_require_command sha256sum
  ops_require_command tar
  ops_require_command gzip
  if [[ "$OPS_DRY_RUN" == "true" ]]; then
    ops_lock_check_read_only
    [[ -f "$PROXYHUB_STATE_DIR/releases/current.json" ]] ||
      ops_die OPS_RELEASE_STATE_MISSING "Current release state is required"
    [[ "$OPS_JSON" == "true" ]] &&
      jq -cn '{success:true,dryRun:true,operation:"backup-create",mutations:[]}' ||
      ops_log INFO "DRY RUN: would create, verify and atomically publish one SQLite backup"
    return
  fi
  if [[ "${PROXYHUB_PARENT_LOCK:-}" == "true" ]]; then
    ops_require_inherited_lock
  else
    ops_lock_acquire backup-create
  fi
  ops_secure_directory "$PROXYHUB_BACKUP_DIR"
  [[ -f "$PROXYHUB_STATE_DIR/releases/current.json" ]] ||
    ops_die OPS_RELEASE_STATE_MISSING "Current release state is required before backup"

  local current version git_sha xray_version fingerprint created stamp short archive_name final_archive
  current="$PROXYHUB_STATE_DIR/releases/current.json"
  version="$(jq -r '.version' "$current")"
  git_sha="$(jq -r '.gitSha' "$current")"
  fingerprint="$(jq -r '.databaseMigrationFingerprint' "$current")"
  manifest_path="$(jq -r '.manifestPath' "$current")"
  xray_version="$(jq -r '.xrayVersion' "$manifest_path")"
  created="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  short="${git_sha:0:12}"
  archive_name="proxyhub-backup-$stamp-$short.tar.gz"
  final_archive="$PROXYHUB_BACKUP_DIR/$archive_name"
  [[ ! -e "$final_archive" ]] ||
    ops_die OPS_BACKUP_EXISTS "Backup already exists: $final_archive"

  CREATE_TEMP="$(mktemp -d "$PROXYHUB_BACKUP_DIR/.create.XXXXXX")"
  chmod 0700 "$CREATE_TEMP"
  trap 'cleanup_create; ops_lock_release' EXIT
  local snapshot="$CREATE_TEMP/database.sqlite"
  [[ "$snapshot" != *"'"* && "$snapshot" != *$'\n'* ]] ||
    ops_die OPS_DATABASE_PATH_UNSAFE "Backup staging path contains unsafe characters"

  if [[ -n "${PROXYHUB_DATABASE_PATH:-}" ]]; then
    [[ -f "$PROXYHUB_DATABASE_PATH" ]] ||
      ops_die OPS_DATABASE_NOT_FOUND "PROXYHUB_DATABASE_PATH is not a file"
    sqlite3 "$PROXYHUB_DATABASE_PATH" ".backup '$snapshot'"
  else
    ops_manifest_export_images "$manifest_path"
    local database_url container_database container_snapshot
    database_url="$(sed -n 's/^DATABASE_URL=//p' "$PROXYHUB_ENV_FILE" | head -n1)"
    database_url="${database_url:-file:/app/data/proxyhub.db}"
    [[ "$database_url" == file:/app/data/* ]] ||
      ops_die OPS_DATABASE_PATH_UNSAFE "Container database must remain under /app/data"
    container_database="${database_url#file:}"
    container_snapshot="/app/data/.proxyhub-backup-$stamp.sqlite"
    ops_compose exec -T proxyhub-server sqlite3 "$container_database" ".backup '$container_snapshot'"
    ops_compose cp "proxyhub-server:$container_snapshot" "$snapshot"
    ops_compose exec -T proxyhub-server rm -f -- "$container_snapshot"
  fi
  chmod 0600 "$snapshot"

  local integrity size database_sha
  integrity="$(sqlite3 "$snapshot" 'PRAGMA integrity_check;')"
  [[ "$integrity" == "ok" ]] ||
    ops_die OPS_BACKUP_INTEGRITY_FAILED "SQLite snapshot integrity check failed"
  size="$(wc -c <"$snapshot" | tr -d ' ')"
  database_sha="$(sha256sum "$snapshot" | awk '{print $1}')"
  jq -n \
    --arg version "$version" \
    --arg gitSha "$git_sha" \
    --arg xrayVersion "$xray_version" \
    --arg createdAt "$created" \
    --argjson sizeBytes "$size" \
    --arg sha256 "$database_sha" \
    --arg migrationFingerprint "$fingerprint" \
    '{
      schemaVersion:1,
      application:{name:"ProxyHub",version:$version,gitSha:$gitSha,xrayVersion:$xrayVersion},
      createdAt:$createdAt,
      database:{
        filename:"database.sqlite",
        sizeBytes:$sizeBytes,
        sha256:$sha256,
        integrity:"ok",
        migrationFingerprint:$migrationFingerprint
      },
      encryptionKeyIncluded:false
    }' >"$CREATE_TEMP/manifest.json"
  cat >"$CREATE_TEMP/README.txt" <<'EOF'
ProxyHub SQLite backup

This archive intentionally excludes .env files and encryption keys.
The original ENCRYPTION_KEY is required to decrypt protected database values after a manual restore.
Verify this archive with scripts/ops/backup.sh verify before any recovery procedure.
EOF
  (
    cd "$CREATE_TEMP"
    sha256sum database.sqlite manifest.json README.txt >SHA256SUMS
  )
  chmod 0600 "$CREATE_TEMP"/{manifest.json,README.txt,SHA256SUMS}

  local temporary_archive="$PROXYHUB_BACKUP_DIR/.$archive_name.tmp"
  tar -I 'gzip -6' -cf "$temporary_archive" \
    -C "$CREATE_TEMP" database.sqlite manifest.json SHA256SUMS README.txt
  chmod 0600 "$temporary_archive"
  verify_archive "$temporary_archive" "$fingerprint"
  mv -f -- "$temporary_archive" "$final_archive"
  sync -f "$PROXYHUB_BACKUP_DIR" 2>/dev/null || true
  cleanup_create
  CREATE_TEMP=""
  if [[ "$OPS_JSON" == "true" ]]; then
    jq -cn --arg archive "$(realpath "$final_archive")" '{success:true,archive:$archive}'
  else
    printf '%s\n' "$(realpath "$final_archive")"
  fi
}

list_backups() {
  ops_require_command jq
  local items='[]'
  if [[ -d "$PROXYHUB_BACKUP_DIR" ]]; then
    while IFS= read -r -d '' archive; do
      [[ ! -L "$archive" ]] || continue
      items="$(
        jq -c \
          --arg path "$(realpath "$archive")" \
          --argjson size "$(wc -c <"$archive")" \
          '. + [{path:$path,sizeBytes:$size}]' <<<"$items"
      )"
    done < <(
      find "$PROXYHUB_BACKUP_DIR" -maxdepth 1 -type f \
        -name 'proxyhub-backup-[0-9]*T[0-9]*Z-[0-9a-f]*.tar.gz' -print0 | sort -z
    )
  fi
  [[ "$OPS_JSON" == "true" ]] &&
    jq -cn --argjson backups "$items" '{success:true,backups:$backups}' ||
    jq -r '.[] | "\(.path)\t\(.sizeBytes) bytes"' <<<"$items"
}

prune_backups() {
  [[ "$COUNT" =~ ^[0-9]+$ && "$DAYS" =~ ^[0-9]+$ ]] ||
    ops_die OPS_ARGUMENT_INVALID "Retention count and days must be non-negative integers"
  if [[ "$OPS_DRY_RUN" == "true" ]]; then
    ops_lock_check_read_only
  else
    ops_lock_acquire backup-prune
    ops_confirm "Delete expired ProxyHub backup archives?"
  fi
  local candidates=() index=0 now cutoff archive mtime
  now="$(date +%s)"
  cutoff=$((now - DAYS * 86400))
  if [[ -d "$PROXYHUB_BACKUP_DIR" ]]; then
    while IFS= read -r -d '' archive; do
      [[ ! -L "$archive" ]] || continue
      if verify_archive "$archive" >/dev/null 2>&1; then
        candidates+=("$archive")
      else
        ops_log WARN "Ignoring unverified or unknown file: $archive"
      fi
    done < <(
      find "$PROXYHUB_BACKUP_DIR" -maxdepth 1 -type f \
        -name 'proxyhub-backup-[0-9]*T[0-9]*Z-[0-9a-f]*.tar.gz' -printf '%T@ %p\0' |
        sort -zrn |
        sed -z 's/^[^ ]* //'
    )
  fi
  local deletions='[]'
  for archive in "${candidates[@]}"; do
    index=$((index + 1))
    mtime="$(stat -c %Y "$archive")"
    if ((index > COUNT && mtime < cutoff)); then
      deletions="$(jq -c --arg path "$(realpath "$archive")" '. + [$path]' <<<"$deletions")"
      if [[ "$OPS_DRY_RUN" != "true" ]]; then
        rm -- "$archive"
      fi
    fi
  done
  if [[ "$OPS_JSON" == "true" ]]; then
    jq -cn --argjson deleted "$deletions" --argjson dryRun "$OPS_DRY_RUN" \
      '{success:true,dryRun:$dryRun,deleted:$deleted}'
  else
    jq -r '.[] | "would prune: \(.)"' <<<"$deletions"
  fi
}

while (($#)); do
  case "$1" in
    --archive) ARCHIVE="${2:?Missing value for --archive}"; shift 2 ;;
    --backup-dir) PROXYHUB_BACKUP_DIR="${2:?Missing value for --backup-dir}"; shift 2 ;;
    --state-dir) PROXYHUB_STATE_DIR="${2:?Missing value for --state-dir}"; shift 2 ;;
    --env-file) PROXYHUB_ENV_FILE="${2:?Missing value for --env-file}"; shift 2 ;;
    --count) COUNT="${2:?Missing value for --count}"; shift 2 ;;
    --days) DAYS="${2:?Missing value for --days}"; shift 2 ;;
    --expected-fingerprint) EXPECTED_FINGERPRINT="${2:?Missing value}"; shift 2 ;;
    --dry-run) OPS_DRY_RUN=true; shift ;;
    --json) OPS_JSON=true; shift ;;
    --yes) OPS_YES=true; shift ;;
    --help) usage; exit 0 ;;
    *) ops_die OPS_ARGUMENT_INVALID "Unknown argument: $1" ;;
  esac
done

ops_refresh_paths

case "$COMMAND" in
  create) create_backup ;;
  list) list_backups ;;
  verify)
    [[ -n "$ARCHIVE" ]] || ops_die OPS_ARGUMENT_INVALID "verify requires --archive"
    ops_require_command jq
    ops_require_command sqlite3
    verify_archive "$ARCHIVE" "$EXPECTED_FINGERPRINT"
    ;;
  prune) prune_backups ;;
  help | --help | -h | '') usage ;;
  *) ops_die OPS_ARGUMENT_INVALID "Unknown backup command: $COMMAND" ;;
esac
