# Transactional Update

Run:

```bash
scripts/ops/update.sh --manifest /opt/proxyhub/releases/new-manifest.json --yes
```

Same-version updates are rejected. Semantic downgrades require `--allow-downgrade` and remain
subject to database compatibility checks.

## State machine

The transaction advances through:

```text
INITIALIZED
LOCKED
PREFLIGHT_PASSED
BACKUP_CREATED
RELEASE_VALIDATED
IMAGES_PULLED
MIGRATION_VALIDATED
MIGRATION_APPLIED
SERVICES_STARTED
HEALTH_VERIFIED
RELEASE_COMMITTED
```

Failure records `FAILED` plus the exact failure stage and code, then enters
`ROLLBACK_STARTED`. A same-schema image rollback ends in `ROLLED_BACK`; otherwise it records
`ROLLBACK_FAILED`.

## Migration safety

Update performs a verified SQLite backup before pulling or migrating. It runs Prisma migration
status before starting the new Server. The Server applies only checked-in migrations with
`prisma migrate deploy`; reset and destructive development migration commands are forbidden.

The before/after release manifests contain a deterministic migration fingerprint. If an update
fails after that fingerprint changes, Phase 1 does not guess that restoring the database is safe.
It stops the failed release and reports `OPS_DATABASE_RESTORE_MANUAL_REQUIRED`. An operator must
verify the backup, confirm that no post-update writes must be retained, and follow an approved
manual recovery procedure.

## Dry run

```bash
scripts/ops/update.sh --manifest new-manifest.json --dry-run --yes --json
```

Dry run validates the current state, version direction, environment, manifest, images, Compose,
resources, database visibility, DNS, Caddy, and Xray without making changes.
