import { authenticator } from 'otplib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { XrayHealthStatus } from '@proxyhub/shared';
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
const appliedInboundCounts: number[] = [];
const agentClient: AgentClient = {
  status: async () => ({
    agent: { version: '0.1.1', hostname: 'agent-test', uptime: 100 },
    system: { cpuCount: 2, load: 0.1, memoryUsage: 20 },
    xray: healthyXray,
  }),
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
});
