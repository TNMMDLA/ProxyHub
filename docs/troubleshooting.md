# Operations Troubleshooting

Start with read-only checks:

```bash
scripts/ops/preflight.sh --manifest release-manifest.json --json
scripts/ops/health.sh --manifest release-manifest.json --json
docker compose ps --all
```

Do not paste `.env`, authorization headers, encrypted database fields, or complete database files
into an issue.

## Common errors

| Code                                   | Meaning                                   | Safe response                                                |
| -------------------------------------- | ----------------------------------------- | ------------------------------------------------------------ |
| `PROXYHUB_OPERATION_BUSY`              | Another mutation owns the global lock     | Inspect lock metadata and wait; do not delete a live lock    |
| `OPS_PREREQUISITE_MISSING`             | Required Linux tool is unavailable        | Install the named package, then rerun preflight              |
| `OPS_MANIFEST_INVALID`                 | Manifest structure or identity is invalid | Download the artifact again from the matching CI run         |
| `OPS_MANIFEST_DIGEST_REQUIRED`         | A release image has no digest             | Never substitute `latest`; use a release-mode manifest       |
| `OPS_SAME_VERSION`                     | Target version equals current             | Use a newer versioned release                                |
| `OPS_DOWNGRADE_BLOCKED`                | Target semantic version is lower          | Review compatibility before explicit override                |
| `OPS_ROLLBACK_SCHEMA_INCOMPATIBLE`     | Target migration fingerprint differs      | Use verified manual database recovery planning               |
| `OPS_DATABASE_RESTORE_MANUAL_REQUIRED` | Failed update changed migrations          | Keep services/data preserved and review the backup           |
| `OPS_BACKUP_CHECKSUM_FAILED`           | Archive content changed                   | Do not restore; retain for forensics and use another backup  |
| `OPS_BACKUP_INTEGRITY_FAILED`          | SQLite snapshot is damaged                | Do not restore; inspect storage and choose a verified backup |

## Failed update

Read the matching transaction JSON and diagnostics directory. `current.json` remains the last
health-verified release until a new release commits. If migration fingerprints match, the updater
attempts image rollback. If they differ, it intentionally stops rather than automatically replace
the database.

## Health mismatch

If containers are healthy but version/SHA fails, inspect:

```bash
docker compose exec -T proxyhub-server \
  node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>r.text()).then(console.log)"
SERVER_CID="$(docker compose ps -q --all proxyhub-server)"
test -n "$SERVER_CID"
docker inspect "$SERVER_CID" \
  --format '{{json .Config.Labels}}'
```

Do not force current state to match the container. Re-run the correct immutable manifest.

## Production acceptance

CI validates isolated runtime behavior only. Reality target compatibility and V0.3.1 Phase 1 still
require the documented real Linux VPS smoke test before ProxyHub can be called production-ready.
