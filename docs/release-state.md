# Release State

The default root is `.proxyhub/state`; production may set `PROXYHUB_STATE_DIR`.

```text
state/
  releases/
    current.json
    manifests/<release-id>.json
    history/<release-id>.json
  transactions/<transaction-id>.json
  locks/
    operation.lock
    operation.json
  diagnostics/<transaction-id>/
```

State files are written to a same-directory temporary file, synchronized, and atomically renamed.
History and stored manifests are immutable.

## Current release

`current.json` records:

- `releaseId`
- `version`
- `gitSha`
- immutable `manifestPath`
- `deployMode`
- four image digests
- database migration fingerprint
- UTC `deployedAt`
- committing `transactionId`

It changes only after exact version/SHA health verification succeeds.

## Transaction

Each transaction records operation, from/to version and SHA, timestamps, current stage, backup,
previous state, target manifest, and failure stage/code. It never contains environment values or
secrets.

Diagnostics include bounded Compose status/logs and non-secret host context. Keep the entire state
directory root-owned with mode `0700`; individual writable state and diagnostic files use `0600`.

Do not hand-edit current or history state. If state is damaged, preserve it and follow
[troubleshooting](troubleshooting.md).
