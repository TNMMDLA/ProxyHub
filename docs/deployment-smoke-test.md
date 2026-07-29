# ProxyHub V0.1.1 / V0.2.1 / V0.3 Linux VPS Deployment Smoke Test

Run this checklist on a disposable Linux VPS before declaring ProxyHub production-ready. The current release status remains **Linux Production Smoke Test Pending**. A green CI run is necessary but is not a substitute for this host-level test. Do not run destructive or deliberate failure cases against an active production deployment.

## 1. Prerequisites

- Linux VPS with Docker Engine 24+ and Docker Compose v2
- Public DNS record pointing to the VPS
- Inbound TCP 80/443 and UDP 443 allowed
- An additional TCP port available for the Reality node test
- Repository checked out at the V0.3 revision under test

Record these values without committing them:

```bash
export PANEL_DOMAIN=panel.example.com
export REALITY_HOST=node.example.com
export REALITY_PORT=24443
```

## 2. Production environment

```bash
cp .env.example .env
openssl rand -base64 32
openssl rand -base64 32
chmod 600 .env
```

Edit `.env` and replace, at minimum:

- `PANEL_DOMAIN` with the public panel hostname
- `WEB_ORIGIN` with `https://<PANEL_DOMAIN>`
- `ENCRYPTION_KEY` with the first generated secret
- `AGENT_TOKEN` with the second generated secret

Confirm no placeholder remains:

```bash
grep -n 'replace-with' .env && echo 'FAIL: replace every placeholder' || true
```

Do not print `.env` in logs or attach it to a bug report.

## 3. Compose validation and startup

```bash
docker compose config --quiet
docker compose build --pull
docker compose up -d
docker compose ps
```

Expected services:

- `proxyhub-web`: running
- `proxyhub-server`: healthy, with zero restart loops
- `proxyhub-agent`: healthy
- `xray`: healthy
- `caddy`: running

The Xray build must resolve the fixed `ghcr.io/xtls/xray-core:26.5.9` image, never `latest`.

Before startup, also run the same Linux compatibility gate used by CI:

```bash
pnpm install --frozen-lockfile
bash scripts/compat/validate-linux.sh
```

Expected: release-asset checksums match and both Mihomo `v1.19.28` and sing-box `1.13.12` accept the generated configuration. This validates the official CLI cores, not any GUI client's import behavior.

Inspect startup without exposing environment values:

```bash
docker compose logs --tail=200 proxyhub-server proxyhub-agent xray caddy
```

## 4. Database migration

```bash
docker compose exec proxyhub-server \
  pnpm --filter @proxyhub/server exec prisma migrate status
```

Expected: the foundation, additive V0.2, additive V0.3, and additive V0.4 migrations are present and the database schema is up to date. Confirm `Policy`, `PolicyRule`, `Subscription`, `RuleSet`, `RuleSetEntry`, `RuleSetCache`, `NetworkPerformanceRun`, and `NetworkPerformanceTargetResult` exist without rebuilding or dropping prior tables. Restart the stack once and confirm the SQLite volume retains the same administrator, server, node, pool, policy, rule, subscription, and performance-history records.

## 5. Backend and HTTPS

```bash
curl --fail --silent --show-error "https://${PANEL_DOMAIN}/api/health"
curl --fail --head "https://${PANEL_DOMAIN}/"
```

Verify:

- `/api/health` returns `success: true`
- Caddy serves a trusted certificate for the configured hostname
- HTTP redirects to HTTPS
- TLS hostname and certificate chain are valid
- Ports 3000 and 3001 are not publicly reachable

## 6. Administrator, login, and 2FA

1. Open `https://<PANEL_DOMAIN>`.
2. Create the first administrator with a unique password of at least 12 characters.
3. Log out and log back in.
4. Open **Security**, enable TOTP, and save all ten recovery codes offline.
5. Log out, verify TOTP login, then verify one recovery code can be used only once.
6. Confirm active sessions are listed and **Log out all** revokes them.

## 7. Baseline Xray health

```bash
docker compose exec xray xray version
docker compose exec xray xray run -test -config /etc/xray/config.json
docker compose exec xray sh -c 'kill -0 "$(cat /var/run/proxyhub/xray.pid)"'
```

Open **Servers** and verify the unified status is `HEALTHY`. Its checks must show:

- Xray process running
- companion-container heartbeat fresh
- current config valid
- all configured inbound ports listening

## 8. Node create and full configuration lifecycle

1. Leave the recommended new-node SNI and target at `dl.google.com` / `dl.google.com:443`, or enter the target being evaluated. This is a recommendation, not a compatibility guarantee.
2. Click **Test Reality compatibility** and confirm TLS precheck, Reality handshake, and end-to-end traffic are displayed as separate stages.
3. Confirm changing SNI or Target clears the previous result.
4. Create a VLESS Reality node using `$REALITY_HOST` and `$REALITY_PORT`. The backend must repeat the live preflight before database mutation.
5. Confirm the UI reports successful synchronization, not only database creation.
6. Confirm UUID, X25519 public key, Short ID, Vision flow, share URI, and QR code exist.
7. Confirm no private key appears in API responses, notifications, or logs.
8. Confirm the compatibility test did not change `/etc/xray/config.json`, restart the formal Xray container, expose a temporary port publicly, or leave temporary config files/processes.

```bash
docker compose exec xray xray run -test -config /etc/xray/config.json
docker compose exec xray sh -c 'kill -0 "$(cat /var/run/proxyhub/xray.pid)"'
ss -lnt | grep ":${REALITY_PORT} "
```

Verify the lifecycle order in logs:

1. database transaction begins
2. all enabled nodes are compiled
3. temporary config is validated
4. active config is replaced atomically
5. supervisor acknowledges the restart token
6. process/config/port health becomes healthy
7. transaction commits and rollback backup is confirmed

Repeat for edit, disable, enable, clone, and delete. Disabled and deleted node ports must disappear from the generated config after a successful apply.

## 9. Validation failure and rollback (staging VPS only)

Before the negative test:

```bash
docker compose exec xray sha256sum /etc/xray/config.json
```

Submit a node change known to be rejected by `xray run -test`. Verify:

- the API returns an error
- the Node database mutation is absent after the request
- the active config checksum is unchanged, or the previous revision was restored
- the previous Xray PID/config remains healthy
- a failure Audit Log exists
- a Critical Notification exists
- no `.next-*` or `.validation-*` temporary file remains

If the new config validates but the restarted process or port health fails, verify Agent restores the revision backup, acknowledges the rollback restart, and returns an error to the controller.

## 10. Restart and health recovery

Use **Servers -> Restart Xray**. Verify the request waits for restart acknowledgement and returns only after health is `HEALTHY`.

```bash
docker compose ps
docker compose logs --since=2m proxyhub-agent xray
```

## 11. Node Pool CRUD

1. Create a pool with multiple nodes selected in one save.
2. Verify Total, Healthy, Offline, and member list values.
3. Edit its name, region, strategy, and membership.
4. Remove one node and batch-add it again.
5. Disable and re-enable the pool.
6. Delete the pool and verify `NodePoolMember` relationships disappear while Nodes remain.

## 12. Audit and notifications

Verify success Audit Logs and Notifications exist for applied node changes. Mark one notification read, then mark all remaining notifications read. Verify the unread badge updates.

For the staging failure test, verify the audit result is `FAILURE`, the notification level is `CRITICAL`, and sensitive keys are redacted.

## 13. V0.2 Policy Studio and Subscription Engine

### Policy Studio

1. Create an enabled policy and set its default action.
2. Add at least two rules, reorder them by drag and drop, reload, and confirm the order persists.
3. Disable a rule and confirm it is excluded from compilation without being deleted.
4. Compile Mihomo, sing-box, and raw VLESS previews. Confirm repeated compilation is byte-for-byte deterministic.
5. Confirm unsupported rule types produce visible diagnostics and are never silently ignored.
6. Reference a disabled or empty node pool and confirm compilation reports a blocking diagnostic.
7. Confirm deleting a referenced node pool is rejected with its policy/rule references listed.

### Subscription Engine

1. Create one subscription for each supported format and record each returned token only from the one-time modal.
2. Confirm the database stores a SHA-256 token hash and safe prefix, never the plaintext token.
3. Request `/sub/<token>` and verify format-specific content type, private cache headers, and ETag behavior (`If-None-Match` returns `304`).
4. Rotate a token and confirm the old URL immediately returns `404` while the new URL works.
5. Disable and expire subscriptions and confirm they return `403` and `410` respectively.
6. Exceed the public endpoint rate limit and confirm `429` without token disclosure in logs.
7. Verify preview output masks UUIDs by default and full output requires the explicit reveal action.
8. Verify audit logs and compile-failure notifications contain subscription IDs/prefixes only, never tokens.

### Responsive and runtime checks

1. Exercise Policy Studio and Subscriptions at desktop width and at 390 px.
2. Confirm cards, dialogs, diagnostics, and navigation remain usable without horizontal page overflow.
3. Confirm the browser console and failed-network-request list contain no unexpected errors.

## 14. V0.3 Rule Sets

1. Create a Manual Rule Set, bulk-import OpenAI domain rules, inspect the preview/hash, export Native JSON, and reference it from Policy Studio.
2. Confirm Mihomo/sing-box previews expand the rules at the PolicyRule card position while Raw output remains unchanged.
3. Create a Remote HTTPS Rule Set using a controlled public source. Test Source, refresh, conditional `304`, and automatic interval refresh.
4. Make the source return invalid content. Confirm status becomes `STALE`, the previous content hash/cache remains, and subscriptions still compile with `RULE_SET_STALE`.
5. Restore valid changed content. Confirm `READY`, one recovery notification, new hash/revision, and updated subscriptions.
6. Test a source with no prior cache and a failure; confirm `ERROR` and compile failure.
7. Confirm private/loopback/metadata URLs, userinfo, HTTP, and redirect-to-private targets are rejected without query secrets in logs, Audit Logs, notifications, or errors.
8. Disable a referenced Rule Set and confirm a high-value notification and blocking diagnostic. Confirm delete returns `RULE_SET_IN_USE` until the Policy reference is removed.
9. Exercise Rule Sets and Policy Studio at 390 px with no horizontal overflow or browser console warnings.

## 15. Final acceptance

Before final acceptance, complete the V0.4 Phase 1 performance test with controlled HTTPS targets:

1. Configure one to five targets in `PROXYHUB_NETWORK_PERF_TARGETS_JSON`, keep `PROXYHUB_NETWORK_PERF_TEST_MODE=false`, and restart only the services needed to load the environment.
2. Record the formal Xray PID and `sha256sum /etc/xray/config.json`.
3. From **Nodes**, open an enabled VLESS/TCP/REALITY/Vision node and start **Network Performance Test**.
4. Confirm the UI explicitly says the test runs from the ProxyHub server and does not represent the final user's ISP-to-VPS path.
5. Confirm the run progresses through preparation, tunnel establishment, target testing, and calculation, then shows direct/tunnel throughput, efficiency, latency median/p95, jitter, success rate, ratings, analysis, and safe environment metadata.
6. Start a second run while the first is active and confirm the stable busy response. Cancel the first and confirm `CANCELLED`.
7. Exercise a controlled partial target failure and a controlled timeout. Confirm `PARTIAL`/`FAILED` states are visible, no fake metrics appear, and the Agent accepts a later run.
8. Confirm at most ten recent records remain for the node and Diagnostics shows only the lightweight summary without starting traffic.
9. Recheck the formal Xray PID and config checksum; both must be unchanged.
10. Search Server/Agent/Caddy logs, audit metadata, notifications, and API responses for the node UUID, Reality private key, Agent token, or target query secrets. None may appear.
11. Confirm no recognized benchmark temporary directory/process remains after success, failure, cancellation, or timeout.

This is a server-side benchmark only. Separately test real client traffic from the intended user networks; do not infer end-user speed from this result.

### V0.4 Phase 2 users and traffic

1. Create a user group and a user with a small test quota, future expiration, monthly reset day, and access to two VLESS/TCP/REALITY/Vision nodes.
2. Confirm each affected inbound retains its legacy client and adds one managed client. Confirm the UUID is identical across both nodes while each client email/stats identity differs and contains no user name.
3. Import each explicit node share link in a test client and generate controlled uplink and downlink traffic.
4. Wait at least one `PROXYHUB_TRAFFIC_ACCOUNTING_INTERVAL_MS`, then confirm per-node, current-cycle, lifetime, uplink, and downlink values increase without Demo Data.
5. Poll again without traffic and confirm totals do not increase. Restart Xray, generate more traffic, and confirm lifetime totals survive the Xray counter reset.
6. Reach the exact quota and confirm one transition notification, one audit event, one full Xray apply, and loss of access on every authorized node. Confirm the legacy clients continue working.
7. Increase the quota and confirm access returns once. Disable the user manually, reset traffic, and confirm manual disable still wins until an administrator enables the user.
8. Set expiration a few minutes ahead, wait through it, and confirm the user becomes `EXPIRED` and is removed from every node. Extend expiration and confirm reactivation.
9. Rotate the credential. Confirm the old link stops working on every authorized node and newly requested links work.
10. Disable, enable, revoke, and batch-grant node access. Confirm the Users page and each Node's authorized-user view agree.
11. Stop or make Xray validation fail during a user change. Confirm the API rejects the database change, the previous config remains active or is rolled back, and a critical notification plus failure audit is recorded without credentials.
12. Confirm the Xray metrics listener is not published on a host/public port. Search API responses, logs, audit metadata, notifications, and diagnostics exports for the managed UUID, private keys, Agent token, encryption key, or authorization headers.

```bash
docker compose ps
docker compose exec xray xray run -test -config /etc/xray/config.json
curl --fail --silent --show-error "https://${PANEL_DOMAIN}/api/health"
docker compose logs --since=10m proxyhub-server proxyhub-agent xray caddy
```

ProxyHub passes only when all services remain healthy, the browser has no runtime errors, failed Node and Rule Set updates preserve their respective Last Known Good state, audit/notification flows match the UI, all policy adapters compile deterministically with explicit diagnostics, and subscription token lifecycle checks pass. Separately record GUI import results for the clients listed in the compatibility matrix; do not infer GUI compatibility from a CLI-only pass.
