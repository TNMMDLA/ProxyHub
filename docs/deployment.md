# Fresh Image Deployment

Fresh production deployment uses prebuilt immutable images. The VPS does not build Node, Web, or
Xray images.

## Prepare

```bash
git clone https://github.com/TNMMDLA/ProxyHub.git /opt/proxyhub
cd /opt/proxyhub
cp .env.example .env
chmod 0600 .env
editor .env
```

Set unique `ENCRYPTION_KEY` and `AGENT_TOKEN` values, then configure `PANEL_DOMAIN` and
`WEB_ORIGIN`. Preserve the encryption key in a separate secure system; database backups do not
contain it.

Obtain the release manifest artifact from the matching successful GitHub Actions run and verify
its provenance and Git SHA.

## Validate and deploy

```bash
scripts/ops/preflight.sh --manifest /opt/proxyhub/releases/release-manifest.json
scripts/ops/deploy.sh \
  --manifest /opt/proxyhub/releases/release-manifest.json \
  --yes
scripts/ops/health.sh \
  --manifest /opt/proxyhub/releases/release-manifest.json
```

Deployment acquires the global lock, repeats preflight, stores the immutable manifest, pulls images
sequentially, starts the five services, waits for migrations and health, checks the expected version
and Git SHA, then atomically commits current release state.

If health fails, the new containers are stopped, volumes and database are preserved, and
redacted diagnostics are captured. The command never removes Docker volumes or globally prunes
images.

The source-build `docker compose up -d --build` workflow remains available for local evaluation.
Production should use `docker-compose.release.yml` through the operations scripts.

## Pending acceptance

Passing CI is not production acceptance. The real Hong Kong VPS still requires:

- Reality Target Compatibility Hotfix deployment and verification
- V0.3.1 Phase 1 fresh/update/rollback/backup smoke testing
