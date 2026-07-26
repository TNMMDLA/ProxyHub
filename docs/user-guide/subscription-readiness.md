# Subscription Readiness

Readiness returns `READY`, `READY_WITH_WARNINGS`, `BLOCKED`, or `UNKNOWN`. Checks cover lifecycle
state, Policy and final behavior, Node Pool membership, enabled Nodes, Rule Set and Last Known Good
state, adapter capabilities, and a real compiler dry run.

Each result includes a stable check ID, stage, safe resource reference, error code, and recommended
action. Manual checks are in-memory, bounded to two concurrent compiles, and time out after ten
seconds. They do not change the subscription, token, ETag, public cache, Last Access, or Rule Sets.
