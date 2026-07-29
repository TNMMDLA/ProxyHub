import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import type { AgentClient } from '../agent-client.js';
import { prisma } from '../db.js';
import { encryptSecret } from '../security/crypto.js';
import { TrafficAccountingService } from './accounting.js';

interface Metric {
  statsIdentity: string;
  uplinkBytes: string;
  downlinkBytes: string;
}

let metrics: Metric[] = [];
const appliedConfigs: Record<string, unknown>[] = [];
const agent = {
  userStats: async () => metrics,
  applyConfig: async (config: Record<string, unknown>) => {
    appliedConfigs.push(config);
    return {
      applied: true as const,
      restarted: true as const,
      revision: randomUUID(),
      health: {} as never,
    };
  },
  confirm: async () => ({ confirmed: true as const }),
  rollback: async () => ({ rolledBack: true as const, health: {} as never }),
} as unknown as AgentClient;

async function createAccess(input?: {
  userName?: string;
  trafficLimitBytes?: bigint | null;
  resetPolicy?: 'NEVER' | 'MONTHLY';
  resetDay?: number | null;
  cycleEndsAt?: Date | null;
  expiresAt?: Date | null;
}) {
  const server = await prisma.server.create({
    data: {
      name: `Traffic server ${randomUUID()}`,
      hostname: 'traffic.test',
      ip: '192.0.2.20',
    },
  });
  const node = await prisma.node.create({
    data: {
      serverId: server.id,
      name: `Traffic node ${randomUUID()}`,
      host: 'traffic.test',
      port: 20_000 + Math.floor(Math.random() * 20_000),
      uuid: randomUUID(),
      realityPublicKey: 'public',
      realityPrivateKeyEncrypted: encryptSecret('private'),
      shortId: '0123456789abcdef',
      sni: 'www.example.com',
      dest: 'www.example.com:443',
    },
  });
  const user = await prisma.user.create({
    data: {
      name: input?.userName ?? `Traffic user ${randomUUID()}`,
      trafficLimitBytes: input?.trafficLimitBytes ?? null,
      expiresAt: input?.expiresAt ?? null,
      resetPolicy: input?.resetPolicy ?? 'NEVER',
      resetDay: input?.resetDay ?? null,
      credential: { create: { encryptedClientId: encryptSecret(randomUUID()) } },
      trafficUsage: {
        create: {
          cycleStartedAt: new Date('2026-06-01T00:00:00.000Z'),
          cycleEndsAt: input?.cycleEndsAt ?? null,
        },
      },
    },
  });
  const accessId = randomUUID();
  const access = await prisma.userAccess.create({
    data: {
      id: accessId,
      userId: user.id,
      nodeId: node.id,
      statsIdentity: `phu-${user.id}-${accessId}`,
      trafficUsage: { create: {} },
    },
  });
  return { user, access, node };
}

beforeEach(async () => {
  metrics = [];
  appliedConfigs.length = 0;
  await prisma.user.deleteMany();
  await prisma.node.deleteMany();
  await prisma.server.deleteMany();
  await prisma.notification.deleteMany({
    where: {
      eventType: {
        in: [
          'TRAFFIC_ACCOUNTING_FAILED',
          'USER_TRAFFIC_EXHAUSTED',
          'USER_EXPIRED',
          'USER_REACTIVATED',
          'USER_RECONCILE_FAILED',
        ],
      },
    },
  });
  await prisma.systemSetting.deleteMany({
    where: {
      key: { in: ['userAccessReconcilePending', 'trafficAccountingFailureActive'] },
    },
  });
});

describe('TrafficAccountingService', () => {
  it('accounts uplink and downlink deltas once across multiple accesses', async () => {
    const first = await createAccess();
    const secondServer = await prisma.server.create({
      data: {
        name: 'Second traffic server',
        hostname: 'traffic-2.test',
        ip: '192.0.2.21',
      },
    });
    const secondNode = await prisma.node.create({
      data: {
        serverId: secondServer.id,
        name: 'Second traffic node',
        host: 'traffic-2.test',
        port: first.node.port + 1,
        uuid: randomUUID(),
        realityPublicKey: 'public',
        realityPrivateKeyEncrypted: encryptSecret('private'),
        shortId: 'fedcba9876543210',
        sni: 'www.example.com',
        dest: 'www.example.com:443',
      },
    });
    const secondId = randomUUID();
    const second = await prisma.userAccess.create({
      data: {
        id: secondId,
        userId: first.user.id,
        nodeId: secondNode.id,
        statsIdentity: `phu-${first.user.id}-${secondId}`,
        trafficUsage: { create: {} },
      },
    });
    metrics = [
      { statsIdentity: first.access.statsIdentity, uplinkBytes: '100', downlinkBytes: '300' },
      { statsIdentity: second.statsIdentity, uplinkBytes: '50', downlinkBytes: '75' },
      { statsIdentity: 'unknown-identity', uplinkBytes: '999', downlinkBytes: '999' },
    ];
    const service = new TrafficAccountingService(prisma, agent);
    await service.tick(new Date('2026-07-29T00:00:00.000Z'));
    await service.tick(new Date('2026-07-29T00:00:30.000Z'));

    const usage = await prisma.userTrafficUsage.findUniqueOrThrow({
      where: { userId: first.user.id },
    });
    expect(usage.currentCycleUplinkBytes).toBe(150n);
    expect(usage.currentCycleDownlinkBytes).toBe(375n);
    expect(usage.lifetimeUplinkBytes).toBe(150n);
    expect(usage.lifetimeDownlinkBytes).toBe(375n);
  });

  it('treats a lower Xray counter as a process reset and preserves lifetime totals', async () => {
    const record = await createAccess();
    const service = new TrafficAccountingService(prisma, agent);
    metrics = [
      { statsIdentity: record.access.statsIdentity, uplinkBytes: '1000', downlinkBytes: '2000' },
    ];
    await service.tick();
    metrics = [
      { statsIdentity: record.access.statsIdentity, uplinkBytes: '25', downlinkBytes: '40' },
    ];
    await service.tick();

    const usage = await prisma.userTrafficUsage.findUniqueOrThrow({
      where: { userId: record.user.id },
    });
    expect(usage.lifetimeUplinkBytes).toBe(1025n);
    expect(usage.lifetimeDownlinkBytes).toBe(2040n);
  });

  it('enforces an exact quota and reconciles the Xray desired state once', async () => {
    const record = await createAccess({ trafficLimitBytes: 500n });
    metrics = [
      { statsIdentity: record.access.statsIdentity, uplinkBytes: '200', downlinkBytes: '300' },
    ];
    await new TrafficAccountingService(prisma, agent).tick();

    expect(appliedConfigs).toHaveLength(1);
    const config = appliedConfigs[0] as {
      inbounds: Array<{ settings: { clients: Array<{ email?: string }> } }>;
    };
    expect(config.inbounds[0]?.settings.clients.some((client) => client.email)).toBe(false);
    expect(
      await prisma.notification.count({ where: { eventType: 'USER_TRAFFIC_EXHAUSTED' } }),
    ).toBe(1);
  });

  it('resets an elapsed monthly cycle before applying new traffic', async () => {
    const record = await createAccess({
      resetPolicy: 'MONTHLY',
      resetDay: 1,
      cycleEndsAt: new Date('2026-07-01T00:00:00.000Z'),
    });
    await prisma.userTrafficUsage.update({
      where: { userId: record.user.id },
      data: { currentCycleUplinkBytes: 900n, lifetimeUplinkBytes: 900n },
    });
    await prisma.user.update({
      where: { id: record.user.id },
      data: { lifecycleStatus: 'TRAFFIC_EXHAUSTED' },
    });
    metrics = [
      { statsIdentity: record.access.statsIdentity, uplinkBytes: '10', downlinkBytes: '0' },
    ];
    await new TrafficAccountingService(prisma, agent).tick(new Date('2026-07-29T00:00:00.000Z'));

    const usage = await prisma.userTrafficUsage.findUniqueOrThrow({
      where: { userId: record.user.id },
    });
    expect(usage.currentCycleUplinkBytes).toBe(10n);
    expect(usage.lifetimeUplinkBytes).toBe(910n);
    expect(usage.cycleStartedAt.toISOString()).toBe('2026-07-01T00:00:00.000Z');
    expect(usage.cycleEndsAt?.toISOString()).toBe('2026-08-01T00:00:00.000Z');
    expect(appliedConfigs).toHaveLength(1);
  });

  it('detects expiration after restart from the persisted lifecycle snapshot', async () => {
    const record = await createAccess({
      expiresAt: new Date('2026-07-28T23:59:59.000Z'),
    });
    metrics = [
      { statsIdentity: record.access.statsIdentity, uplinkBytes: '0', downlinkBytes: '0' },
    ];
    await new TrafficAccountingService(prisma, agent).tick(new Date('2026-07-29T00:00:00.000Z'));

    expect(appliedConfigs).toHaveLength(1);
    expect(await prisma.notification.count({ where: { eventType: 'USER_EXPIRED' } })).toBe(1);
    expect(
      (await prisma.user.findUniqueOrThrow({ where: { id: record.user.id } })).lifecycleStatus,
    ).toBe('EXPIRED');
  });

  it('rejects malformed metrics transactionally and deduplicates failure notifications', async () => {
    const record = await createAccess();
    metrics = [
      { statsIdentity: record.access.statsIdentity, uplinkBytes: '-1', downlinkBytes: '20' },
    ];
    const service = new TrafficAccountingService(prisma, agent);
    await expect(service.tick()).rejects.toMatchObject({ code: 'TRAFFIC_COUNTER_INVALID' });
    await expect(service.tick()).rejects.toMatchObject({ code: 'TRAFFIC_COUNTER_INVALID' });

    const usage = await prisma.userTrafficUsage.findUniqueOrThrow({
      where: { userId: record.user.id },
    });
    expect(usage.lifetimeUplinkBytes).toBe(0n);
    expect(
      await prisma.notification.count({ where: { eventType: 'TRAFFIC_ACCOUNTING_FAILED' } }),
    ).toBe(1);
  });
});
