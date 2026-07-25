#!/usr/bin/env bash
set -euo pipefail

services=(xray proxyhub-agent proxyhub-server proxyhub-web caddy)
deadline=$((SECONDS + 150))

while (( SECONDS < deadline )); do
  all_healthy=true
  for service in "${services[@]}"; do
    container_id="$(docker compose ps -q --all "$service")"
    if [[ -z "$container_id" ]]; then
      all_healthy=false
      continue
    fi

    state="$(docker inspect --format '{{.State.Status}}' "$container_id")"
    if [[ "$state" == "exited" || "$state" == "dead" ]]; then
      echo "$service entered terminal state: $state" >&2
      docker compose logs --no-color "$service" >&2
      exit 1
    fi

    health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$container_id")"
    if [[ "$state" != "running" || "$health" != "healthy" ]]; then
      all_healthy=false
    fi
  done

  if [[ "$all_healthy" == "true" ]]; then
    break
  fi
  sleep 2
done

for service in "${services[@]}"; do
  container_id="$(docker compose ps -q --all "$service")"
  state="$(docker inspect --format '{{.State.Status}}' "$container_id")"
  health="$(docker inspect --format '{{.State.Health.Status}}' "$container_id")"
  restart_count="$(docker inspect --format '{{.RestartCount}}' "$container_id")"
  if [[ "$state" != "running" || "$health" != "healthy" || "$restart_count" != "0" ]]; then
    echo "$service failed runtime smoke: state=$state health=$health restarts=$restart_count" >&2
    docker compose logs --no-color "$service" >&2
    exit 1
  fi
  echo "$service: state=$state health=$health restarts=$restart_count"
done

docker compose exec -T proxyhub-server node -e \
  "fetch('http://127.0.0.1:3000/api/health').then(async response => { const body = await response.json(); const d=body?.data; if (!response.ok || body?.success !== true || d?.status !== 'ok' || typeof d?.version !== 'string' || typeof d?.gitSha !== 'string' || typeof d?.buildTime !== 'string' || d?.xrayVersion !== '26.5.9' || !/^[0-9a-f]{64}$/.test(d?.database?.migrationFingerprint ?? '')) process.exit(1); console.log(JSON.stringify(body)); }).catch(error => { console.error(error); process.exit(1); })"

docker compose exec -T proxyhub-server sqlite3 --version
database_integrity="$(
  docker compose exec -T proxyhub-server sqlite3 /app/data/proxyhub.db 'PRAGMA integrity_check;'
)"
if [[ "$database_integrity" != "ok" ]]; then
  echo "Runtime SQLite integrity check failed: $database_integrity" >&2
  exit 1
fi

mkdir -p \
  .proxyhub/state/releases/history \
  .proxyhub/state/releases/manifests \
  .proxyhub/state/transactions \
  .proxyhub/state/diagnostics/runtime-fixture \
  backups
cat >.proxyhub/state/releases/current.json <<'EOF'
{"releaseId":"runtime-fixture","version":"0.3.1-dev","gitSha":"0000000000000000000000000000000000000000","deployMode":"source","deployedAt":"2026-01-01T00:00:00Z","transactionId":"runtime-fixture"}
EOF
cat >.proxyhub/state/transactions/runtime-fixture.json <<'EOF'
{"transactionId":"runtime-fixture","operation":"deploy","currentStage":"HEALTH_VERIFIED","updatedAt":"2026-01-01T00:00:00Z"}
EOF
cat >.proxyhub/state/releases/manifests/runtime-fixture.json <<'EOF'
{"schemaVersion":1,"releaseId":"runtime-fixture","version":"0.3.1-dev","gitSha":"0000000000000000000000000000000000000000"}
EOF
backup_fixture="$(mktemp -d)"
trap 'rm -rf "$backup_fixture"' EXIT
cat >"$backup_fixture/manifest.json" <<'EOF'
{"schemaVersion":1,"application":{"name":"ProxyHub","version":"0.3.1-dev","gitSha":"0000000000000000000000000000000000000000","xrayVersion":"26.5.9"},"createdAt":"2026-01-01T00:00:00.000Z","database":{"filename":"database.sqlite","sizeBytes":7,"sha256":"1111111111111111111111111111111111111111111111111111111111111111","integrity":"ok","migrationFingerprint":"2222222222222222222222222222222222222222222222222222222222222222"},"encryptionKeyIncluded":false}
EOF
printf 'fixture' >"$backup_fixture/database.sqlite"
tar -czf backups/proxyhub-backup-20260101T000000Z-000000000000.tar.gz \
  -C "$backup_fixture" database.sqlite manifest.json

docker compose exec -T proxyhub-server node --input-type=module <<'EOF'
const base = 'http://127.0.0.1:3000';
const credentials = {
  username: 'runtime-admin',
  password: 'runtime-smoke-password-123',
};
let authentication = await fetch(`${base}/api/auth/bootstrap`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(credentials),
});
if (authentication.status === 409) {
  authentication = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(credentials),
  });
}
if (!authentication.ok) {
  throw new Error(`Diagnostics fixture authentication failed: ${authentication.status}`);
}
const cookie = authentication.headers.get('set-cookie')?.split(';')[0];
if (!cookie) throw new Error('Diagnostics fixture authentication did not issue a session cookie');
const authenticated = (path, init = {}) =>
  fetch(`${base}${path}`, { ...init, headers: { cookie, ...(init.headers ?? {}) } });
const overview = await authenticated('/api/diagnostics/overview');
const overviewBody = await overview.json();
if (!overview.ok || !overviewBody?.success || overviewBody.data?.kind !== 'overview') {
  throw new Error(`Diagnostics overview failed: ${JSON.stringify(overviewBody)}`);
}
for (const id of ['runtime.server.health', 'database.sqlite.health', 'storage.database.filesystem']) {
  if (!overviewBody.data.items.some((item) => item.id === id)) {
    throw new Error(`Diagnostics overview is missing ${id}`);
  }
}
const [deepOne, deepTwo] = await Promise.all([
  authenticated('/api/diagnostics/run', { method: 'POST' }),
  authenticated('/api/diagnostics/run', { method: 'POST' }),
]);
const deepResponses = await Promise.all([deepOne.json(), deepTwo.json()]);
if (!deepResponses.some((body) => body?.success && body.data?.kind === 'deep')) {
  throw new Error('No deep diagnostics request completed successfully');
}
const successfulDeep = deepResponses.find((body) => body?.success && body.data?.kind === 'deep');
const backup = successfulDeep?.data?.items?.find((item) => item.id === 'backup.archive.visibility');
if (backup?.details?.manifestVerification !== 'passed') {
  throw new Error(`Backup manifest validation failed: ${JSON.stringify(backup)}`);
}
if (!deepResponses.some((body) => body?.error?.code === 'DIAGNOSTICS_SCAN_BUSY')) {
  throw new Error('Concurrent deep diagnostics request was not rejected as busy');
}
const exported = await authenticated('/api/diagnostics/export');
const exportedBody = await exported.json();
if (!exported.ok || !exportedBody?.success || exportedBody.data?.kind !== 'export') {
  throw new Error('Diagnostics export failed');
}
const serialized = JSON.stringify(exportedBody);
const sensitiveKey =
  /(authorization|cookie|token|secret|password|private.?key|uuid|short.?id|database_url)/i;
const hasUnredactedSensitiveKey = (value, key = '') => {
  if (sensitiveKey.test(key)) return value !== '[REDACTED]';
  if (Array.isArray(value)) return value.some((entry) => hasUnredactedSensitiveKey(entry));
  if (value && typeof value === 'object') {
    return Object.entries(value).some(([entryKey, entry]) =>
      hasUnredactedSensitiveKey(entry, entryKey),
    );
  }
  return false;
};
const forbiddenValues = [
  process.env.AGENT_TOKEN,
  process.env.ENCRYPTION_KEY,
  'runtime-smoke-password-123',
].filter(Boolean);
if (
  hasUnredactedSensitiveKey(exportedBody) ||
  forbiddenValues.some((value) => serialized.includes(value)) ||
  /(?:[a-z]:\\|\/(?:app|opt|home|root|run|etc|var|tmp)\/)/i.test(serialized)
) {
  throw new Error('Diagnostics export contains a forbidden secret or absolute path');
}
console.log(`Diagnostics runtime smoke passed with ${overviewBody.data.items.length} overview items.`);
EOF

for service in "${services[@]}"; do
  container_id="$(docker compose ps -q --all "$service")"
  log_driver="$(docker inspect --format '{{.HostConfig.LogConfig.Type}}' "$container_id")"
  max_size="$(docker inspect --format '{{index .HostConfig.LogConfig.Config "max-size"}}' "$container_id")"
  max_file="$(docker inspect --format '{{index .HostConfig.LogConfig.Config "max-file"}}' "$container_id")"
  if [[ "$log_driver" != "json-file" || "$max_size" != "10m" || "$max_file" != "3" ]]; then
    echo "$service log rotation is invalid: $log_driver $max_size $max_file" >&2
    exit 1
  fi
done

docker compose exec -T -w /app/apps/agent proxyhub-agent node --input-type=module \
  < scripts/runtime/verify-xray-lifecycle.mjs

for service in "${services[@]}"; do
  container_id="$(docker compose ps -q --all "$service")"
  state="$(docker inspect --format '{{.State.Status}}' "$container_id")"
  restart_count="$(docker inspect --format '{{.RestartCount}}' "$container_id")"
  if [[ "$state" != "running" || "$restart_count" != "0" ]]; then
    echo "$service changed state during Reality compatibility smoke: state=$state restarts=$restart_count" >&2
    exit 1
  fi
done

echo "Production Compose runtime smoke test passed."
