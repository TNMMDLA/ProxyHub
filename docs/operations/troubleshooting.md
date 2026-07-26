# Diagnostics troubleshooting

- `AGENT_UNAVAILABLE`: inspect `docker compose ps proxyhub-agent` and internal service logs.
- `XRAY_UNHEALTHY`: inspect Xray process, current config validation, heartbeat, and configured listening ports.
- `DATABASE_UNAVAILABLE`: verify the SQLite volume and Server filesystem permissions.
- `STORAGE_CAPACITY_LOW`: inspect volume usage and Phase 1 backup retention from the VPS host.
- `STATE_NOT_AVAILABLE` or `BACKUP_NOT_AVAILABLE`: confirm the host directories exist and are mounted read-only.
- `OPERATIONS_STATE_INVALID`: validate Phase 1 state JSON on the host; Diagnostics will not repair it.
- `DIAGNOSTICS_SCAN_BUSY`: wait for the existing manual scan to finish.
- `DIAGNOSTICS_SCAN_TIMEOUT`: retry after load decreases and inspect the affected component directly.

No troubleshooting action in the web page mutates the runtime. Use the documented Phase 1 operations CLI for deploy, update, rollback, and backup actions.

# Phase 3 guided delivery

When a subscription is blocked, run its Readiness check and follow the stable stage and error code.
Use `/diagnostics?tab=subscriptions` for subscription failures, `?tab=rule-sets` for Rule Set
problems, and the Nodes Reality Compatibility panel for target errors.

Configuration Preview is deliberately sanitized. Use the existing controlled node Share function
only when an administrator needs an unredacted single-node URI. If Preview is truncated, reduce
the selected nodes/rules or inspect the compiler diagnostics; do not raise limits on a low-resource
VPS without measuring memory use.
