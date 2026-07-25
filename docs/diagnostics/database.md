# Database diagnostics

Database checks use read-only SQLite queries and filesystem metadata. Overview runs `SELECT 1`, reads `_prisma_migrations`, records latency, and reports database/WAL/SHM sizes without returning `DATABASE_URL`, rows, or a host path.

Manual deep diagnostics may run `PRAGMA quick_check`; automatic polling never runs full `integrity_check`. Migration drift cannot be proven from the runtime database alone, so unavailable drift information is explained instead of guessed. A failed quick check is critical and should be investigated before further writes, using a verified Phase 1 backup.

The write-capability field is derived from directory access and configuration only. Diagnostics never inserts a probe record or changes business state.
