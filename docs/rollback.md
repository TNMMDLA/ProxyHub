# Rollback

Rollback selects immutable release history, not a moving tag:

```bash
# Most recent release other than current
scripts/ops/rollback.sh --yes

# Explicit release
scripts/ops/rollback.sh --to RELEASE_ID --yes
```

Before changing containers, rollback validates the target manifest and creates another consistent
backup of the current database. It pulls the target digests sequentially, starts the target
services, checks all five containers and the exact Server version/SHA, then commits current state.

## Database boundary

Automatic image rollback is allowed only when target and current migration fingerprints are
identical. A different fingerprint fails before containers or database are changed with
`OPS_ROLLBACK_SCHEMA_INCOMPATIBLE`.

This conservative policy prevents an old Server from opening a database whose schema it does not
understand. Database restoration is not exposed as a generic Phase 1 command. A manual restore
must verify:

1. the backup archive and SQLite integrity;
2. the target release/migration fingerprint;
3. whether the failed release ever became healthy or public;
4. whether post-update writes exist and must be retained;
5. the original `ENCRYPTION_KEY` is available.

If the target image itself fails health, ProxyHub attempts to restore the previously current image
set and captures diagnostics. It never deletes the database volume.
