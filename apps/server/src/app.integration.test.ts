import { authenticator } from 'otplib';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { RealityTargetCompatibilityResult, XrayHealthStatus } from '@proxyhub/shared';
import type { NetworkPerformanceResult } from '@proxyhub/network-performance-core';
import type { AgentClient } from './agent-client.js';
import { prisma } from './db.js';
import { buildApp } from './app.js';

const healthyXray: XrayHealthStatus = {
  status: 'HEALTHY',
  running: true,
  version: 'test-xray',
  checkedAt: new Date().toISOString(),
  checks: {
    process: { healthy: true, pid: 42 },
    container: { healthy: true, heartbeatAt: new Date().toISOString() },
    ports: { healthy: true, known: true, configured: [], listening: [] },
    config: { healthy: true, message: null },
  },
};

let rejectNextApply = false;
let applyCalls = 0;
let compatibilityCalls = 0;
let nextCompatibilityStatus: RealityTargetCompatibilityResult['status'] = 'COMPATIBLE';
const appliedInboundCounts: number[] = [];
let holdPerformanceRun = false;
const performanceAgentRuns = new Map<string, { status: string; cancelled?: boolean }>();
const performanceResult: NetworkPerformanceResult = {
  status: 'COMPLETED',
  score: {
    overall: 91,
    throughput: 90,
    successRate: 100,
    stability: 95,
    connectionRating: 'EXCELLENT',
    throughputRating: 'EXCELLENT',
    stabilityRating: 'EXCELLENT',
    overallRating: 'EXCELLENT',
  },
  tunnelEstablishmentMs: 32,
  medianDirectMbps: 80,
  medianTunnelMbps: 72,
  successRatePercent: 100,
  analysisCodes: ['TUNNEL_EFFICIENCY_HEALTHY'],
  durationMs: 1250,
  targets: [
    {
      targetId: 'fixture',
      targetLabel: 'Fixture Target',
      success: true,
      direct: {
        downloadMbps: 80,
        downloadSamplesMbps: [79, 81],
        latencyMedianMs: 10,
        latencyP95Ms: 12,
        jitterMs: 1,
        successfulRequests: 5,
        failedRequests: 0,
      },
      tunnel: {
        downloadMbps: 72,
        downloadSamplesMbps: [71, 73],
        latencyMedianMs: 15,
        latencyP95Ms: 18,
        jitterMs: 2,
        successfulRequests: 5,
        failedRequests: 0,
      },
      efficiencyPercent: 90,
      uploadStatus: 'NOT_AVAILABLE',
      analysisCodes: [],
    },
  ],
  environment: {
    source: 'PROXYHUB_SERVER',
    serverName: 'Integration VPS',
    serverRegion: 'Local',
    nodeName: 'Tokyo Edge',
    nodePort: 443,
    protocol: 'VLESS',
    transport: 'TCP',
    security: 'REALITY',
    flow: 'xtls-rprx-vision',
    realityTarget: 'www.microsoft.com:443',
    sni: 'www.microsoft.com',
    xrayVersion: 'Xray 26.5.9',
    proxyhubVersion: '0.4.0-dev',
    gitSha: 'unknown',
    deployMode: 'source',
    testedAt: new Date().toISOString(),
  },
};
const compatibilityResult = (
  status: RealityTargetCompatibilityResult['status'],
): RealityTargetCompatibilityResult => ({
  status,
  target: status === 'COMPATIBLE' ? 'dl.google.com:443' : 'incompatible.example:443',
  serverName: status === 'COMPATIBLE' ? 'dl.google.com' : 'incompatible.example',
  xrayVersion: 'Xray 26.5.9',
  durationMs: 125,
  tlsPrecheck: { status: 'PASSED' },
  realityHandshake: { status: status === 'COMPATIBLE' ? 'PASSED' : 'FAILED' },
  endToEndTraffic: { status: status === 'COMPATIBLE' ? 'PASSED' : 'NOT_RUN' },
  diagnostics:
    status === 'COMPATIBLE'
      ? []
      : ['TLS precheck passed, but the end-to-end Reality handshake failed.'],
});
const agentClient: AgentClient = {
  status: async () => ({
    agent: { version: '0.1.1', hostname: 'agent-test', uptime: 100 },
    system: { cpuCount: 2, load: 0.1, memoryUsage: 20 },
    xray: healthyXray,
  }),
  testRealityTarget: async () => {
    compatibilityCalls += 1;
    const status = nextCompatibilityStatus;
    nextCompatibilityStatus = 'COMPATIBLE';
    return compatibilityResult(status);
  },
  networkPerformanceCapability: async () => ({
    available: true,
    targetCount: 1,
    busy: holdPerformanceRun,
    maxConcurrentRuns: 1,
  }),
  startNetworkPerformance: async () => {
    const id = randomUUID();
    performanceAgentRuns.set(id, { status: 'RUNNING' });
    return {
      id,
      status: 'RUNNING',
      progress: {
        stage: 'PREPARING',
        currentTarget: 0,
        totalTargets: 1,
        remainingSteps: 4,
      },
    };
  },
  getNetworkPerformance: async (id) => {
    const run = performanceAgentRuns.get(id);
    if (!run) throw new Error('missing synthetic performance run');
    if (run.cancelled) {
      return {
        id,
        status: 'CANCELLED',
        errorCode: 'NETWORK_PERFORMANCE_CANCELLED',
        progress: {
          stage: 'TESTING_TARGET',
          currentTarget: 1,
          totalTargets: 1,
          remainingSteps: 2,
        },
      };
    }
    if (holdPerformanceRun) {
      return {
        id,
        status: 'RUNNING',
        progress: {
          stage: 'TESTING_TARGET',
          currentTarget: 1,
          totalTargets: 1,
          remainingSteps: 2,
        },
      };
    }
    return {
      id,
      status: 'COMPLETED',
      result: performanceResult,
      progress: {
        stage: 'COMPLETED',
        currentTarget: 1,
        totalTargets: 1,
        remainingSteps: 0,
      },
    };
  },
  cancelNetworkPerformance: async (id) => {
    const run = performanceAgentRuns.get(id);
    if (run) run.cancelled = true;
    return { cancelled: true };
  },
  applyConfig: async (config) => {
    applyCalls += 1;
    appliedInboundCounts.push(Array.isArray(config.inbounds) ? config.inbounds.length : -1);
    if (rejectNextApply) {
      rejectNextApply = false;
      throw new Error('Synthetic validation failure');
    }
    return {
      applied: true,
      restarted: true,
      revision: '00000000-0000-4000-8000-000000000001',
      health: healthyXray,
    };
  },
  restart: async () => ({ restarted: true, health: healthyXray }),
  rollback: async () => ({ rolledBack: true, health: healthyXray }),
  confirm: async () => ({ confirmed: true }),
};

describe('ProxyHub foundation API', () => {
  let app: FastifyInstance;
  let cookie = '';
  let serverId = '';
  let policyId = '';
  let policyPoolId = '';
  let subscriptionId = '';
  let subscriptionToken = '';
  let nodeId = '';

  beforeAll(async () => {
    app = await buildApp({ agentClient });
    const server = await prisma.server.create({
      data: {
        name: 'Integration VPS',
        hostname: 'proxyhub-test',
        ip: '203.0.113.10',
        status: 'ONLINE',
      },
    });
    serverId = server.id;
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  it('bootstraps an administrator and creates a secure session', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/bootstrap',
      payload: { username: 'admin', password: 'correct-horse-battery-staple' },
    });
    expect(response.statusCode, response.body).toBe(201);
    cookie = response.cookies[0]?.value ? `proxyhub_session=${response.cookies[0].value}` : '';
    expect(cookie).toContain('proxyhub_session=');

    const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } });
    expect(me.statusCode).toBe(200);
    expect(me.json().data.role).toBe('ADMIN');
  });

  it('enables TOTP and returns ten one-time recovery codes', async () => {
    const setup = await app.inject({
      method: 'POST',
      url: '/api/auth/2fa/setup',
      headers: { cookie },
    });
    expect(setup.statusCode).toBe(200);
    const secret = setup.json().data.secret as string;
    const enable = await app.inject({
      method: 'POST',
      url: '/api/auth/2fa/enable',
      headers: { cookie },
      payload: { code: authenticator.generate(secret) },
    });
    expect(enable.statusCode).toBe(200);
    expect(enable.json().data.recoveryCodes).toHaveLength(10);
    const stored = await prisma.recoveryCode.findMany();
    expect(stored).toHaveLength(10);
    expect(stored[0]?.codeHash).toContain('$argon2id$');
  }, 30_000);

  it('creates a VLESS Reality node without returning its private key', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/nodes',
      headers: { cookie },
      payload: {
        name: 'Tokyo Edge',
        serverId,
        host: 'edge.example.com',
        port: 443,
        sni: 'www.microsoft.com',
        dest: 'www.microsoft.com:443',
        fingerprint: 'chrome',
      },
    });
    expect(response.statusCode, response.body).toBe(201);
    nodeId = response.json().data.id as string;
    const node = response.json().data;
    expect(node.protocol).toBe('VLESS');
    expect(node.realityPublicKey).toBeTruthy();
    expect(JSON.stringify(node)).not.toContain('realityPrivateKeyEncrypted');

    const share = await app.inject({
      method: 'GET',
      url: `/api/nodes/${node.id}/share`,
      headers: { cookie },
    });
    expect(share.json().data.uri).toContain('security=reality');
    expect(share.json().data.qrCode).toContain('data:image/png;base64');

    const updated = await app.inject({
      method: 'PATCH',
      url: `/api/nodes/${node.id}`,
      headers: { cookie },
      payload: { name: 'Tokyo Edge Updated', sni: 'www.cloudflare.com' },
    });
    expect(updated.statusCode, updated.body).toBe(200);
    expect(updated.json().data.name).toBe('Tokyo Edge Updated');
    expect(updated.json().data.sni).toBe('www.cloudflare.com');

    const disabled = await app.inject({
      method: 'PATCH',
      url: `/api/nodes/${node.id}`,
      headers: { cookie },
      payload: { enabled: false },
    });
    expect(disabled.statusCode, disabled.body).toBe(200);
    expect(disabled.json().data.enabled).toBe(false);
    expect(appliedInboundCounts.at(-1)).toBe(0);

    const enabled = await app.inject({
      method: 'PATCH',
      url: `/api/nodes/${node.id}`,
      headers: { cookie },
      payload: { enabled: true },
    });
    expect(enabled.statusCode, enabled.body).toBe(200);
    expect(enabled.json().data.enabled).toBe(true);
    expect(appliedInboundCounts.at(-1)).toBe(1);

    const cloned = await app.inject({
      method: 'POST',
      url: `/api/nodes/${node.id}/clone`,
      headers: { cookie },
    });
    expect(cloned.statusCode, cloned.body).toBe(201);
    expect(cloned.json().data.uuid).not.toBe(node.uuid);
    expect(cloned.json().data.port).toBe(444);
    expect(JSON.stringify(cloned.json().data)).not.toContain('realityPrivateKeyEncrypted');

    const deleted = await app.inject({
      method: 'DELETE',
      url: `/api/nodes/${cloned.json().data.id as string}`,
      headers: { cookie },
    });
    expect(deleted.statusCode, deleted.body).toBe(200);
    expect(applyCalls).toBeGreaterThanOrEqual(6);
  });

  it('runs, persists, retains and cancels sanitized network performance tests', async () => {
    const capability = await app.inject({
      method: 'GET',
      url: '/api/nodes/performance-tests/capability',
      headers: { cookie },
    });
    expect(capability.statusCode, capability.body).toBe(200);
    expect(capability.json().data).toMatchObject({
      available: true,
      targetCount: 1,
      maxConcurrentRuns: 1,
    });

    await prisma.networkPerformanceRun.createMany({
      data: Array.from({ length: 10 }, (_, index) => ({
        id: `performance-history-${String(index)}`,
        nodeId,
        status: 'INTERRUPTED',
        proxyhubVersion: '0.3.1-dev',
        buildSha: 'history',
        startedAt: new Date(Date.now() - (index + 1) * 60_000),
      })),
    });
    const started = await app.inject({
      method: 'POST',
      url: `/api/nodes/${nodeId}/performance-tests`,
      headers: { cookie },
    });
    expect(started.statusCode, started.body).toBe(202);
    const runId = started.json().data.id as string;

    let completed:
      | {
          status: string;
          score: number | null;
          targetResults: unknown[];
        }
      | undefined;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      const response = await app.inject({
        method: 'GET',
        url: `/api/nodes/${nodeId}/performance-tests/${runId}`,
        headers: { cookie },
      });
      completed = response.json().data;
      if (completed?.status !== 'RUNNING') break;
    }
    expect(completed).toMatchObject({ status: 'COMPLETED', score: 91 });
    expect(completed?.targetResults).toHaveLength(1);

    const history = await app.inject({
      method: 'GET',
      url: `/api/nodes/${nodeId}/performance-tests`,
      headers: { cookie },
    });
    expect(history.statusCode, history.body).toBe(200);
    expect(history.json().data).toHaveLength(10);
    expect(history.json().data[0].id).toBe(runId);

    holdPerformanceRun = true;
    const cancellable = await app.inject({
      method: 'POST',
      url: `/api/nodes/${nodeId}/performance-tests`,
      headers: { cookie },
    });
    expect(cancellable.statusCode, cancellable.body).toBe(202);
    const cancellableId = cancellable.json().data.id as string;
    const busy = await app.inject({
      method: 'POST',
      url: `/api/nodes/${nodeId}/performance-tests`,
      headers: { cookie },
    });
    expect(busy.statusCode, busy.body).toBe(409);
    expect(busy.json().error.code).toBe('NETWORK_PERFORMANCE_TEST_BUSY');
    const cancel = await app.inject({
      method: 'POST',
      url: `/api/nodes/${nodeId}/performance-tests/${cancellableId}/cancel`,
      headers: { cookie },
    });
    expect(cancel.statusCode, cancel.body).toBe(200);
    holdPerformanceRun = false;
    await new Promise((resolve) => setTimeout(resolve, 500));
    const cancelled = await app.inject({
      method: 'GET',
      url: `/api/nodes/${nodeId}/performance-tests/${cancellableId}`,
      headers: { cookie },
    });
    expect(cancelled.json().data.status).toBe('CANCELLED');

    const node = await prisma.node.findUniqueOrThrow({ where: { id: nodeId } });
    const stored = JSON.stringify({
      runs: await prisma.networkPerformanceRun.findMany({
        where: { nodeId },
        include: { targetResults: true },
      }),
      audit: await prisma.auditLog.findMany({
        where: { action: { contains: 'NETWORK_PERFORMANCE' } },
      }),
      notifications: await prisma.notification.findMany({
        where: { eventType: { contains: 'NETWORK_PERFORMANCE' } },
      }),
    });
    for (const secret of [
      node.uuid,
      node.realityPublicKey,
      node.shortId,
      node.realityPrivateKeyEncrypted,
    ]) {
      expect(stored).not.toContain(secret);
    }
  });

  it('creates a node pool, dashboard activity and web notifications', async () => {
    const node = await prisma.node.findFirstOrThrow();
    const pool = await app.inject({
      method: 'POST',
      url: '/api/node-pools',
      headers: { cookie },
      payload: {
        name: 'Japan Pool',
        description: 'Primary Japan capacity',
        region: 'Japan',
        strategy: 'FALLBACK',
        enabled: true,
        nodeIds: [node.id],
      },
    });
    expect(pool.statusCode).toBe(201);
    expect(pool.json().data.members).toHaveLength(1);

    const dashboard = await app.inject({
      method: 'GET',
      url: '/api/dashboard',
      headers: { cookie },
    });
    expect(dashboard.statusCode).toBe(200);
    expect(dashboard.json().data.metrics.nodesTotal).toBe(1);
    expect(dashboard.json().data.metrics.poolsTotal).toBe(1);
    expect(dashboard.json().data.system.xrayStatus).toBe('HEALTHY');
    expect(dashboard.json().data.trafficMode).toBe('DEMO');

    const [audits, notifications] = await Promise.all([
      app.inject({ method: 'GET', url: '/api/audit-logs', headers: { cookie } }),
      app.inject({ method: 'GET', url: '/api/notifications', headers: { cookie } }),
    ]);
    expect(audits.json().data.length).toBeGreaterThan(2);
    expect(notifications.json().data.length).toBeGreaterThan(0);

    const updated = await app.inject({
      method: 'PUT',
      url: `/api/node-pools/${pool.json().data.id as string}`,
      headers: { cookie },
      payload: {
        name: 'Japan Pool Updated',
        description: 'Temporarily disabled',
        region: 'Japan',
        strategy: 'MANUAL',
        enabled: false,
        nodeIds: [],
      },
    });
    expect(updated.statusCode, updated.body).toBe(200);
    expect(updated.json().data.enabled).toBe(false);
    expect(updated.json().data.members).toHaveLength(0);

    const deleted = await app.inject({
      method: 'DELETE',
      url: `/api/node-pools/${pool.json().data.id as string}`,
      headers: { cookie },
    });
    expect(deleted.statusCode, deleted.body).toBe(200);
  });

  it('manages policies, ordered rules, adapters and node-pool references', async () => {
    const node = await prisma.node.findFirstOrThrow();
    const pool = await app.inject({
      method: 'POST',
      url: '/api/node-pools',
      headers: { cookie },
      payload: {
        name: 'Policy Pool',
        description: 'Compiler integration pool',
        region: 'Global',
        strategy: 'MANUAL',
        enabled: true,
        nodeIds: [node.id],
      },
    });
    expect(pool.statusCode, pool.body).toBe(201);
    policyPoolId = pool.json().data.id as string;

    const created = await app.inject({
      method: 'POST',
      url: '/api/policies',
      headers: { cookie },
      payload: {
        name: 'Integration Policy',
        description: 'One policy, multiple adapters',
        enabled: true,
        defaultAction: 'DIRECT',
        defaultNodePoolId: null,
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    policyId = created.json().data.id as string;

    const firstRule = await app.inject({
      method: 'POST',
      url: `/api/policies/${policyId}/rules`,
      headers: { cookie },
      payload: {
        name: 'Route example',
        matchType: 'DOMAIN_SUFFIX',
        matchValue: 'example.com',
        actionType: 'NODE_POOL',
        nodePoolId: policyPoolId,
        enabled: true,
      },
    });
    const secondRule = await app.inject({
      method: 'POST',
      url: `/api/policies/${policyId}/rules`,
      headers: { cookie },
      payload: {
        name: 'Reject private range',
        matchType: 'IP_CIDR',
        matchValue: '10.0.0.0/8',
        actionType: 'REJECT',
        nodePoolId: null,
        enabled: true,
      },
    });
    expect(firstRule.statusCode, firstRule.body).toBe(201);
    expect(secondRule.statusCode, secondRule.body).toBe(201);
    const firstRuleId = firstRule.json().data.id as string;
    const secondRuleId = secondRule.json().data.id as string;

    const reordered = await app.inject({
      method: 'PUT',
      url: `/api/policies/${policyId}/rules/reorder`,
      headers: { cookie },
      payload: { ruleIds: [secondRuleId, firstRuleId] },
    });
    expect(reordered.statusCode, reordered.body).toBe(200);
    const reorderedRules = reordered.json<{ data: Array<{ id: string }> }>().data;
    expect(reorderedRules.map((rule) => rule.id)).toEqual([secondRuleId, firstRuleId]);

    const updatedRule = await app.inject({
      method: 'PATCH',
      url: `/api/policies/${policyId}/rules/${firstRuleId}`,
      headers: { cookie },
      payload: { description: 'Updated through the rule API', enabled: false },
    });
    expect(updatedRule.statusCode, updatedRule.body).toBe(200);
    expect(updatedRule.json().data.enabled).toBe(false);
    await app.inject({
      method: 'PATCH',
      url: `/api/policies/${policyId}/rules/${firstRuleId}`,
      headers: { cookie },
      payload: { enabled: true },
    });

    for (const format of ['mihomo', 'sing-box', 'raw']) {
      const preview = await app.inject({
        method: 'POST',
        url: `/api/policies/${policyId}/compile-preview`,
        headers: { cookie },
        payload: { format },
      });
      expect(preview.statusCode, preview.body).toBe(200);
      expect(preview.json().data.success).toBe(true);
      expect(preview.json().data.output.length).toBeGreaterThan(0);
      expect(preview.json().data.maskedOutput).not.toContain(node.uuid);
    }

    const blockedDelete = await app.inject({
      method: 'DELETE',
      url: `/api/node-pools/${policyPoolId}`,
      headers: { cookie },
    });
    expect(blockedDelete.statusCode).toBe(409);
    expect(blockedDelete.json().error.code).toBe('NODE_POOL_IN_USE');

    const unavailablePool = await app.inject({
      method: 'PUT',
      url: `/api/node-pools/${policyPoolId}`,
      headers: { cookie },
      payload: {
        name: 'Policy Pool',
        description: 'Compiler integration pool',
        region: 'Global',
        strategy: 'MANUAL',
        enabled: true,
        nodeIds: [],
      },
    });
    expect(unavailablePool.statusCode, unavailablePool.body).toBe(200);
    await expect(
      prisma.notification.findFirstOrThrow({
        where: { eventType: 'NODE_POOL_REFERENCED_UNAVAILABLE' },
      }),
    ).resolves.toBeTruthy();
    const restoredPool = await app.inject({
      method: 'PUT',
      url: `/api/node-pools/${policyPoolId}`,
      headers: { cookie },
      payload: {
        name: 'Policy Pool',
        description: 'Compiler integration pool',
        region: 'Global',
        strategy: 'MANUAL',
        enabled: true,
        nodeIds: [node.id],
      },
    });
    expect(restoredPool.statusCode, restoredPool.body).toBe(200);

    await app.inject({
      method: 'PATCH',
      url: `/api/policies/${policyId}`,
      headers: { cookie },
      payload: { enabled: false },
    });
    const disabledPreview = await app.inject({
      method: 'POST',
      url: `/api/policies/${policyId}/compile-preview`,
      headers: { cookie },
      payload: { format: 'mihomo' },
    });
    expect(disabledPreview.json().data.success).toBe(false);
    await expect(
      prisma.notification.findFirstOrThrow({ where: { eventType: 'POLICY_COMPILE_FAILED' } }),
    ).resolves.toBeTruthy();
    await app.inject({
      method: 'PATCH',
      url: `/api/policies/${policyId}`,
      headers: { cookie },
      payload: { enabled: true },
    });

    const deletedRule = await app.inject({
      method: 'DELETE',
      url: `/api/policies/${policyId}/rules/${secondRuleId}`,
      headers: { cookie },
    });
    expect(deletedRule.statusCode).toBe(200);
  });

  it('manages reusable rule sets and resolves them inside policies', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/rule-sets',
      headers: { cookie },
      payload: {
        name: 'OpenAI Integration Rules',
        description: 'Reusable client routing rules',
        sourceType: 'MANUAL',
        format: 'PLAIN_TEXT',
        enabled: true,
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    const ruleSetId = created.json().data.id as string;

    const imported = await app.inject({
      method: 'POST',
      url: `/api/rule-sets/${ruleSetId}/import`,
      headers: { cookie },
      payload: {
        format: 'PLAIN_TEXT',
        mode: 'REPLACE',
        content:
          '# OpenAI\nDOMAIN_SUFFIX,openai.com\nDOMAIN_SUFFIX,chatgpt.com\nDOMAIN_SUFFIX,openai.com\n',
      },
    });
    expect(imported.statusCode, imported.body).toBe(200);
    expect(imported.json().data.ruleCount).toBe(2);
    expect(imported.json().data.preview.duplicateCount).toBe(1);

    const invalidEntry = await app.inject({
      method: 'POST',
      url: `/api/rule-sets/${ruleSetId}/entries`,
      headers: { cookie },
      payload: { type: 'DOMAIN', value: 'not a domain', enabled: true },
    });
    expect(invalidEntry.statusCode).toBe(422);
    expect(await prisma.ruleSetEntry.count({ where: { ruleSetId } })).toBe(2);

    const detail = await app.inject({
      method: 'GET',
      url: `/api/rule-sets/${ruleSetId}`,
      headers: { cookie },
    });
    expect(detail.json().data.cache).toBeUndefined();

    const preview = await app.inject({
      method: 'GET',
      url: `/api/rule-sets/${ruleSetId}/preview?limit=1`,
      headers: { cookie },
    });
    expect(preview.statusCode, preview.body).toBe(200);
    expect(preview.json().data.totalRules).toBe(2);
    expect(preview.json().data.rules).toHaveLength(1);

    const policyRule = await app.inject({
      method: 'POST',
      url: `/api/policies/${policyId}/rules`,
      headers: { cookie },
      payload: {
        name: 'OpenAI via Rule Set',
        description: '',
        enabled: true,
        matchSourceType: 'RULE_SET',
        ruleSetId,
        actionType: 'DIRECT',
        nodePoolId: null,
      },
    });
    expect(policyRule.statusCode, policyRule.body).toBe(201);
    const policyRuleId = policyRule.json().data.id as string;

    const compiled = await app.inject({
      method: 'POST',
      url: `/api/policies/${policyId}/compile-preview`,
      headers: { cookie },
      payload: { format: 'mihomo' },
    });
    expect(compiled.statusCode, compiled.body).toBe(200);
    expect(compiled.json().data.output).toContain('DOMAIN-SUFFIX,openai.com,DIRECT');
    expect(compiled.json().data.metadata.ruleSetCount).toBe(1);

    const blockedDelete = await app.inject({
      method: 'DELETE',
      url: `/api/rule-sets/${ruleSetId}`,
      headers: { cookie },
    });
    expect(blockedDelete.statusCode).toBe(409);
    expect(blockedDelete.json().error.code).toBe('RULE_SET_IN_USE');
    expect(blockedDelete.json().error.details.policies[0].id).toBe(policyId);

    const disabled = await app.inject({
      method: 'POST',
      url: `/api/rule-sets/${ruleSetId}/disable`,
      headers: { cookie },
    });
    expect(disabled.statusCode, disabled.body).toBe(200);
    const disabledCompile = await app.inject({
      method: 'POST',
      url: `/api/policies/${policyId}/compile-preview`,
      headers: { cookie },
      payload: { format: 'mihomo' },
    });
    expect(disabledCompile.json().data.errors).toContainEqual(
      expect.objectContaining({ code: 'RULE_SET_DISABLED', ruleSetId }),
    );
    await expect(
      prisma.notification.findFirstOrThrow({
        where: { eventType: 'RULE_SET_REFERENCED_DISABLED' },
      }),
    ).resolves.toBeTruthy();

    await app.inject({
      method: 'POST',
      url: `/api/rule-sets/${ruleSetId}/enable`,
      headers: { cookie },
    });
    const exported = await app.inject({
      method: 'GET',
      url: `/api/rule-sets/${ruleSetId}/export`,
      headers: { cookie },
    });
    expect(exported.json().data).toMatchObject({
      version: 1,
      format: 'PROXYHUB_NATIVE',
      contentHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });

    const remote = await app.inject({
      method: 'POST',
      url: '/api/rule-sets',
      headers: { cookie },
      payload: {
        name: 'Remote Integration Rules',
        sourceType: 'REMOTE',
        format: 'MIHOMO',
        sourceUrl: 'https://rules.example.com/list?token=must-not-audit',
        updateIntervalMinutes: 60,
        enabled: true,
      },
    });
    expect(remote.statusCode, remote.body).toBe(201);
    expect(remote.json().data.sourceUrl).toBe('https://rules.example.com/list');
    const remoteId = remote.json().data.id as string;
    const renamedRemote = await app.inject({
      method: 'PATCH',
      url: `/api/rule-sets/${remoteId}`,
      headers: { cookie },
      payload: { name: 'Remote Integration Rules Renamed' },
    });
    expect(renamedRemote.statusCode, renamedRemote.body).toBe(200);
    await expect(
      prisma.ruleSet.findUniqueOrThrow({ where: { id: remoteId } }),
    ).resolves.toMatchObject({
      sourceUrl: 'https://rules.example.com/list?token=must-not-audit',
    });
    await app.inject({ method: 'DELETE', url: `/api/rule-sets/${remoteId}`, headers: { cookie } });

    await app.inject({
      method: 'DELETE',
      url: `/api/policies/${policyId}/rules/${policyRuleId}`,
      headers: { cookie },
    });
    expect(
      (
        await app.inject({
          method: 'DELETE',
          url: `/api/rule-sets/${ruleSetId}`,
          headers: { cookie },
        })
      ).statusCode,
    ).toBe(200);

    const auditMetadata = (await prisma.auditLog.findMany({ where: { resource: 'RuleSet' } }))
      .map((entry) => entry.metadata)
      .join('\n');
    expect(auditMetadata).not.toContain('must-not-audit');
  });

  it('secures subscription tokens, rotation, expiration and public compilation', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/subscriptions',
      headers: { cookie },
      payload: {
        name: 'Integration Subscription',
        policyId,
        format: 'raw',
        enabled: true,
        expiresAt: null,
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    subscriptionId = created.json().data.subscription.id as string;
    subscriptionToken = created.json().data.token as string;
    const originalToken = subscriptionToken;
    expect(Buffer.from(subscriptionToken, 'base64url')).toHaveLength(32);
    expect(JSON.stringify(created.json().data.subscription)).not.toContain('tokenHash');
    const stored = await prisma.subscription.findUniqueOrThrow({ where: { id: subscriptionId } });
    expect(stored.tokenHash).toMatch(/^[a-f0-9]{64}$/);
    expect(stored.tokenHash).not.toContain(subscriptionToken);
    expect(stored.tokenPrefix).toBe(subscriptionToken.slice(0, 8));

    const listed = await app.inject({
      method: 'GET',
      url: '/api/subscriptions',
      headers: { cookie },
    });
    const fetched = await app.inject({
      method: 'GET',
      url: `/api/subscriptions/${subscriptionId}`,
      headers: { cookie },
    });
    expect(listed.body).not.toContain(stored.tokenHash);
    expect(fetched.body).not.toContain(stored.tokenHash);

    const publicResponse = await app.inject({ method: 'GET', url: `/sub/${subscriptionToken}` });
    expect(publicResponse.statusCode, publicResponse.body).toBe(200);
    expect(publicResponse.headers['content-type']).toContain('text/plain');
    expect(publicResponse.body).toContain('vless://');
    expect(publicResponse.headers.etag).toBeTruthy();
    expect(publicResponse.headers['cache-control']).toBe('private, no-store');
    const firstEtag = publicResponse.headers.etag;

    const notModified = await app.inject({
      method: 'GET',
      url: `/sub/${subscriptionToken}`,
      headers: { 'if-none-match': firstEtag },
    });
    expect(notModified.statusCode).toBe(304);
    expect(notModified.headers.etag).toBe(firstEtag);
    expect(notModified.headers['cache-control']).toBe('private, no-store');
    const stable = await app.inject({ method: 'GET', url: `/sub/${subscriptionToken}` });
    expect(stable.headers.etag).toBe(firstEtag);
    expect(stable.body).toBe(publicResponse.body);
    expect(
      (await prisma.subscription.findUniqueOrThrow({ where: { id: subscriptionId } })).lastAccessAt,
    ).not.toBeNull();

    const contentNode = await prisma.node.findFirstOrThrow({ where: { enabled: true } });
    await prisma.node.update({
      where: { id: contentNode.id },
      data: { name: `${contentNode.name} ETag Change` },
    });
    const changed = await app.inject({ method: 'GET', url: `/sub/${subscriptionToken}` });
    expect(changed.headers.etag).not.toBe(firstEtag);
    await prisma.node.update({ where: { id: contentNode.id }, data: { name: contentNode.name } });

    const logDirectory = await mkdtemp(join(tmpdir(), 'proxyhub-log-test-'));
    const logFile = join(logDirectory, 'server.log');
    const loggingApp = await buildApp({ agentClient, logFile });
    try {
      expect(
        (await loggingApp.inject({ method: 'GET', url: `/sub/${subscriptionToken}` })).statusCode,
      ).toBe(200);
    } finally {
      await loggingApp.close();
    }
    const capturedLogs = await readFile(logFile, 'utf8');
    expect(capturedLogs).not.toContain(subscriptionToken);
    expect(capturedLogs).toContain('/sub/[REDACTED]');
    await rm(logFile, { force: true });
    await rmdir(logDirectory);

    const invalid = await app.inject({ method: 'GET', url: '/sub/not-a-valid-token' });
    expect(invalid.statusCode).toBe(404);
    expect(invalid.json().error.code).toBe('SUBSCRIPTION_TOKEN_INVALID');

    const [rotated, racingOldRequest] = await Promise.all([
      app.inject({
        method: 'POST',
        url: `/api/subscriptions/${subscriptionId}/rotate-token`,
        headers: { cookie },
      }),
      app.inject({ method: 'GET', url: `/sub/${subscriptionToken}` }),
    ]);
    expect(rotated.statusCode, rotated.body).toBe(200);
    expect([200, 404]).toContain(racingOldRequest.statusCode);
    const newToken = rotated.json().data.token as string;
    expect(newToken).not.toBe(subscriptionToken);
    const finalOldResponse = await app.inject({ method: 'GET', url: `/sub/${subscriptionToken}` });
    expect(finalOldResponse.statusCode).toBe(404);
    expect(finalOldResponse.json()).toEqual(invalid.json());
    subscriptionToken = newToken;
    expect((await app.inject({ method: 'GET', url: `/sub/${subscriptionToken}` })).statusCode).toBe(
      200,
    );

    await app.inject({
      method: 'PATCH',
      url: `/api/subscriptions/${subscriptionId}`,
      headers: { cookie },
      payload: { enabled: false },
    });
    expect((await app.inject({ method: 'GET', url: `/sub/${subscriptionToken}` })).statusCode).toBe(
      403,
    );
    await app.inject({
      method: 'PATCH',
      url: `/api/subscriptions/${subscriptionId}`,
      headers: { cookie },
      payload: { enabled: true, expiresAt: new Date(Date.now() - 60_000).toISOString() },
    });
    expect((await app.inject({ method: 'GET', url: `/sub/${subscriptionToken}` })).statusCode).toBe(
      410,
    );
    await app.inject({
      method: 'PATCH',
      url: `/api/subscriptions/${subscriptionId}`,
      headers: { cookie },
      payload: { expiresAt: null },
    });

    await prisma.policy.update({ where: { id: policyId }, data: { enabled: false } });
    const compileFailure = await app.inject({
      method: 'GET',
      url: `/sub/${subscriptionToken}`,
    });
    expect(compileFailure.statusCode).toBe(422);
    expect(compileFailure.json()).toEqual({
      success: false,
      error: {
        code: 'SUBSCRIPTION_COMPILE_FAILED',
        message: 'Subscription content is temporarily unavailable',
      },
    });
    expect(compileFailure.body).not.toContain(policyId);
    expect(compileFailure.body).not.toContain('POLICY_DISABLED');
    await prisma.policy.update({ where: { id: policyId }, data: { enabled: true } });

    const rateLimitedResponses = [];
    for (let index = 0; index < 31; index += 1) {
      rateLimitedResponses.push(
        await app.inject({
          method: 'GET',
          url: '/sub/rate-limit-probe',
          remoteAddress: '198.51.100.77',
        }),
      );
    }
    expect(rateLimitedResponses.some((response) => response.statusCode === 429)).toBe(true);

    const preview = await app.inject({
      method: 'POST',
      url: `/api/subscriptions/${subscriptionId}/preview`,
      headers: { cookie },
    });
    expect(preview.statusCode, preview.body).toBe(200);
    expect(preview.json().data.format).toBe('raw');
    expect(preview.json().data.sanitized).toBe(true);
    expect(preview.json().data.output).not.toContain((await prisma.node.findFirstOrThrow()).uuid);
    expect(preview.json().data.output).not.toContain(subscriptionToken);

    const accessBeforeChecks = (
      await prisma.subscription.findUniqueOrThrow({ where: { id: subscriptionId } })
    ).lastAccessAt?.toISOString();
    const readiness = await app.inject({
      method: 'POST',
      url: `/api/subscriptions/${subscriptionId}/readiness`,
      headers: { cookie },
    });
    expect(readiness.statusCode, readiness.body).toBe(200);
    expect(['READY', 'READY_WITH_WARNINGS']).toContain(readiness.json().data.status);
    expect(readiness.json().data.checks).toContainEqual(
      expect.objectContaining({ id: 'compile-dry-run', status: 'PASSED' }),
    );

    const responseTest = await app.inject({
      method: 'POST',
      url: `/api/subscriptions/${subscriptionId}/test-response`,
      headers: { cookie },
    });
    expect(responseTest.statusCode, responseTest.body).toBe(200);
    expect(responseTest.json().data).toMatchObject({
      accessible: true,
      statusCode: 200,
      contentType: 'text/plain; charset=utf-8',
      cacheControl: 'private, no-store',
      format: 'raw',
      token: '[REDACTED]',
    });
    expect(responseTest.json().data.etag).toMatch(/^"[a-f0-9]{64}"$/u);
    expect(
      (
        await prisma.subscription.findUniqueOrThrow({ where: { id: subscriptionId } })
      ).lastAccessAt?.toISOString(),
    ).toBe(accessBeforeChecks);

    const capabilities = await app.inject({
      method: 'GET',
      url: '/api/subscriptions/capabilities',
      headers: { cookie },
    });
    expect(capabilities.statusCode).toBe(200);
    expect(capabilities.json().data).toHaveLength(3);
    expect(capabilities.json().data).toContainEqual(
      expect.objectContaining({
        format: 'raw',
        features: expect.objectContaining({ routingRules: 'UNSUPPORTED' }),
      }),
    );

    const policyDependencies = await app.inject({
      method: 'GET',
      url: `/api/resources/policy/${policyId}/dependencies`,
      headers: { cookie },
    });
    expect(policyDependencies.statusCode, policyDependencies.body).toBe(200);
    expect(policyDependencies.json().data.usedBy).toContainEqual(
      expect.objectContaining({
        resourceType: 'SUBSCRIPTION',
        resourceId: subscriptionId,
        relation: 'POLICY_USED_BY_SUBSCRIPTION',
      }),
    );
    expect(policyDependencies.body).not.toContain(subscriptionToken);

    const policyDeleteImpact = await app.inject({
      method: 'GET',
      url: `/api/resources/policy/${policyId}/delete-impact`,
      headers: { cookie },
    });
    expect(policyDeleteImpact.json().data).toMatchObject({
      status: 'BLOCKED',
      codes: ['SUBSCRIPTION_WOULD_LOSE_POLICY'],
    });

    const blockedServerDelete = await app.inject({
      method: 'DELETE',
      url: `/api/servers/${serverId}`,
      headers: { cookie },
    });
    expect(blockedServerDelete.statusCode, blockedServerDelete.body).toBe(409);
    expect(blockedServerDelete.json().error.code).toBe('DELETE_BLOCKED_BY_DEPENDENCY');
    expect(await prisma.server.findUnique({ where: { id: serverId } })).not.toBeNull();
    expect(
      await prisma.auditLog.count({
        where: {
          action: 'DELETE_BLOCKED_BY_DEPENDENCY',
          resource: 'SERVER',
          resourceId: serverId,
        },
      }),
    ).toBe(1);

    const setupProgress = await app.inject({
      method: 'GET',
      url: '/api/setup/progress',
      headers: { cookie },
    });
    expect(setupProgress.statusCode, setupProgress.body).toBe(200);
    expect(setupProgress.json().data.totalSteps).toBe(9);
    expect(setupProgress.body).not.toContain(subscriptionToken);
    expect(await prisma.auditLog.count({ where: { action: 'SETUP_PROGRESS_VIEWED' } })).toBe(0);

    const poolNode = await prisma.node.findFirstOrThrow({ where: { enabled: true } });
    await app.inject({
      method: 'PUT',
      url: `/api/node-pools/${policyPoolId}`,
      headers: { cookie },
      payload: {
        name: 'Policy Pool',
        description: 'Compiler integration pool',
        region: 'Global',
        strategy: 'MANUAL',
        enabled: true,
        nodeIds: [],
      },
    });
    const beforeBlockedUpdate = await prisma.subscription.findUniqueOrThrow({
      where: { id: subscriptionId },
    });
    const blockedUpdate = await app.inject({
      method: 'PATCH',
      url: `/api/subscriptions/${subscriptionId}`,
      headers: { cookie },
      payload: { name: 'Must Not Persist' },
    });
    expect(blockedUpdate.statusCode, blockedUpdate.body).toBe(422);
    expect(blockedUpdate.json().error.code).toBe('SUBSCRIPTION_NOT_READY');
    const afterBlockedUpdate = await prisma.subscription.findUniqueOrThrow({
      where: { id: subscriptionId },
    });
    expect(afterBlockedUpdate.name).toBe(beforeBlockedUpdate.name);
    expect(afterBlockedUpdate.tokenHash).toBe(beforeBlockedUpdate.tokenHash);
    expect(afterBlockedUpdate.lastAccessAt?.toISOString()).toBe(
      beforeBlockedUpdate.lastAccessAt?.toISOString(),
    );
    await app.inject({
      method: 'PUT',
      url: `/api/node-pools/${policyPoolId}`,
      headers: { cookie },
      payload: {
        name: 'Policy Pool',
        description: 'Compiler integration pool',
        region: 'Global',
        strategy: 'MANUAL',
        enabled: true,
        nodeIds: [poolNode.id],
      },
    });

    const deleted = await app.inject({
      method: 'DELETE',
      url: `/api/subscriptions/${subscriptionId}`,
      headers: { cookie },
    });
    expect(deleted.statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: `/sub/${subscriptionToken}` })).statusCode).toBe(
      404,
    );

    expect(
      (
        await app.inject({
          method: 'DELETE',
          url: `/api/policies/${policyId}`,
          headers: { cookie },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: 'DELETE',
          url: `/api/node-pools/${policyPoolId}`,
          headers: { cookie },
        })
      ).statusCode,
    ).toBe(200);

    const auditMetadata = (await prisma.auditLog.findMany())
      .map((entry) => entry.metadata)
      .join('\n');
    expect(auditMetadata).not.toContain(subscriptionToken);
    expect(auditMetadata).not.toContain(originalToken);
    const notificationContent = (await prisma.notification.findMany())
      .map((notification) => `${notification.title}\n${notification.message}`)
      .join('\n');
    expect(notificationContent).not.toContain(subscriptionToken);
    expect(notificationContent).not.toContain(originalToken);
  });

  it('tests Reality targets explicitly and distinguishes TLS from Reality failure', async () => {
    nextCompatibilityStatus = 'INCOMPATIBLE';
    const response = await app.inject({
      method: 'POST',
      url: '/api/nodes/reality-compatibility',
      headers: { cookie },
      payload: {
        serverName: 'incompatible.example',
        target: 'incompatible.example:443',
      },
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().data).toMatchObject({
      status: 'INCOMPATIBLE',
      tlsPrecheck: { status: 'PASSED' },
      realityHandshake: { status: 'FAILED' },
      endToEndTraffic: { status: 'NOT_RUN' },
    });
    await expect(
      prisma.auditLog.findFirstOrThrow({
        where: { action: 'REALITY_TARGET_COMPATIBILITY_TEST_FAILED', result: 'FAILURE' },
      }),
    ).resolves.toBeTruthy();
  });

  it('blocks an incompatible Node create before database or Xray mutation', async () => {
    const [countBefore, notificationsBefore] = await Promise.all([
      prisma.node.count(),
      prisma.notification.count(),
    ]);
    const applyCallsBefore = applyCalls;
    nextCompatibilityStatus = 'INCOMPATIBLE';
    const response = await app.inject({
      method: 'POST',
      url: '/api/nodes',
      headers: { cookie },
      payload: {
        name: 'Incompatible Reality Edge',
        serverId,
        host: 'edge.example.com',
        port: 9443,
        sni: 'incompatible.example',
        dest: 'incompatible.example:443',
        fingerprint: 'chrome',
      },
    });
    expect(response.statusCode, response.body).toBe(422);
    expect(response.json().error.code).toBe('REALITY_TARGET_INCOMPATIBLE');
    expect(await prisma.node.count()).toBe(countBefore);
    expect(applyCalls).toBe(applyCallsBefore);
    expect(await prisma.notification.count()).toBe(notificationsBefore + 1);
    await expect(
      prisma.notification.findFirstOrThrow({
        where: { eventType: 'REALITY_TARGET_INCOMPATIBLE', level: 'WARNING' },
      }),
    ).resolves.toBeTruthy();
  });

  it('preflights only Reality target changes and preserves the old node when incompatible', async () => {
    const current = await prisma.node.findFirstOrThrow();
    const compatibilityCallsBefore = compatibilityCalls;
    const renamed = await app.inject({
      method: 'PATCH',
      url: `/api/nodes/${current.id}`,
      headers: { cookie },
      payload: { name: 'Name-only Update' },
    });
    expect(renamed.statusCode, renamed.body).toBe(200);
    expect(compatibilityCalls).toBe(compatibilityCallsBefore);

    const applyCallsBefore = applyCalls;
    nextCompatibilityStatus = 'INCOMPATIBLE';
    const rejectedTarget = await app.inject({
      method: 'PATCH',
      url: `/api/nodes/${current.id}`,
      headers: { cookie },
      payload: { dest: 'incompatible.example:443' },
    });
    expect(rejectedTarget.statusCode, rejectedTarget.body).toBe(422);
    expect(compatibilityCalls).toBe(compatibilityCallsBefore + 1);
    expect(applyCalls).toBe(applyCallsBefore);
    expect((await prisma.node.findUniqueOrThrow({ where: { id: current.id } })).dest).toBe(
      current.dest,
    );

    const compatibleSni = await app.inject({
      method: 'PATCH',
      url: `/api/nodes/${current.id}`,
      headers: { cookie },
      payload: { sni: 'dl.google.com' },
    });
    expect(compatibleSni.statusCode, compatibleSni.body).toBe(200);
    expect(compatibilityCalls).toBe(compatibilityCallsBefore + 2);
  });

  it('rolls back the database and records a critical event when Xray rejects a change', async () => {
    const countBefore = await prisma.node.count();
    rejectNextApply = true;
    const response = await app.inject({
      method: 'POST',
      url: '/api/nodes',
      headers: { cookie },
      payload: {
        name: 'Rejected Edge',
        serverId,
        host: 'rejected.example.com',
        port: 8443,
        sni: 'www.microsoft.com',
        dest: 'www.microsoft.com:443',
        fingerprint: 'chrome',
      },
    });
    expect(response.statusCode).toBe(503);
    expect(await prisma.node.count()).toBe(countBefore);
    await expect(
      prisma.notification.findFirstOrThrow({
        where: { eventType: 'XRAY_CONFIG_APPLY_FAILED', level: 'CRITICAL' },
      }),
    ).resolves.toBeTruthy();
    await expect(
      prisma.auditLog.findFirstOrThrow({ where: { action: 'NODE_CREATE', result: 'FAILURE' } }),
    ).resolves.toBeTruthy();
  });

  it('rejects unauthenticated diagnostics access', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/diagnostics/overview' });
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe('AUTH_REQUIRED');
  });

  it('returns an authenticated schema-valid diagnostics overview', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/diagnostics/overview',
      headers: { cookie },
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().data.kind).toBe('overview');
    expect(response.json().data.items).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'database.sqlite.health' })]),
    );
  });

  it('does not create audit spam for overview polling', async () => {
    const before = await prisma.auditLog.count({ where: { action: 'DIAGNOSTICS_OVERVIEW' } });
    await app.inject({
      method: 'GET',
      url: '/api/diagnostics/overview',
      headers: { cookie },
    });
    expect(await prisma.auditLog.count({ where: { action: 'DIAGNOSTICS_OVERVIEW' } })).toBe(before);
  });

  it('runs manual deep diagnostics and creates an audit', async () => {
    const subscriptionsBefore = await prisma.subscription.findMany({
      select: { id: true, lastAccessAt: true, updatedAt: true },
      orderBy: { id: 'asc' },
    });
    const response = await app.inject({
      method: 'POST',
      url: '/api/diagnostics/run',
      headers: { cookie },
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().data.kind).toBe('deep');
    expect(
      await prisma.subscription.findMany({
        select: { id: true, lastAccessAt: true, updatedAt: true },
        orderBy: { id: 'asc' },
      }),
    ).toEqual(subscriptionsBefore);
    await expect(
      prisma.auditLog.findFirstOrThrow({
        where: { action: 'DIAGNOSTICS_DEEP_SCAN', result: 'SUCCESS' },
      }),
    ).resolves.toBeTruthy();
  });

  it('exports a sanitized diagnostics bundle and creates an audit', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/diagnostics/export',
      headers: { cookie },
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.headers['content-disposition']).toContain('proxyhub-diagnostics-');
    expect(response.json().data.kind).toBe('export');
    expect(response.body).not.toContain('correct-horse-battery-staple');
    expect(response.body).not.toContain('DATABASE_URL');
    await expect(
      prisma.auditLog.findFirstOrThrow({
        where: { action: 'DIAGNOSTICS_EXPORTED', result: 'SUCCESS' },
      }),
    ).resolves.toBeTruthy();
  });

  it('rejects non-admin diagnostics access', async () => {
    const admin = await prisma.adminUser.findUniqueOrThrow({ where: { username: 'admin' } });
    await prisma.adminUser.update({ where: { id: admin.id }, data: { role: 'VIEWER' } });
    try {
      const response = await app.inject({
        method: 'GET',
        url: '/api/diagnostics/overview',
        headers: { cookie },
      });
      expect(response.statusCode).toBe(403);
      expect(response.json().error.code).toBe('FORBIDDEN');
    } finally {
      await prisma.adminUser.update({ where: { id: admin.id }, data: { role: 'ADMIN' } });
    }
  });
});
