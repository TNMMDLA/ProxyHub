import type { Prisma } from '@prisma/client';
import { effectiveUserStatus } from '@proxyhub/users-core';
import { buildXrayConfig } from '@proxyhub/xray-manager';
import type { AgentClient } from '../agent-client.js';
import { prisma } from '../db.js';
import { AppError } from '../errors.js';
import { decryptSecret } from '../security/crypto.js';

type ConfigDatabase = Pick<Prisma.TransactionClient, 'node'>;

let reconcileQueue = Promise.resolve();

export function isUserNodeSupported(node: {
  protocol: string;
  transport: string;
  flow: string;
}): boolean {
  return (
    node.protocol.toUpperCase() === 'VLESS' &&
    ['TCP', 'RAW'].includes(node.transport.toUpperCase()) &&
    node.flow === 'xtls-rprx-vision'
  );
}

export async function buildDesiredXrayConfig(
  database: ConfigDatabase,
  now = new Date(),
): Promise<Record<string, unknown>> {
  const nodes = await database.node.findMany({
    where: { enabled: true },
    include: {
      userAccesses: {
        where: {
          enabled: true,
          revokedAt: null,
          user: { deletedAt: null },
        },
        include: {
          user: {
            include: {
              credential: true,
              trafficUsage: true,
            },
          },
        },
        orderBy: { id: 'asc' },
      },
    },
    orderBy: [{ serverId: 'asc' }, { port: 'asc' }],
  });
  return buildXrayConfig(
    nodes.map((node) => {
      const clients = isUserNodeSupported(node)
        ? node.userAccesses.flatMap((access) => {
            const usage = access.user.trafficUsage;
            const status = effectiveUserStatus(
              {
                adminEnabled: access.user.adminEnabled,
                expiresAt: access.user.expiresAt,
                trafficLimitBytes: access.user.trafficLimitBytes,
                currentCycleUplinkBytes: usage?.currentCycleUplinkBytes ?? 0n,
                currentCycleDownlinkBytes: usage?.currentCycleDownlinkBytes ?? 0n,
              },
              now,
            );
            if (status !== 'ACTIVE' || !access.user.credential) return [];
            return [
              {
                uuid: decryptSecret(access.user.credential.encryptedClientId),
                statsIdentity: access.statsIdentity,
              },
            ];
          })
        : [];
      return {
        name: node.name,
        port: node.port,
        uuid: node.uuid,
        privateKey: decryptSecret(node.realityPrivateKeyEncrypted),
        shortId: node.shortId,
        sni: node.sni,
        dest: node.dest,
        fingerprint: node.fingerprint,
        clients,
      };
    }),
  );
}

async function applyDesiredConfig(agentClient: AgentClient): Promise<void> {
  let revision: string | undefined;
  try {
    const desired = await buildDesiredXrayConfig(prisma);
    const applied = await agentClient.applyConfig(desired);
    revision = applied.revision;
    await agentClient.confirm(revision);
  } catch (error) {
    if (revision) {
      try {
        await agentClient.rollback(revision);
      } catch {
        throw new AppError(
          'USER_RECONCILE_FAILED',
          'User access reconciliation and rollback failed',
          503,
        );
      }
    }
    if (error instanceof AppError) throw error;
    throw new AppError('USER_RECONCILE_FAILED', 'User access reconciliation failed', 503);
  }
}

export function reconcileUserAccess(agentClient: AgentClient): Promise<void> {
  const operation = reconcileQueue.then(
    () => applyDesiredConfig(agentClient),
    () => applyDesiredConfig(agentClient),
  );
  reconcileQueue = operation.then(
    () => undefined,
    () => undefined,
  );
  return operation;
}
