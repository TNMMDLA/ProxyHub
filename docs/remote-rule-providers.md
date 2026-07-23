# Remote Rule Providers

Remote Rule Sets convert an external HTTPS document into ProxyHub's unified Rule Set model:

```text
HTTPS source -> Fetcher -> Parser -> Normalizer -> Validator -> Atomic cache -> Policy resolver
```

Supported source formats and examples are documented in [rule-sets.md](rule-sets.md). Remote sources are not passed through directly to Mihomo or sing-box. ProxyHub downloads and validates them independently, then adapters receive the same local normalized model.

## Fetch behavior

- Production permits HTTPS only. `RULE_SET_ALLOW_HTTP=false` is the default and should remain false on a VPS.
- Redirects are manual and limited to three by default. Every target repeats scheme, credentials, DNS, and IP checks.
- DNS is resolved before connecting. The request connects to the selected validated IP while retaining the original HTTP `Host` and TLS SNI hostname.
- Compressed responses are limited after gzip, deflate, or Brotli decompression. Default limit: 5 MiB.
- Default timeout: 10 seconds. Maximum normalized rules: 50,000.
- Unsupported entries are reported and skipped. If more than 25% of candidate lines are unsupported, or any malformed/invalid entry is present, refresh fails and preserves Last Known Good.

## Conditional refresh

On a successful `200`, ProxyHub records response `ETag` and `Last-Modified`. Later requests send `If-None-Match` and `If-Modified-Since`. A `304` is a successful unchanged refresh and does not parse or rewrite the cache.

Routine successful refreshes do not generate notifications. State transitions to `STALE`/`ERROR` and recovery to `READY` do. Repeated identical failures are deduplicated while their warning remains unread.

## Operational API

- `POST /api/rule-sets/test-source` validates and previews without saving.
- `POST /api/rule-sets/:id/refresh` performs an immediate refresh.
- `GET /api/rule-sets/:id/preview?offset=0&limit=50` reads a bounded local-cache page.

Automatic refresh is intentionally a lightweight single-controller scheduler, not a distributed job system. V0.3 does not add authentication headers, OAuth, a public catalog, or a sharing marketplace.
