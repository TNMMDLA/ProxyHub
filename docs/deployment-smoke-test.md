# ProxyHub V0.1.1 Linux VPS Deployment Smoke Test

Run this checklist on a disposable Linux VPS before declaring V0.1.1 production-ready. Do not run destructive or deliberate failure cases against an active production deployment.

## 1. Prerequisites

- Linux VPS with Docker Engine 24+ and Docker Compose v2
- Public DNS record pointing to the VPS
- Inbound TCP 80/443 and UDP 443 allowed
- An additional TCP port available for the Reality node test
- Repository checked out at the V0.1.1 revision

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
- `proxyhub-server`: running
- `proxyhub-agent`: healthy
- `xray`: healthy
- `caddy`: running

The Xray build must resolve the fixed `ghcr.io/xtls/xray-core:26.5.9` image, never `latest`.

Inspect startup without exposing environment values:

```bash
docker compose logs --tail=200 proxyhub-server proxyhub-agent xray caddy
```

## 4. Database migration

```bash
docker compose exec proxyhub-server \
  pnpm --filter @proxyhub/server exec prisma migrate status
```

Expected: one migration is present and the database schema is up to date. Restart the stack once and confirm the SQLite volume retains the same administrator and server records.

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

1. Create a VLESS Reality node using `$REALITY_HOST` and `$REALITY_PORT`.
2. Confirm the UI reports successful synchronization, not only database creation.
3. Confirm UUID, X25519 public key, Short ID, Vision flow, share URI, and QR code exist.
4. Confirm no private key appears in API responses, notifications, or logs.

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

Use **Servers → Restart Xray**. Verify the request waits for restart acknowledgement and returns only after health is `HEALTHY`.

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

## 13. Final acceptance

```bash
docker compose ps
docker compose exec xray xray run -test -config /etc/xray/config.json
curl --fail --silent --show-error "https://${PANEL_DOMAIN}/api/health"
docker compose logs --since=10m proxyhub-server proxyhub-agent xray caddy
```

V0.1.1 passes only when all services remain healthy, the browser has no runtime errors, successful Node changes reach Xray, failed changes preserve the prior configuration and database state, and pool/audit/notification flows all match the UI.
