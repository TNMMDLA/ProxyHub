# Rule Set Security

Remote Rule Set URLs are an SSRF boundary. ProxyHub validates every initial URL and redirect before opening a connection.

## SSRF controls

- HTTPS only in production; `file`, `ftp`, `gopher`, `data`, `javascript`, and all other schemes are rejected.
- URL userinfo (`https://user:pass@host`) is rejected.
- `localhost`, loopback, unspecified, private IPv4, CGNAT, link-local, multicast/reserved ranges, IPv6 ULA, IPv6 link-local, and IPv4-mapped IPv6 forms are rejected.
- Decimal and hexadecimal IPv4 host forms are normalized by the WHATWG URL parser and then checked.
- All DNS answers must be public. A hostname resolving to any blocked address is rejected.
- The validated IP is the connection target; TLS SNI and `Host` use the original hostname. This prevents a second uncontrolled resolver lookup from creating a DNS-rebinding gap.
- Every redirect repeats validation and the redirect count is bounded.

## Resource controls

`RULE_SET_MAX_BYTES` defaults to 5 MiB and applies to the decompressed byte stream, not only `Content-Length`. Incorrect lengths and chunked oversized bodies are aborted. `RULE_SET_FETCH_TIMEOUT_MS` defaults to 10 seconds, redirects to three, and normalized rules to 50,000.

## Cache safety

Fetch, parse, normalize, validate, limit checks, and hashing must all succeed before one Prisma transaction replaces the cache. The old cache is never deleted first. A failure produces `STALE` when cache exists or `ERROR` when none exists.

The database stores normalized rules and validator metadata, not arbitrary authorization headers. V0.3 does not support secret request headers. Raw remote content is not written to normal logs or Audit Logs.

## Redaction

Source URLs in API summaries, Audit Logs, notifications, and error metadata have userinfo, query, and fragment removed. Generic secret redaction also strips URL query signatures plus password/token/TOTP/private-key/recovery-code fields recursively. Logs never contain response bodies.

Security tests cover private IPv4/IPv6, metadata endpoints, CGNAT, encoded numeric hosts, IPv4-mapped IPv6, private DNS answers, redirect-to-localhost, forbidden schemes, userinfo, Content-Length, chunked overflow, timeout, and query-token redaction.
