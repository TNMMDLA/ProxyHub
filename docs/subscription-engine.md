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

Responses use format-appropriate content types, `Cache-Control: private, no-cache`, and a SHA-256 ETag. Successful access updates `lastAccessAt`. The endpoint is rate limited. Automatic request logs redact the token path.

Query parameters cannot override the administrator-bound format.

## Failure status

- Invalid/rotated token: `404 SUBSCRIPTION_TOKEN_INVALID`
- Disabled subscription: `403 SUBSCRIPTION_DISABLED`
- Expired subscription: `410 SUBSCRIPTION_EXPIRED`
- Invalid policy/compiler failure: `422 SUBSCRIPTION_COMPILE_FAILED`

Compile failures create a critical notification. Successful routine fetches do not create notifications, preventing notification spam.

## Release status

The full public endpoint, reverse proxy, HTTPS, restart persistence, and client import flows still require the Linux deployment checklist. **V0.1.1 Linux Production Smoke Test Pending** remains a release gate.
