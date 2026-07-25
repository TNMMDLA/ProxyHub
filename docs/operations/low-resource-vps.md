# Diagnostics on a low-resource VPS

Overview is cached and uses only bounded, inexpensive checks. Keep the default 30-second browser refresh and 10-second Server TTL unless operational evidence requires a change. Polling pauses when the Diagnostics page is hidden or auto-refresh is disabled.

Deep scans are manual, single-concurrency, and time-limited. Run them during low activity. A warning on a small VPS is contextual: check cgroup memory, process RSS, available host swap, and load together. ProxyHub does not automatically classify an otherwise stable small VPS as failed solely from total memory.

State and backup limits should remain conservative. The defaults expose at most 20 history/transaction entries and 50 backup entries, with a 1 MiB JSON file limit.
