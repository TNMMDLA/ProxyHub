# Storage and resource diagnostics

Storage diagnostics report the filesystem that contains SQLite, available bytes and inodes, visible memory, process RSS, CPU count, and one-minute load. The defaults reuse Phase 1 thresholds: less than 2 GiB free disk is a warning and less than 1 GiB is critical.

Memory shown by Node may be limited to a container or may reflect host visibility depending on the runtime. ProxyHub labels uncertain data as `unknown` and does not present container memory as host memory. On a low-resource VPS, review memory together with cgroup limits and host swap rather than interpreting a single threshold in isolation.

Backup counts and aggregate sizes are metadata-only. No download, delete, restore, or retention action exists in the Diagnostics Center.
