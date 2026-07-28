#!/usr/bin/env bash
set -euo pipefail

services=(xray proxyhub-agent proxyhub-server proxyhub-web caddy)
if docker compose config --services | grep -qx 'network-perf-fixture'; then
  services+=(network-perf-fixture)
fi
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
{"releaseId":"runtime-fixture","version":"0.4.0-dev","gitSha":"0000000000000000000000000000000000000000","deployMode":"source","deployedAt":"2026-01-01T00:00:00Z","transactionId":"runtime-fixture"}
EOF
cat >.proxyhub/state/transactions/runtime-fixture.json <<'EOF'
{"transactionId":"runtime-fixture","operation":"deploy","currentStage":"HEALTH_VERIFIED","updatedAt":"2026-01-01T00:00:00Z"}
EOF
cat >.proxyhub/state/releases/manifests/runtime-fixture.json <<'EOF'
{"schemaVersion":1,"releaseId":"runtime-fixture","version":"0.4.0-dev","gitSha":"0000000000000000000000000000000000000000"}
EOF
backup_fixture="$(mktemp -d)"
trap 'rm -rf "$backup_fixture"' EXIT
cat >"$backup_fixture/manifest.json" <<'EOF'
{"schemaVersion":1,"application":{"name":"ProxyHub","version":"0.4.0-dev","gitSha":"0000000000000000000000000000000000000000","xrayVersion":"26.5.9"},"createdAt":"2026-01-01T00:00:00.000Z","database":{"filename":"database.sqlite","sizeBytes":7,"sha256":"1111111111111111111111111111111111111111111111111111111111111111","integrity":"ok","migrationFingerprint":"2222222222222222222222222222222222222222222222222222222222222222"},"encryptionKeyIncluded":false}
EOF
printf 'fixture' >"$backup_fixture/database.sqlite"
tar -czf backups/proxyhub-backup-20260101T000000Z-000000000000.tar.gz \
  -C "$backup_fixture" database.sqlite manifest.json

docker compose exec -T -w /app/apps/server proxyhub-server node --input-type=module <<'EOF'
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
const diagnosticClientIp = `192.0.2.${((Date.now() + process.pid) % 254) + 1}`;
const performanceClientIp = `198.51.100.${((Date.now() + process.pid) % 254) + 1}`;
const authenticated = (path, init = {}) =>
  fetch(`${base}${path}`, {
    ...init,
    headers: {
      cookie,
      'x-forwarded-for': diagnosticClientIp,
      ...(init.headers ?? {}),
    },
  });
const performanceAuthenticated = (path, init = {}) =>
  authenticated(path, {
    ...init,
    headers: {
      'x-forwarded-for': performanceClientIp,
      ...(init.headers ?? {}),
    },
  });
const jsonRequest = (path, method, body) =>
  authenticated(path, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const performanceJsonRequest = (path, method, body) =>
  performanceAuthenticated(path, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const requestPublicSubscriptionThroughCaddy = async (path) => {
  const { request } = await import('node:https');
  return new Promise((resolve, reject) => {
    const outgoing = request(
      {
        hostname: 'caddy',
        port: 443,
        path,
        method: 'GET',
        servername: 'localhost',
        rejectUnauthorized: false,
        headers: { host: 'localhost' },
      },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () =>
          resolve({
            status: response.statusCode,
            contentType: response.headers['content-type'] ?? '',
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      },
    );
    outgoing.on('error', reject);
    outgoing.end();
  });
};

const setup = await authenticated('/api/setup/progress');
const setupBody = await setup.json();
if (!setup.ok || !setupBody?.success || setupBody.data?.totalSteps !== 9) {
  throw new Error(`Setup progress failed: ${JSON.stringify(setupBody)}`);
}
const setupSerialized = JSON.stringify(setupBody);
if (/(privateKey|tokenHash|realityPrivateKeyEncrypted)/i.test(setupSerialized)) {
  throw new Error('Setup progress exposed a sensitive field');
}

const { PrismaClient } = await import('@prisma/client');
const { generateKeyPairSync, randomBytes, randomUUID } = await import('node:crypto');
const prisma = new PrismaClient();
const fixtureServer = await prisma.server.findFirst({ orderBy: { createdAt: 'asc' } });
if (!fixtureServer) throw new Error('Phase 3 runtime smoke requires the seeded local server');
const keyPair = generateKeyPairSync('x25519');
const privateKey = keyPair.privateKey.export({ format: 'jwk' }).d;
const publicKey = keyPair.publicKey.export({ format: 'jwk' }).x;
if (!privateKey || !publicKey) throw new Error('Unable to create runtime Reality key pair');
const runtimeCredentials = {
  uuid: randomUUID(),
  privateKey,
  publicKey,
  shortId: randomBytes(8).toString('hex'),
};
const nodeData = {
  serverId: fixtureServer.id,
  name: 'Runtime Phase 3 Node',
  host: '127.0.0.1',
  port: 30443,
  uuid: runtimeCredentials.uuid,
  flow: 'xtls-rprx-vision',
  realityPublicKey: runtimeCredentials.publicKey,
  realityPrivateKeyEncrypted: 'runtime-encrypted-placeholder',
  shortId: runtimeCredentials.shortId,
  sni: 'localhost',
  dest: '127.0.0.1:443',
  fingerprint: 'chrome',
  enabled: true,
  status: 'HEALTHY',
};
const existingFixtureNode = await prisma.node.findFirst({
  where: { name: 'Runtime Phase 3 Node' },
});
const fixtureNode = existingFixtureNode
  ? await prisma.node.update({ where: { id: existingFixtureNode.id }, data: nodeData })
  : await prisma.node.create({ data: nodeData });
const formalConfig = {
  log: { loglevel: 'warning' },
  inbounds: [
    {
      tag: 'runtime-network-performance-node',
      listen: '0.0.0.0',
      port: fixtureNode.port,
      protocol: 'vless',
      settings: {
        clients: [{ id: runtimeCredentials.uuid, flow: 'xtls-rprx-vision' }],
        decryption: 'none',
      },
      streamSettings: {
        network: 'tcp',
        security: 'reality',
        realitySettings: {
          show: false,
          dest: '127.0.0.1:443',
          xver: 0,
          serverNames: ['localhost'],
          privateKey: runtimeCredentials.privateKey,
          shortIds: [runtimeCredentials.shortId],
        },
      },
    },
  ],
  outbounds: [{ tag: 'direct', protocol: 'freedom' }],
};
const appliedFixture = await fetch('http://proxyhub-agent:3001/xray/apply', {
  method: 'POST',
  headers: {
    authorization: `Bearer ${process.env.AGENT_TOKEN}`,
    'content-type': 'application/json',
  },
  body: JSON.stringify({ config: formalConfig }),
});
if (!appliedFixture.ok) {
  throw new Error(`Unable to apply isolated runtime fixture: ${appliedFixture.status}`);
}
await prisma.$disconnect();

const listData = async (path) => {
  const response = await authenticated(path);
  const body = await response.json();
  if (!response.ok || !body?.success) throw new Error(`${path} failed: ${JSON.stringify(body)}`);
  return body.data;
};
const ensureResource = async (listPath, name, createBody) => {
  const existing = (await listData(listPath)).find((item) => item.name === name);
  if (existing) return existing;
  const response = await jsonRequest(listPath, 'POST', createBody);
  const body = await response.json();
  if (!response.ok || !body?.success) {
    throw new Error(`Creating ${name} failed: ${JSON.stringify(body)}`);
  }
  return body.data?.subscription ?? body.data;
};
const fixturePool = await ensureResource('/api/node-pools', 'Runtime Phase 3 Pool', {
  name: 'Runtime Phase 3 Pool',
  description: 'Isolated runtime smoke fixture',
  region: 'Fixture',
  strategy: 'MANUAL',
  enabled: true,
  nodeIds: [fixtureNode.id],
});
const fixturePolicy = await ensureResource('/api/policies', 'Runtime Phase 3 Policy', {
  name: 'Runtime Phase 3 Policy',
  description: 'Isolated runtime smoke fixture',
  enabled: true,
  defaultAction: 'DIRECT',
  defaultNodePoolId: null,
});
await ensureResource('/api/rule-sets', 'Runtime Phase 3 Rules', {
  name: 'Runtime Phase 3 Rules',
  description: 'Isolated runtime smoke fixture',
  sourceType: 'MANUAL',
  format: 'PLAIN_TEXT',
  enabled: true,
});
const issuePublicSubscription = async (format) => {
  const name = `Runtime Public ${format} Subscription`;
  const existing = (await listData('/api/subscriptions')).find((item) => item.name === name);
  const response = existing
    ? await jsonRequest(`/api/subscriptions/${existing.id}/rotate-token`, 'POST')
    : await jsonRequest('/api/subscriptions', 'POST', {
        name,
        policyId: fixturePolicy.id,
        format,
        enabled: true,
        expiresAt: null,
      });
  const body = await response.json();
  if (!response.ok || !body?.success || !body.data?.subscription || !body.data?.token) {
    throw new Error(`Issuing ${format} public subscription failed`);
  }
  return body.data;
};
const publicSubscriptions = [];
for (const format of ['mihomo', 'sing-box', 'raw']) {
  publicSubscriptions.push({ format, ...(await issuePublicSubscription(format)) });
}
const fixtureSubscription = publicSubscriptions.find(({ format }) => format === 'raw').subscription;

const expectedContentTypes = {
  mihomo: 'text/yaml',
  'sing-box': 'application/json',
  raw: 'text/plain',
};
for (const fixture of publicSubscriptions) {
  const publicResponse = await requestPublicSubscriptionThroughCaddy(
    `/sub/${fixture.token}`,
  );
  if (
    publicResponse.status !== 200 ||
    !publicResponse.contentType.toLowerCase().startsWith(expectedContentTypes[fixture.format]) ||
    publicResponse.contentType.toLowerCase().startsWith('text/html') ||
    /<!doctype\s+html/i.test(publicResponse.body)
  ) {
    throw new Error(
      `Caddy routed ${fixture.format} subscription incorrectly: ` +
        `status=${publicResponse.status} content-type=${publicResponse.contentType}`,
    );
  }
}
console.log('Caddy public subscription routing smoke passed for Mihomo, sing-box and raw.');

const readiness = await jsonRequest(
  `/api/subscriptions/${fixtureSubscription.id}/readiness`,
  'POST',
);
const readinessBody = await readiness.json();
if (
  !readiness.ok ||
  !readinessBody?.success ||
  !['READY', 'READY_WITH_WARNINGS'].includes(readinessBody.data?.status)
) {
  throw new Error(`Subscription readiness failed: ${JSON.stringify(readinessBody)}`);
}
for (const format of ['mihomo', 'sing-box', 'raw']) {
  const preview = await jsonRequest(
    `/api/subscriptions/${fixtureSubscription.id}/preview`,
    'POST',
    { format },
  );
  const previewBody = await preview.json();
  const serializedPreview = JSON.stringify(previewBody);
  if (
    !preview.ok ||
    !previewBody?.success ||
    previewBody.data?.sanitized !== true ||
    serializedPreview.includes(fixtureNode.uuid) ||
    serializedPreview.includes(fixtureNode.shortId) ||
    serializedPreview.includes('runtime-encrypted-placeholder')
  ) {
    throw new Error(`Sanitized ${format} preview failed`);
  }
}
const responseTest = await jsonRequest(
  `/api/subscriptions/${fixtureSubscription.id}/test-response`,
  'POST',
);
const responseTestBody = await responseTest.json();
if (
  !responseTest.ok ||
  !responseTestBody?.success ||
  responseTestBody.data?.statusCode !== 200 ||
  responseTestBody.data?.token !== '[REDACTED]'
) {
  throw new Error(`Subscription response test failed: ${JSON.stringify(responseTestBody)}`);
}
const agentInternal = async (path, init = {}) => {
  const response = await fetch(`http://proxyhub-agent:3001${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${process.env.AGENT_TOKEN}`,
      ...(init.headers ?? {}),
    },
  });
  const body = await response.json();
  if (!response.ok || !body?.success) {
    throw new Error(`Agent ${path} failed: status=${response.status} code=${body?.error?.code}`);
  }
  return body.data;
};
const runtimeIdentityBefore = await agentInternal('/network-performance/runtime-identity');
const performanceCapability = await performanceAuthenticated(
  '/api/nodes/performance-tests/capability',
);
const performanceCapabilityBody = await performanceCapability.json();
if (
  !performanceCapability.ok ||
  !performanceCapabilityBody?.success ||
  performanceCapabilityBody.data?.available !== true ||
  performanceCapabilityBody.data?.targetCount !== 1
) {
  throw new Error(`Performance capability failed: ${JSON.stringify(performanceCapabilityBody)}`);
}
const waitForPerformanceRun = async (runId, expectedStatuses, timeoutMs = 30_000) => {
  const deadline = Date.now() + timeoutMs;
  let body;
  while (Date.now() < deadline) {
    const response = await performanceAuthenticated(
      `/api/nodes/${fixtureNode.id}/performance-tests/${runId}`,
    );
    body = await response.json();
    if (!response.ok || !body?.success) {
      throw new Error(`Performance run query failed: ${JSON.stringify(body)}`);
    }
    if (expectedStatuses.includes(body.data?.status)) return body.data;
    if (['COMPLETED', 'PARTIAL', 'FAILED', 'CANCELLED', 'INTERRUPTED'].includes(body.data?.status)) {
      throw new Error(
        `Performance run reached unexpected terminal status: ${JSON.stringify(body.data)}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`Performance run did not reach ${expectedStatuses.join('/')}: ${JSON.stringify(body)}`);
};
const startPerformanceRun = async () => {
  const response = await performanceJsonRequest(
    `/api/nodes/${fixtureNode.id}/performance-tests`,
    'POST',
  );
  const body = await response.json();
  if (response.status !== 202 || !body?.success || !body.data?.id) {
    throw new Error(`Starting performance run failed: ${JSON.stringify(body)}`);
  }
  return body.data;
};
const waitForPerformanceIdle = async () => {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const response = await performanceAuthenticated(
      '/api/nodes/performance-tests/capability',
    );
    const body = await response.json();
    if (response.ok && body?.success && body.data?.busy === false) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('Performance runner did not become idle');
};

const performanceRun = await startPerformanceRun();
const concurrentPerformance = await performanceJsonRequest(
  `/api/nodes/${fixtureNode.id}/performance-tests`,
  'POST',
);
const concurrentPerformanceBody = await concurrentPerformance.json();
if (
  concurrentPerformance.status !== 409 ||
  concurrentPerformanceBody?.error?.code !== 'NETWORK_PERFORMANCE_TEST_BUSY'
) {
  throw new Error('Concurrent performance run was not rejected with the stable busy code');
}
const performanceResult = await waitForPerformanceRun(
  performanceRun.id,
  ['COMPLETED', 'PARTIAL'],
);
if (
  performanceResult.status !== 'COMPLETED' ||
  performanceResult.targetResults?.length !== 1 ||
  !(performanceResult.targetResults[0]?.directMbps > 0) ||
  !(performanceResult.targetResults[0]?.tunnelMbps > 0)
) {
  throw new Error(`Performance result was incomplete: ${JSON.stringify(performanceResult)}`);
}
const serializedPerformance = JSON.stringify(performanceResult);
for (const secret of [
  fixtureNode.uuid,
  fixtureNode.realityPublicKey,
  fixtureNode.shortId,
  'runtime-encrypted-placeholder',
  process.env.AGENT_TOKEN,
  process.env.ENCRYPTION_KEY,
]) {
  if (secret && serializedPerformance.includes(secret)) {
    throw new Error('Performance API exposed a fixture secret');
  }
}
const performanceHistory = await performanceAuthenticated(
  `/api/nodes/${fixtureNode.id}/performance-tests`,
);
const performanceHistoryBody = await performanceHistory.json();
if (
  !performanceHistory.ok ||
  !performanceHistoryBody?.success ||
  performanceHistoryBody.data?.[0]?.id !== performanceRun.id
) {
  throw new Error(`Performance history failed: ${JSON.stringify(performanceHistoryBody)}`);
}

await waitForPerformanceIdle();
await fetch('http://network-perf-fixture:8080/mode/slow', { method: 'POST' });
const cancellablePerformance = await startPerformanceRun();
const cancelledResponse = await performanceJsonRequest(
  `/api/nodes/${fixtureNode.id}/performance-tests/${cancellablePerformance.id}/cancel`,
  'POST',
);
if (!cancelledResponse.ok) {
  throw new Error(`Performance cancellation failed: ${await cancelledResponse.text()}`);
}
await waitForPerformanceRun(cancellablePerformance.id, ['CANCELLED']);

await waitForPerformanceIdle();
const timeoutPerformance = await startPerformanceRun();
const timeoutResult = await waitForPerformanceRun(timeoutPerformance.id, ['FAILED'], 30_000);
if (timeoutResult.summary?.errorCode !== undefined) {
  if (timeoutResult.summary.errorCode !== 'NETWORK_PERFORMANCE_TIMEOUT') {
    throw new Error(`Unexpected performance timeout code: ${JSON.stringify(timeoutResult)}`);
  }
} else if (
  timeoutResult.targetResults?.[0]?.errorCode !== 'NETWORK_PERFORMANCE_TIMEOUT'
) {
  throw new Error(`Target timeout was not preserved: ${JSON.stringify(timeoutResult)}`);
}
await fetch('http://network-perf-fixture:8080/mode/fast', { method: 'POST' });

const runtimeIdentityAfter = await agentInternal('/network-performance/runtime-identity');
if (
  runtimeIdentityAfter.pid !== runtimeIdentityBefore.pid ||
  runtimeIdentityAfter.configSha256 !== runtimeIdentityBefore.configSha256
) {
  throw new Error('Performance tests changed the active Xray PID or configuration');
}
const finalPerformanceCapability = await agentInternal('/network-performance/capability');
if (finalPerformanceCapability.busy || finalPerformanceCapability.targetCount !== 1) {
  throw new Error('Performance runner did not release its single-run lock');
}
console.log('Network performance runtime smoke passed with isolation, cancellation and timeout.');

const dependencies = await authenticated(
  `/api/resources/policy/${fixturePolicy.id}/dependencies`,
);
const dependenciesBody = await dependencies.json();
if (
  !dependencies.ok ||
  !dependenciesBody?.data?.usedBy?.some(
    (item) =>
      item.resourceType === 'SUBSCRIPTION' && item.resourceId === fixtureSubscription.id,
  )
) {
  throw new Error('Policy dependency analysis did not include the fixture subscription');
}
const deleteImpact = await authenticated(
  `/api/resources/policy/${fixturePolicy.id}/delete-impact`,
);
const deleteImpactBody = await deleteImpact.json();
if (!deleteImpact.ok || deleteImpactBody.data?.status !== 'BLOCKED') {
  throw new Error('Policy delete impact was not blocked');
}
if (!fixturePool?.id) throw new Error('Node pool fixture is invalid');
console.log('Phase 3 guided workflow runtime smoke passed.');

const overview = await authenticated('/api/diagnostics/overview');
const overviewBody = await overview.json();
if (!overview.ok || !overviewBody?.success || overviewBody.data?.kind !== 'overview') {
  throw new Error(`Diagnostics overview failed: ${JSON.stringify(overviewBody)}`);
}
for (const id of [
  'runtime.server.health',
  'database.sqlite.health',
  'storage.database.filesystem',
  'network-performance.summary',
]) {
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

if docker compose exec -T proxyhub-agent sh -c \
  "find /tmp -maxdepth 1 -type d -name 'proxyhub-network-performance-*' | grep -q ."; then
  echo "Network performance temporary directories were not cleaned" >&2
  exit 1
fi

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
    echo "$service changed state during runtime smoke: state=$state restarts=$restart_count" >&2
    exit 1
  fi
done

echo "Production Compose runtime smoke test passed."
