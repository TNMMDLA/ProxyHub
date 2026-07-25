# ProxyHub Operations

ProxyHub V0.3.1 Phase 1 introduces a host-side operations layer for immutable image deployment,
transactional updates, conservative rollback, and consistent SQLite backups. These tools are for a
Linux host with Docker Engine and Docker Compose v2. They do not alter firewall or SSH policy.

## Prerequisites

Install `git`, `curl`, `jq`, `sqlite3`, `tar`, `gzip`, `sha256sum`, and `flock`. Copy
`.env.example` to `.env`, replace both secret placeholders, and set the public domain:

```bash
cp .env.example .env
chmod 0600 .env
editor .env
```

Never pass secrets on a command line. Operations redact common secret forms from diagnostics, but
the safest design is to keep secrets only in the root-owned `.env`.

## Commands

```bash
scripts/ops/preflight.sh --manifest release-manifest.json
scripts/ops/health.sh --manifest release-manifest.json
scripts/ops/deploy.sh --manifest release-manifest.json --yes
scripts/ops/update.sh --manifest release-manifest.json --yes
scripts/ops/rollback.sh --yes
scripts/ops/backup.sh create
scripts/ops/backup.sh list --json
scripts/ops/backup.sh verify --archive backups/proxyhub-backup-....tar.gz
scripts/ops/backup.sh prune --count 10 --days 30 --dry-run
```

Every mutating command also supports `--dry-run`. Dry-run mode may inspect files, Docker state,
DNS, and remote manifests, but does not pull images, start or stop containers, run migrations,
write release state, create backups, or delete files.

## Global operation lock

Deploy, update, rollback, backup create, and backup prune use one non-blocking `flock`. Concurrent
mutation fails with `PROXYHUB_OPERATION_BUSY`. Lock metadata records only the operation, PID, and
UTC start time. The lock is released automatically on normal exit, errors, and signals.

Defaults:

- state: `.proxyhub/state`
- backups: `backups`
- environment: `.env`

Production hosts should set `PROXYHUB_STATE_DIR=/opt/proxyhub/state` and
`PROXYHUB_BACKUP_DIR=/opt/proxyhub/backups`, owned by root with mode `0700`.

## Safety boundary

The operations layer never runs `docker system prune`, never deletes volumes, never invokes
`prisma migrate reset`, and never overwrites the active database during archive verification.
Diagnostics are written under the state directory with mode `0600`.

See [release state](release-state.md), [backup](backup.md), and
[troubleshooting](troubleshooting.md) for the durable formats and error codes.
