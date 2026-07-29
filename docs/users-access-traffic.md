# Users, Access, and Traffic Accounting

ProxyHub V0.4 Phase 2 adds administrator-managed users, many-to-many node access, encrypted VLESS credentials, real Xray traffic accounting, and near-real-time quota and expiration enforcement.

## Domain model

- `User` stores descriptive fields, the administrator enable switch, expiration, quota, reset policy, and a lifecycle snapshot used only to detect transitions after restart.
- `UserGroup` is optional classification metadata. It does not carry pricing, plans, inherited access, or permissions.
- `UserCredential` stores one encrypted VLESS UUID per user. The same credential is reused on every authorized node in this version.
- `UserAccess` joins a user to a node. It has an independent enable switch and a unique opaque `statsIdentity`.
- `UserTrafficUsage` stores current-cycle and lifetime totals per user.
- `UserAccessTrafficUsage` stores the same totals per user/node relationship.
- `UserTrafficRuntimeCounter` stores the most recently observed Xray counters for delta calculation.

Deleting a user is a soft revoke. Existing node credentials remain untouched and legacy node clients are never converted into users.

## Effective status

Status is calculated from source fields on every read. The stored lifecycle snapshot is not authoritative.

1. `adminEnabled=false` → `DISABLED`
2. expiration at or before the current time → `EXPIRED`
3. current-cycle uplink plus downlink at or above the quota → `TRAFFIC_EXHAUSTED`
4. otherwise → `ACTIVE`

Only `ACTIVE` users with enabled, non-revoked access enter the Xray client list. Increasing a quota, extending expiration, or resetting traffic can reactivate a user, but these operations never override an explicit administrator disable.

## Xray desired state

Every user or node mutation composes one complete desired configuration:

1. load every enabled node;
2. preserve each node's legacy client;
3. add eligible managed clients;
4. validate through the authenticated Agent;
5. atomically apply and restart Xray;
6. confirm health and retain a rollback revision until the database transaction commits.

Validation or apply failures abort the database transaction. If Xray was replaced before a later failure, the Agent restores the previous revision. A single user with access to multiple nodes still causes one complete validation/apply cycle.

Managed clients currently support VLESS over TCP/RAW with REALITY and `xtls-rprx-vision`. Unsupported node types are rejected explicitly.

## Stats identity and collection

The Xray client email is an opaque per-access identifier such as `phu-<opaque-user-id>-<opaque-access-id>`. It contains no user name or credential and differs for the same user on different nodes.

The compiler enables the Xray 26.5.9 `stats`, level-0 `statsUserUplink`/`statsUserDownlink`, and container-internal metrics listener only when managed clients exist. The listener is not published by Docker Compose. The Agent reads `/debug/vars`, accepts only its configured internal endpoint, normalizes user counters, and returns one authenticated batch response to the Server.

The Server runs one bounded scheduler. It does not create timers or RPC calls per user or access.

## Delta and reset handling

All byte values are `BigInt` internally and decimal strings in JSON.

- Counter increased: `delta = current - previous`.
- Counter unchanged: `delta = 0`.
- Counter decreased after Xray restart/reset: `delta = current`.
- Unknown stats identities are ignored.
- Malformed or negative counters reject the whole database transaction.

Current-cycle and lifetime totals are updated together. Repeated identical snapshots are idempotent. Xray counter resets do not reset lifetime accounting.

## Quota, expiration, and reset

Enforcement runs after each accounting batch and on administrator mutations. State transitions create audit entries and only necessary notifications. Repeated polling does not create notification spam.

Monthly cycles use UTC and reset days 1–28. A cycle reset clears current per-user and per-access totals while preserving lifetime totals. Manual reset behaves the same way. Enforcement is near-real-time and may lag by `PROXYHUB_TRAFFIC_ACCOUNTING_INTERVAL_MS` (30 seconds by default).

If reconciliation fails after accounting commits a state transition, a persisted pending marker causes later scheduler ticks and Server startup recovery to retry from the database desired state.

## Credential and share-link security

User UUIDs reuse the existing AES-256-GCM secret handling and are never returned by ordinary user APIs, logs, audits, notifications, diagnostics, or list views. Credential rotation replaces the UUID across all authorized nodes in one desired-state apply.

A VLESS share link is revealed only by an explicit administrator action for one user access. Its response uses `Cache-Control: no-store`; audit metadata contains only user, access, and node IDs.

## Known limitations

- Docker and Xray 26.5.9 runtime behavior still requires Linux VPS verification.
- Accounting is periodic, not instantaneous.
- The first snapshot after a newly observed Xray runtime counter is accounted as current usage.
- A complete per-user subscription, user portal, billing, device limits, online-session view, bandwidth shaping, and quota warning thresholds are deferred.
