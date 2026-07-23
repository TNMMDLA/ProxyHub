# Rule Sets

ProxyHub V0.3 introduces reusable Rule Sets for client subscription policies. A Rule Set contains matches only; the Policy that references it still owns the `DIRECT`, `REJECT`, or `NODE_POOL` action. Rule Sets never change Xray runtime configuration.

## Manual and remote sources

- **Manual** Rule Sets store ordered `RuleSetEntry` rows and support entry CRUD, enable/disable, bulk import, search, bounded preview, and ProxyHub Native JSON export.
- **Remote** Rule Sets store source metadata plus one normalized Last Known Good cache. Subscription requests read this local cache and never fetch the remote URL.

Supported source formats are `AUTO`, ProxyHub Native JSON version 1, plain text, and Mihomo-compatible rule lists. Auto detection recognizes Native JSON, Mihomo `payload`/hyphenated types, and ProxyHub plain-text types.

Supported normalized rule types are `DOMAIN`, `DOMAIN_SUFFIX`, `DOMAIN_KEYWORD`, `DOMAIN_REGEX`, `IP_CIDR`, `IP_CIDR6`, `GEOIP`, `GEOSITE`, `DST_PORT`, and `NETWORK`.

## Normalization

The normalizer trims values, canonicalizes external type names, lowercases domains and geo values, normalizes IPv4 networks, validates IPv6 CIDRs/ports/networks, removes exact type/value duplicates, preserves the first occurrence, and emits stable JSON. SHA-256 over this stable representation is the content hash.

The same normalized content therefore produces the same hash on Windows and Linux. An unchanged hash does not increment the Rule Set revision or replace the cache.

## Status model

| Status     | Meaning                                                                     |
| ---------- | --------------------------------------------------------------------------- |
| `READY`    | A non-empty valid cache is available.                                       |
| `UPDATING` | A refresh is currently in flight.                                           |
| `STALE`    | The latest refresh failed, but Last Known Good remains usable.              |
| `ERROR`    | Refresh failed and no usable cache exists.                                  |
| `DISABLED` | Administratively disabled; policy compilation is blocked.                   |
| `EMPTY`    | Validation succeeded with zero rules; compilation continues with a warning. |

`STALE` subscriptions compile from the retained cache and include `RULE_SET_STALE`. `ERROR`, missing, and disabled references are compile errors.

## Refresh and usage

Remote sources support manual refresh and optional intervals of at least five minutes. The single-controller scheduler checks due records once per minute and staggers them by 250 ms. An in-flight map coalesces concurrent refresh requests for the same Rule Set.

Conditional requests use stored `ETag` and `Last-Modified`. A `304` updates fetch/success timestamps without parsing, replacing cache content, or increasing the revision. Parser, validation, timeout, size, and network failures never overwrite Last Known Good.

The Rule Sets page displays referencing Policies. Deleting a referenced Rule Set returns `RULE_SET_IN_USE` with safe Policy IDs and names. Disablement is allowed but creates a high-value notification because it blocks those Policy compiles.

## Import and export

Manual imports always run Parse Preview before confirmation. `REPLACE` atomically replaces entry rows, then rebuilds normalized cache; API callers may also append. Export uses ProxyHub Native JSON and excludes internal database fields and secrets. Remote export contains safe metadata and normalized cached rules, not source credentials or raw response content.

The UI renders at most 50 cached preview rows and 200 filtered manual entries at once, avoiding direct rendering of very large sources.
