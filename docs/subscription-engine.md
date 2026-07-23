# Subscription Engine

## Lifecycle

An administrator creates a Subscription with a name, enabled state, Policy, fixed format, and optional expiration. Supported formats are `mihomo`, `sing-box`, and `raw`.

The server generates 32 cryptographically secure random bytes and returns the token once. SQLite stores only:

- SHA-256 token hash for lookup
- eight-character token prefix for administration

Rotation replaces the hash atomically, so the old URL immediately returns `SUBSCRIPTION_TOKEN_INVALID`. Full tokens, hashes, Reality private keys, and encryption secrets are excluded from audit metadata.

## Public endpoint

`GET /sub/:token` requires no administrator session. It validates, in order:

1. token hash exists;
2. Subscription is enabled;
3. expiration has not passed;
4. Policy exists and is enabled;
5. policy-core compilation succeeds.

Responses use format-appropriate content types, `Cache-Control: private, no-store`, and a content-derived SHA-256 ETag. Both `200` and conditional `304` accesses update `lastAccessAt`; that database timestamp never changes the content or ETag. The credential-bearing response is deliberately not cacheable by shared or private caches. The endpoint is limited to 30 requests per minute per effective client IP. `TRUST_PROXY` is disabled by default outside Compose and must only be enabled behind the trusted Caddy hop. Automatic request logs replace the complete token path segment with `[REDACTED]`.

V0.3 Rule Set references are resolved exclusively from local normalized cache. Public subscription requests never fetch remote providers. A retained `STALE` cache keeps the subscription available with an internal warning; unavailable or disabled references produce the same sanitized external compile-failure response used by inline policies. Fetch timestamps and remote validators do not enter output or ETag.

Query parameters cannot override the administrator-bound format.

## Failure status

- Invalid/rotated token: `404 SUBSCRIPTION_TOKEN_INVALID`
- Disabled subscription: `403 SUBSCRIPTION_DISABLED`
- Expired subscription: `410 SUBSCRIPTION_EXPIRED`
- Invalid policy/compiler failure: `422 SUBSCRIPTION_COMPILE_FAILED` with a stable external message and no rule/database identifiers

Compile failures create a critical notification. Successful routine fetches do not create notifications, preventing notification spam.

Administrator list/detail responses expose only the safe token prefix, never `tokenHash`. An invalid token and a rotated token return the same `404` body. Enabled/expired state responses remain distinct for a caller already possessing an unguessable 256-bit token; this is an intentional operational tradeoff, not a searchable identifier surface.

## Release status

The full public endpoint, reverse proxy, HTTPS, restart persistence, and client import flows still require the Linux deployment checklist. **V0.1.1 Linux Production Smoke Test Pending** remains a release gate.
