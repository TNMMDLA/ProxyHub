# SQLite Backup Foundation

Phase 1 provides host CLI operations only:

```bash
scripts/ops/backup.sh create
scripts/ops/backup.sh list
scripts/ops/backup.sh verify --archive PATH
scripts/ops/backup.sh prune --count 10 --days 30 --dry-run
```

There is no scheduler, cloud upload, Web restore UI, or automatic restore command in this phase.

## Consistency

Create acquires the global operation lock and invokes SQLite's `.backup` operation. This uses a
live SQLite connection and produces a consistent snapshot even when the source database uses WAL.
The snapshot is copied out of the Server container when the production named volume is used.

Before publication, the tool runs `PRAGMA integrity_check`, records the migration fingerprint,
writes checksums and a schema-versioned manifest, creates a moderate-compression archive, verifies
the complete archive, then atomically renames it into the backup directory.

## Archive

Name:

```text
proxyhub-backup-<UTC>-<git-short-sha>.tar.gz
```

Exactly four regular files are allowed:

```text
database.sqlite
manifest.json
SHA256SUMS
README.txt
```

The archive never includes `.env`, the encryption key, logs, source code, Git/SSH files, image
layers, `node_modules`, or plaintext private keys. The database can contain application-encrypted
values; the original `ENCRYPTION_KEY` is required to use them after recovery.

## Verification

Verify rejects gzip/tar corruption, absolute or traversal paths, links, duplicates, missing or
unknown entries, manifest/schema errors, checksum mismatch, invalid SQLite headers, failed
integrity checks, metadata mismatch, and optional migration-fingerprint mismatch. Verification
extracts only into a private temporary directory and never opens or replaces the active database.

## Retention and permissions

State/backup directories are `0700`; archives and staging files are `0600`. Retention defaults to
at least 10 backups and 30 days. Prune considers only correctly named, non-symlink, successfully
verified ProxyHub archives and ignores every unknown/manual file.
