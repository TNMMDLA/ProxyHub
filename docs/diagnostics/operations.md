# Operations visibility

The Server reads Phase 1 `current.json`, release history, release manifests, transaction files, captured-diagnostics counts, and recognized backup filenames through confined readers. Files are limited to 1 MiB, history and transaction lists are bounded, JSON is schema-safe and redacted, and absolute host paths are never returned.

Overview reports backup metadata without opening archives. A manually requested Deep Scan streams only the newest archive's embedded `manifest.json`, validates its schema within a 1 MiB limit, and never extracts files to disk. Full SQLite checksum and integrity verification remains the responsibility of the Phase 1 backup verification CLI.

Readers resolve a canonical root, reject traversal, reject direct symlinks, and verify that the final real path remains inside the configured root. Invalid or oversized files produce a partial warning; a missing mount produces `NOT_AVAILABLE` without preventing Server startup.

Compose mounts `${PROXYHUB_STATE_DIR:-./.proxyhub/state}` and `${PROXYHUB_BACKUP_DIR:-./backups}` read-only at fixed container locations. Host operations continue to use the original variables. Docker Socket is never mounted.
