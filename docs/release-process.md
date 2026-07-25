# Release Process

`release/version.json` is the canonical ProxyHub runtime version source. Workspace package versions
are private package-manager metadata (`0.0.0`) and must not be used as the application version. The
generated shared TypeScript constant is checked against the source file in CI.

## Build identity

Every release records:

- ProxyHub version
- full and 12-character Git SHA
- UTC build time
- build environment and deploy mode
- fixed Xray version
- deterministic fingerprint of all checked-in Prisma migrations
- repository, tag, and digest for Web, Server, Agent, and the ProxyHub Xray runtime

`GET /api/health` returns this public identity without environment values, paths, tokens, or
secrets. The Settings page displays the same identity.

## Manifest

Generate a dry-run manifest:

```bash
pnpm release:manifest -- \
  --output artifacts/release-manifest.json \
  --git-sha "$(git rev-parse HEAD)" \
  --mode dry-run
```

Release mode rejects any image without a `sha256:` digest:

```bash
pnpm release:manifest:validate -- \
  --manifest artifacts/release-manifest.json \
  --mode release
```

The schema is `release/manifest.schema.json`. Unknown fields and secret-like keys are rejected.

## GitHub Actions behavior

`.github/workflows/release.yml` has three modes:

- pull request or branch push: build and load images, do not publish
- manual workflow: dry run by default; optional immutable dev-SHA publication
- future `v*` tag: publish the exact tag and digest-pinned manifest

No workflow publishes `latest`. Images include OCI source, revision, version, and creation labels.
The workflow runs all five services, verifies restart count zero and build metadata, exercises
SQLite backup/verification and dry-run operations, and simulates a failed update in an isolated
Compose project.

Creating a Git tag or GitHub Release is deliberately outside V0.3.1 Phase 1 implementation work.
