import { randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import type { FastifyRequest } from 'fastify';
import {
  assertResetDay,
  assertTrafficLimit,
  cycleWindow,
  effectiveUserStatus,
  serializeBytes,
  statsIdentity,
  type EffectiveUserStatus,
  type TrafficResetPolicy,
} from '@proxyhub/users-core';
import { createVlessUri } from '@proxyhub/xray-manager';
import type { AgentClient } from '../agent-client.js';
import { audit } from '../audit.js';
import { prisma } from '../db.js';
import { AppError } from '../errors.js';
import { decryptSecret, encryptSecret } from '../security/crypto.js';
import { buildDesiredXrayConfig, isUserNodeSupported } from './reconciler.js';

interface MutationResult<T> {
  value: T;
  reconcile: boolean;
  resourceId: string;
  metadata?: unknown;
  notifications?: Array<{
    level: string;
    title: string;
    message: string;
    eventType: string;
  }>;
}

interface CreateUserInput {
  name: string;
  remark: string;
  groupId: string | null;
  adminEnabled: boolean;
  expiresAt: Date | null;
  trafficLimitBytes: bigint | null;
  resetPolicy: TrafficResetPolicy;
  resetDay: number | null;
  nodeIds: string[];
}

interface UpdateUserInput {
  name?: string | undefined;
  remark?: string | undefined;
  groupId?: string | null | undefined;
  adminEnabled?: boolean | undefined;
  expiresAt?: Date | null | undefined;
  trafficLimitBytes?: bigint | null | undefined;
  resetPolicy?: TrafficResetPolicy | undefined;
  resetDay?: number | null | undefined;
}

const userInclude = {
  group: true,
  credential: { select: { id: true, createdAt: true, rotatedAt: true } },
  trafficUsage: true,
  accesses: {
    where: { revokedAt: null },
    include: {
      node: { include: { server: { select: { id: true, name: true } } } },
      trafficUsage: true,
    },
    orderBy: { createdAt: 'asc' },
  },
} satisfies Prisma.UserInclude;

type UserRecord = Prisma.UserGetPayload<{ include: typeof userInclude }>;

function validatedTrafficLimit(value: bigint | null): bigint | null {
  try {
    return assertTrafficLimit(value);
  } catch {
    throw new AppError('TRAFFIC_LIMIT_INVALID', 'Traffic limit must be greater than zero', 422);
  }
}

function validatedResetDay(policy: TrafficResetPolicy, resetDay: number | null): number | null {
  try {
    return assertResetDay(policy, resetDay);
  } catch {
    throw new AppError(
      'TRAFFIC_RESET_DAY_INVALID',
      'Monthly reset day must be between 1 and 28',
      422,
    );
  }
}

function usageOf(user: {
  trafficUsage: {
    currentCycleUplinkBytes: bigint;
    currentCycleDownlinkBytes: bigint;
  } | null;
}) {
  return {
    currentCycleUplinkBytes: user.trafficUsage?.currentCycleUplinkBytes ?? 0n,
    currentCycleDownlinkBytes: user.trafficUsage?.currentCycleDownlinkBytes ?? 0n,
  };
}

export function statusOf(
  user: {
    adminEnabled: boolean;
    expiresAt: Date | null;
    trafficLimitBytes: bigint | null;
    trafficUsage: {
      currentCycleUplinkBytes: bigint;
      currentCycleDownlinkBytes: bigint;
    } | null;
  },
  now = new Date(),
): EffectiveUserStatus {
  return effectiveUserStatus({ ...user, ...usageOf(user) }, now);
}

function serializeUsage(
  usage: {
    currentCycleUplinkBytes: bigint;
    currentCycleDownlinkBytes: bigint;
    lifetimeUplinkBytes: bigint;
    lifetimeDownlinkBytes: bigint;
    cycleStartedAt?: Date;
    cycleEndsAt?: Date | null;
    lastTrafficAt?: Date | null;
  } | null,
) {
  const currentUplink = usage?.currentCycleUplinkBytes ?? 0n;
  const currentDownlink = usage?.currentCycleDownlinkBytes ?? 0n;
  const lifetimeUplink = usage?.lifetimeUplinkBytes ?? 0n;
  const lifetimeDownlink = usage?.lifetimeDownlinkBytes ?? 0n;
  return {
    currentCycleUplinkBytes: serializeBytes(currentUplink),
    currentCycleDownlinkBytes: serializeBytes(currentDownlink),
    currentCycleTotalBytes: serializeBytes(currentUplink + currentDownlink),
    lifetimeUplinkBytes: serializeBytes(lifetimeUplink),
    lifetimeDownlinkBytes: serializeBytes(lifetimeDownlink),
    lifetimeTotalBytes: serializeBytes(lifetimeUplink + lifetimeDownlink),
    cycleStartedAt: usage?.cycleStartedAt ?? null,
    cycleEndsAt: usage?.cycleEndsAt ?? null,
    lastTrafficAt: usage?.lastTrafficAt ?? null,
  };
}

export function serializeUser(user: UserRecord) {
  const usage = serializeUsage(user.trafficUsage);
  const limit = user.trafficLimitBytes;
  const current = BigInt(usage.currentCycleTotalBytes);
  return {
    id: user.id,
    name: user.name,
    remark: user.remark,
    groupId: user.groupId,
    group: user.group,
    adminEnabled: user.adminEnabled,
    expiresAt: user.expiresAt,
    resetPolicy: user.resetPolicy,
    resetDay: user.resetDay,
    status: statusOf(user),
    trafficLimitBytes: limit === null ? null : serializeBytes(limit),
    remainingBytes: limit === null ? null : serializeBytes(limit > current ? limit - current : 0n),
    lastTrafficAt: user.lastTrafficAt,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
    credential: user.credential,
    traffic: usage,
    accesses: user.accesses.map((access) => ({
      id: access.id,
      enabled: access.enabled,
      statsIdentity: access.statsIdentity,
      createdAt: access.createdAt,
      updatedAt: access.updatedAt,
      node: {
        id: access.node.id,
        name: access.node.name,
        protocol: access.node.protocol,
        transport: access.node.transport,
        enabled: access.node.enabled,
        status: access.node.status,
        server: access.node.server,
      },
      traffic: serializeUsage(access.trafficUsage),
    })),
  };
}

function transitionNotification(
  previous: EffectiveUserStatus,
  next: EffectiveUserStatus,
  userName: string,
) {
  if (previous === next) return [];
  if (next === 'TRAFFIC_EXHAUSTED')
    return [
      {
        level: 'WARNING',
        title: 'User traffic exhausted',
        message: `${userName} reached the current traffic limit.`,
        eventType: 'USER_TRAFFIC_EXHAUSTED',
      },
    ];
  if (next === 'EXPIRED')
    return [
      {
        level: 'WARNING',
        title: 'User expired',
        message: `${userName} reached the configured expiration time.`,
        eventType: 'USER_EXPIRED',
      },
    ];
  if (next === 'ACTIVE' && (previous === 'TRAFFIC_EXHAUSTED' || previous === 'EXPIRED'))
    return [
      {
        level: 'SUCCESS',
        title: 'User reactivated',
        message: `${userName} is eligible for node access again.`,
        eventType: 'USER_REACTIVATED',
      },
    ];
  return [];
}

export class UserService {
  constructor(private readonly agentClient: AgentClient) {}

  private async mutate<T>(
    request: FastifyRequest,
    action: string,
    operation: (transaction: Prisma.TransactionClient) => Promise<MutationResult<T>>,
  ): Promise<T> {
    let revision: string | undefined;
    let resourceId: string | undefined;
    let reconcileAttempted = false;
    try {
      const result = await prisma.$transaction(
        async (transaction) => {
          const outcome = await operation(transaction);
          resourceId = outcome.resourceId;
          if (outcome.reconcile) {
            reconcileAttempted = true;
            const desired = await buildDesiredXrayConfig(transaction);
            const applied = await this.agentClient.applyConfig(desired);
            revision = applied.revision;
          }
          await audit(
            request,
            action,
            'User',
            'SUCCESS',
            outcome.resourceId,
            outcome.metadata,
            transaction,
          );
          for (const notification of outcome.notifications ?? []) {
            await transaction.notification.create({ data: notification });
          }
          return outcome.value;
        },
        { maxWait: 5_000, timeout: 40_000 },
      );
      if (revision) {
        await this.agentClient.confirm(revision).catch(() => undefined);
      }
      return result;
    } catch (error) {
      let rollbackFailed = false;
      if (revision) {
        try {
          await this.agentClient.rollback(revision);
        } catch {
          rollbackFailed = true;
        }
      }
      await Promise.allSettled([
        audit(request, action, 'User', 'FAILURE', resourceId, {
          errorType: error instanceof AppError ? error.code : 'USER_RECONCILE_FAILED',
          rollbackFailed,
        }),
        ...(reconcileAttempted
          ? [
              prisma.notification.create({
                data: {
                  level: 'CRITICAL',
                  title: 'User access reconciliation failed',
                  message: rollbackFailed
                    ? 'Xray user reconciliation and rollback failed. Manual intervention is required.'
                    : 'The user change was rejected and the previous Xray configuration was preserved.',
                  eventType: 'USER_RECONCILE_FAILED',
                },
              }),
            ]
          : []),
      ]);
      if (error instanceof AppError) throw error;
      throw new AppError(
        reconcileAttempted ? 'USER_RECONCILE_FAILED' : 'USER_OPERATION_FAILED',
        reconcileAttempted
          ? 'The user change could not be reconciled with Xray'
          : 'The user operation failed',
        503,
      );
    }
  }

  async list(input: {
    page: number;
    limit: number;
    search?: string | undefined;
    status?: EffectiveUserStatus | undefined;
    groupId?: string | undefined;
  }) {
    const where: Prisma.UserWhereInput = {
      deletedAt: null,
      ...(input.search
        ? {
            OR: [{ name: { contains: input.search } }, { remark: { contains: input.search } }],
          }
        : {}),
      ...(input.groupId ? { groupId: input.groupId } : {}),
    };
    if (!input.status) {
      const [records, total] = await Promise.all([
        prisma.user.findMany({
          where,
          include: userInclude,
          orderBy: { createdAt: 'desc' },
          skip: (input.page - 1) * input.limit,
          take: input.limit,
        }),
        prisma.user.count({ where }),
      ]);
      return {
        items: records.map(serializeUser),
        page: input.page,
        limit: input.limit,
        total,
      };
    }
    const matching = (
      await prisma.user.findMany({
        where,
        include: userInclude,
        orderBy: { createdAt: 'desc' },
      })
    ).filter((record) => statusOf(record) === input.status);
    return {
      items: matching
        .slice((input.page - 1) * input.limit, input.page * input.limit)
        .map(serializeUser),
      page: input.page,
      limit: input.limit,
      total: matching.length,
    };
  }

  async detail(id: string) {
    const user = await prisma.user.findFirst({
      where: { id, deletedAt: null },
      include: userInclude,
    });
    if (!user) throw new AppError('USER_NOT_FOUND', 'User not found', 404);
    return serializeUser(user);
  }

  async create(request: FastifyRequest, input: CreateUserInput) {
    validatedTrafficLimit(input.trafficLimitBytes);
    const resetDay = validatedResetDay(input.resetPolicy, input.resetDay);
    return this.mutate(request, 'USER_CREATED', async (transaction) => {
      if (input.groupId) {
        const group = await transaction.userGroup.findUnique({ where: { id: input.groupId } });
        if (!group) throw new AppError('USER_GROUP_NOT_FOUND', 'User group not found', 404);
      }
      const nodes = await transaction.node.findMany({ where: { id: { in: input.nodeIds } } });
      if (nodes.length !== new Set(input.nodeIds).size)
        throw new AppError('NODE_NOT_FOUND', 'One or more nodes were not found', 404);
      if (nodes.some((node) => !isUserNodeSupported(node)))
        throw new AppError('USER_NODE_UNSUPPORTED', 'A selected node is unsupported', 422);
      const window = cycleWindow(input.resetPolicy, resetDay);
      const user = await transaction.user.create({
        data: {
          name: input.name,
          remark: input.remark,
          groupId: input.groupId,
          adminEnabled: input.adminEnabled,
          expiresAt: input.expiresAt,
          trafficLimitBytes: input.trafficLimitBytes,
          resetPolicy: input.resetPolicy,
          resetDay,
          lifecycleStatus: effectiveUserStatus({
            adminEnabled: input.adminEnabled,
            expiresAt: input.expiresAt,
            trafficLimitBytes: input.trafficLimitBytes,
            currentCycleUplinkBytes: 0n,
            currentCycleDownlinkBytes: 0n,
          }),
          credential: {
            create: { encryptedClientId: encryptSecret(randomUUID()) },
          },
          trafficUsage: {
            create: { cycleStartedAt: window.startedAt, cycleEndsAt: window.endsAt },
          },
        },
      });
      for (const nodeId of input.nodeIds) {
        const id = randomUUID();
        await transaction.userAccess.create({
          data: {
            id,
            userId: user.id,
            nodeId,
            statsIdentity: statsIdentity(user.id, id),
            trafficUsage: { create: {} },
          },
        });
      }
      const complete = await transaction.user.findUniqueOrThrow({
        where: { id: user.id },
        include: userInclude,
      });
      return {
        value: serializeUser(complete),
        reconcile: input.nodeIds.length > 0 && statusOf(complete) === 'ACTIVE',
        resourceId: user.id,
        metadata: { name: user.name, accessCount: input.nodeIds.length },
      };
    });
  }

  async update(
    request: FastifyRequest,
    id: string,
    input: UpdateUserInput,
    action = 'USER_UPDATED',
  ) {
    if (input.trafficLimitBytes !== undefined) validatedTrafficLimit(input.trafficLimitBytes);
    return this.mutate(request, action, async (transaction) => {
      const current = await transaction.user.findFirst({
        where: { id, deletedAt: null },
        include: userInclude,
      });
      if (!current) throw new AppError('USER_NOT_FOUND', 'User not found', 404);
      if (input.groupId) {
        const group = await transaction.userGroup.findUnique({ where: { id: input.groupId } });
        if (!group) throw new AppError('USER_GROUP_NOT_FOUND', 'User group not found', 404);
      }
      const resetPolicy = input.resetPolicy ?? (current.resetPolicy as TrafficResetPolicy);
      const resetDay = validatedResetDay(resetPolicy, input.resetDay ?? current.resetDay);
      if (input.resetPolicy !== undefined || input.resetDay !== undefined) {
        const window = cycleWindow(resetPolicy, resetDay);
        await transaction.userTrafficUsage.update({
          where: { userId: id },
          data: { cycleStartedAt: window.startedAt, cycleEndsAt: window.endsAt },
        });
      }
      await transaction.user.update({
        where: { id },
        data: {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.remark !== undefined ? { remark: input.remark } : {}),
          ...(input.groupId !== undefined ? { groupId: input.groupId } : {}),
          ...(input.adminEnabled !== undefined ? { adminEnabled: input.adminEnabled } : {}),
          ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
          ...(input.trafficLimitBytes !== undefined
            ? { trafficLimitBytes: input.trafficLimitBytes }
            : {}),
          resetPolicy,
          resetDay,
        },
      });
      const updated = await transaction.user.findUniqueOrThrow({
        where: { id },
        include: userInclude,
      });
      const previousStatus = statusOf(current);
      const nextStatus = statusOf(updated);
      await transaction.user.update({
        where: { id },
        data: { lifecycleStatus: nextStatus },
      });
      return {
        value: serializeUser(updated),
        reconcile: current.accesses.length > 0 && previousStatus !== nextStatus,
        resourceId: id,
        metadata: { fields: Object.keys(input), previousStatus, nextStatus },
        notifications: transitionNotification(previousStatus, nextStatus, updated.name),
      };
    });
  }

  async setEnabled(request: FastifyRequest, id: string, enabled: boolean) {
    return this.update(
      request,
      id,
      { adminEnabled: enabled },
      enabled ? 'USER_ENABLED' : 'USER_DISABLED',
    );
  }

  async delete(request: FastifyRequest, id: string) {
    return this.mutate(request, 'USER_DELETED', async (transaction) => {
      const current = await transaction.user.findFirst({
        where: { id, deletedAt: null },
        include: userInclude,
      });
      if (!current) throw new AppError('USER_NOT_FOUND', 'User not found', 404);
      await transaction.user.update({
        where: { id },
        data: { adminEnabled: false, lifecycleStatus: 'DISABLED', deletedAt: new Date() },
      });
      await transaction.userAccess.updateMany({
        where: { userId: id, revokedAt: null },
        data: { enabled: false, revokedAt: new Date() },
      });
      return {
        value: null,
        reconcile:
          current.accesses.some((access) => access.enabled) && statusOf(current) === 'ACTIVE',
        resourceId: id,
        metadata: { accessCount: current.accesses.length },
      };
    });
  }

  async grantAccess(request: FastifyRequest, userId: string, nodeIds: string[]) {
    return this.mutate(request, 'USER_ACCESS_GRANTED', async (transaction) => {
      const user = await transaction.user.findFirst({
        where: { id: userId, deletedAt: null },
        include: userInclude,
      });
      if (!user) throw new AppError('USER_NOT_FOUND', 'User not found', 404);
      const nodes = await transaction.node.findMany({ where: { id: { in: nodeIds } } });
      if (nodes.length !== new Set(nodeIds).size)
        throw new AppError('NODE_NOT_FOUND', 'One or more nodes were not found', 404);
      if (nodes.some((node) => !isUserNodeSupported(node)))
        throw new AppError('USER_NODE_UNSUPPORTED', 'A selected node is unsupported', 422);
      for (const nodeId of nodeIds) {
        const existing = await transaction.userAccess.findUnique({
          where: { userId_nodeId: { userId, nodeId } },
        });
        if (existing) {
          if (!existing.revokedAt)
            throw new AppError('USER_ACCESS_ALREADY_EXISTS', 'User access already exists', 409);
          await transaction.userAccess.update({
            where: { id: existing.id },
            data: { revokedAt: null, enabled: true },
          });
        } else {
          const id = randomUUID();
          await transaction.userAccess.create({
            data: {
              id,
              userId,
              nodeId,
              statsIdentity: statsIdentity(userId, id),
              trafficUsage: { create: {} },
            },
          });
        }
      }
      return {
        value: await transaction.user
          .findUniqueOrThrow({
            where: { id: userId },
            include: userInclude,
          })
          .then(serializeUser),
        reconcile: statusOf(user) === 'ACTIVE',
        resourceId: userId,
        metadata: { nodeIds, count: nodeIds.length },
      };
    });
  }

  async updateAccess(
    request: FastifyRequest,
    userId: string,
    accessId: string,
    operation: 'ENABLE' | 'DISABLE' | 'REVOKE',
  ) {
    const action =
      operation === 'REVOKE'
        ? 'USER_ACCESS_REVOKED'
        : operation === 'ENABLE'
          ? 'USER_ACCESS_ENABLED'
          : 'USER_ACCESS_DISABLED';
    return this.mutate(request, action, async (transaction) => {
      const access = await transaction.userAccess.findFirst({
        where: { id: accessId, userId, revokedAt: null },
        include: { user: { include: { trafficUsage: true } } },
      });
      if (!access) throw new AppError('USER_ACCESS_NOT_FOUND', 'User access not found', 404);
      await transaction.userAccess.update({
        where: { id: accessId },
        data:
          operation === 'REVOKE'
            ? { enabled: false, revokedAt: new Date() }
            : { enabled: operation === 'ENABLE' },
      });
      return {
        value: null,
        reconcile: statusOf(access.user) === 'ACTIVE',
        resourceId: userId,
        metadata: { accessId, nodeId: access.nodeId },
      };
    });
  }

  async rotateCredential(request: FastifyRequest, id: string) {
    return this.mutate(request, 'USER_CREDENTIAL_ROTATED', async (transaction) => {
      const user = await transaction.user.findFirst({
        where: { id, deletedAt: null },
        include: userInclude,
      });
      if (!user?.credential) throw new AppError('USER_NOT_FOUND', 'User not found', 404);
      await transaction.userCredential.update({
        where: { userId: id },
        data: { encryptedClientId: encryptSecret(randomUUID()), rotatedAt: new Date() },
      });
      return {
        value: { rotated: true },
        reconcile: user.accesses.some((access) => access.enabled) && statusOf(user) === 'ACTIVE',
        resourceId: id,
        metadata: { accessCount: user.accesses.length },
      };
    });
  }

  async resetTraffic(request: FastifyRequest, id: string) {
    return this.mutate(request, 'USER_TRAFFIC_RESET', async (transaction) => {
      const user = await transaction.user.findFirst({
        where: { id, deletedAt: null },
        include: userInclude,
      });
      if (!user) throw new AppError('USER_NOT_FOUND', 'User not found', 404);
      const previousStatus = statusOf(user);
      const window = cycleWindow(user.resetPolicy as TrafficResetPolicy, user.resetDay);
      await transaction.userTrafficUsage.update({
        where: { userId: id },
        data: {
          currentCycleUplinkBytes: 0n,
          currentCycleDownlinkBytes: 0n,
          cycleStartedAt: window.startedAt,
          cycleEndsAt: window.endsAt,
        },
      });
      await transaction.userAccessTrafficUsage.updateMany({
        where: { userAccess: { userId: id } },
        data: { currentCycleUplinkBytes: 0n, currentCycleDownlinkBytes: 0n },
      });
      const nextStatus = effectiveUserStatus({
        adminEnabled: user.adminEnabled,
        expiresAt: user.expiresAt,
        trafficLimitBytes: user.trafficLimitBytes,
        currentCycleUplinkBytes: 0n,
        currentCycleDownlinkBytes: 0n,
      });
      await transaction.user.update({
        where: { id },
        data: { lifecycleStatus: nextStatus },
      });
      return {
        value: { reset: true },
        reconcile: previousStatus !== nextStatus,
        resourceId: id,
        metadata: { previousStatus, nextStatus },
        notifications: transitionNotification(previousStatus, nextStatus, user.name),
      };
    });
  }

  async shareLink(request: FastifyRequest, userId: string, accessId: string) {
    const access = await prisma.userAccess.findFirst({
      where: { id: accessId, userId, revokedAt: null },
      include: { user: { include: { credential: true } }, node: true },
    });
    if (!access?.user.credential)
      throw new AppError('USER_SHARE_LINK_UNAVAILABLE', 'User access link is unavailable', 404);
    const uri = createVlessUri({
      ...access.node,
      uuid: decryptSecret(access.user.credential.encryptedClientId),
      name: `${access.user.name} - ${access.node.name}`,
    });
    await audit(request, 'USER_ACCESS_LINK_VIEWED', 'UserAccess', 'SUCCESS', accessId, {
      userId,
      nodeId: access.nodeId,
    });
    return { uri };
  }

  async listNodeUsers(nodeId: string) {
    const node = await prisma.node.findUnique({ where: { id: nodeId } });
    if (!node) throw new AppError('NODE_NOT_FOUND', 'Node not found', 404);
    const accesses = await prisma.userAccess.findMany({
      where: { nodeId, revokedAt: null, user: { deletedAt: null } },
      include: {
        user: { include: { trafficUsage: true } },
        trafficUsage: true,
      },
      orderBy: { createdAt: 'asc' },
    });
    return accesses.map((access) => ({
      id: access.id,
      enabled: access.enabled,
      status: statusOf(access.user),
      user: {
        id: access.user.id,
        name: access.user.name,
        lastTrafficAt: access.user.lastTrafficAt,
      },
      traffic: serializeUsage(access.trafficUsage),
    }));
  }
}
