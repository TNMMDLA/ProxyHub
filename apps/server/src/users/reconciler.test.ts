import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { encryptSecret } from '../security/crypto.js';
import { buildDesiredXrayConfig, isUserNodeSupported } from './reconciler.js';

function access(status: {
  adminEnabled?: boolean;
  expiresAt?: Date | null;
  trafficLimitBytes?: bigint | null;
  used?: bigint;
  credential?: string | null;
}) {
  return {
    id: randomUUID(),
    statsIdentity: `phu-${randomUUID()}`,
    user: {
      adminEnabled: status.adminEnabled ?? true,
      expiresAt: status.expiresAt ?? null,
      trafficLimitBytes: status.trafficLimitBytes ?? null,
      credential:
        status.credential === null
          ? null
          : { encryptedClientId: encryptSecret(status.credential ?? randomUUID()) },
      trafficUsage: {
        currentCycleUplinkBytes: status.used ?? 0n,
        currentCycleDownlinkBytes: 0n,
      },
    },
  };
}

function node(userAccesses: ReturnType<typeof access>[]) {
  return {
    id: randomUUID(),
    serverId: randomUUID(),
    name: 'Managed Reality',
    protocol: 'VLESS',
    transport: 'TCP',
    flow: 'xtls-rprx-vision',
    port: 443,
    uuid: randomUUID(),
    realityPrivateKeyEncrypted: encryptSecret('private-key'),
    shortId: '0123456789abcdef',
    sni: 'www.example.com',
    dest: 'www.example.com:443',
    fingerprint: 'chrome',
    userAccesses,
  };
}

describe('user access desired-state reconciler', () => {
  it('keeps the legacy client and includes only ACTIVE managed clients', async () => {
    const active = access({ credential: randomUUID() });
    const records = [
      active,
      access({ adminEnabled: false }),
      access({ expiresAt: new Date('2026-07-28T00:00:00.000Z') }),
      access({ trafficLimitBytes: 100n, used: 100n }),
      access({ credential: null }),
    ];
    const database = {
      node: { findMany: async () => [node(records)] },
    } as never;

    const config = (await buildDesiredXrayConfig(
      database,
      new Date('2026-07-29T00:00:00.000Z'),
    )) as {
      inbounds: Array<{
        settings: { clients: Array<{ id: string; email?: string }> };
      }>;
    };
    const clients = config.inbounds[0]?.settings.clients ?? [];
    expect(clients).toHaveLength(2);
    expect(clients[0]?.email).toBeUndefined();
    expect(clients[1]?.email).toBe(active.statsIdentity);
  });

  it('compiles a rotated credential from encrypted database desired state', async () => {
    const first = randomUUID();
    const managed = access({ credential: first });
    const record = node([managed]);
    const database = {
      node: { findMany: async () => [record] },
    } as never;
    const before = (await buildDesiredXrayConfig(database)) as {
      inbounds: Array<{ settings: { clients: Array<{ id: string }> } }>;
    };
    const second = randomUUID();
    managed.user.credential = { encryptedClientId: encryptSecret(second) };
    const after = (await buildDesiredXrayConfig(database)) as typeof before;

    expect(before.inbounds[0]?.settings.clients[1]?.id).toBe(first);
    expect(after.inbounds[0]?.settings.clients[1]?.id).toBe(second);
  });

  it('recognizes only the supported VLESS Reality client shape', () => {
    expect(
      isUserNodeSupported({
        protocol: 'VLESS',
        transport: 'RAW',
        flow: 'xtls-rprx-vision',
      }),
    ).toBe(true);
    expect(
      isUserNodeSupported({
        protocol: 'VMESS',
        transport: 'TCP',
        flow: 'xtls-rprx-vision',
      }),
    ).toBe(false);
  });
});
