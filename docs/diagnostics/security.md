# Diagnostics security boundary

All diagnostics routes require an authenticated `ADMIN` session and use existing rate limiting. Deep scans and exports have additional per-route limits. Server-to-Agent collection retains the existing bearer-token authentication, and request logging redacts authorization and cookies.

Diagnostics never mounts Docker Socket, exposes a shell, accepts a target host, scans arbitrary ports, fetches a remote Rule Set, starts a Reality compatibility process, or adds privileges. Safe checks have fixed inputs, timeouts, bounded output, and concurrency limits.

Security summaries expose configured booleans and counts only: authentication, 2FA availability, secure-cookie mode, trusted proxy, rate limiting, audit logging, encryption configuration, recent failed audits, unread notifications, and recent critical notifications. They do not expose notification messages, keys, token hashes, usernames, IPs, user agents, session details, or audit metadata.
