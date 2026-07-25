# Low-resource VPS Operations

The target smoke-test host has approximately 1 CPU, 848 MiB RAM, 1 GiB swap, and limited disk.
Production builds therefore run in GitHub Actions; the VPS only pulls immutable images.

## Preflight thresholds

- RAM below 1 GiB: warning
- RAM below 512 MiB: hard stop unless `--allow-low-resources`
- free disk below 2 GiB: warning
- free disk below 1 GiB: hard stop unless overridden
- no swap: warning

An override acknowledges risk; it does not change system memory or disk.

## Resource behavior

- only one deploy/update/rollback/backup mutation runs at a time;
- images pull sequentially;
- health checks use bounded polling and timeouts;
- backups use moderate gzip compression;
- temporary files are removed after success/failure;
- Docker log rotation is `10m` × 3 for Web, Server, Agent, Xray, and Caddy;
- no operation runs `docker system prune`.

Before an update, check:

```bash
free -h
df -h /opt/proxyhub
docker system df
scripts/ops/preflight.sh --manifest release-manifest.json
```

If disk is tight, remove only explicitly identified obsolete data after independent review. Never
delete ProxyHub volumes or unknown backup files to satisfy preflight.
