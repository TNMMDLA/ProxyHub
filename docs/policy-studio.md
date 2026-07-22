# Policy Studio

## Unified policy behavior

A Policy owns an ordered list of rules and one default action. Every enabled rule contains one match type/value and one action:

- `DIRECT`
- `REJECT`
- `NODE_POOL` referencing an existing Node Pool

Evaluation is deterministic and uses **First Match Wins**. Dragging a card or using its arrow controls submits the complete rule ID order in one transaction. Rule create/update/delete/reorder increments the Policy revision.

## Supported match types

| Match type     | Mihomo | sing-box            | Raw                      |
| -------------- | ------ | ------------------- | ------------------------ |
| DOMAIN         | Yes    | Yes                 | Warning: routing omitted |
| DOMAIN_SUFFIX  | Yes    | Yes                 | Warning                  |
| DOMAIN_KEYWORD | Yes    | Yes                 | Warning                  |
| DOMAIN_REGEX   | Yes    | Yes                 | Warning                  |
| IP_CIDR        | Yes    | Yes                 | Warning                  |
| IP_CIDR6       | Yes    | Yes                 | Warning                  |
| GEOIP          | Yes    | Unsupported warning | Warning                  |
| GEOSITE        | Yes    | Unsupported warning | Warning                  |
| DST_PORT       | Yes    | Yes                 | Warning                  |
| NETWORK        | Yes    | Yes                 | Warning                  |

Unsupported rules are reported with adapter, rule ID, name, and type. They are not silently discarded. Raw subscriptions intentionally publish enabled VLESS Reality nodes only and report every enabled routing rule as unsupported.

## Node Pool behavior

Only enabled nodes are emitted. A temporarily `OFFLINE` node remains present to avoid subscription churn; only `enabled=false` removes it. A referenced disabled pool emits a warning. A referenced pool with no enabled nodes is an error. Deleting a referenced pool returns `NODE_POOL_IN_USE` and identifies the Policies using it.

## Preview security

Compile Preview runs only through `policy-core` and never changes runtime state. The UI defaults to masked UUID credentials. An authenticated administrator may explicitly reveal full output. Output is never written to console or audit metadata.
