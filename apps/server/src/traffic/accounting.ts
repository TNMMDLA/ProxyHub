import type { PrismaClient } from '@prisma/client';
import {
  cycleWindow,
  effectiveUserStatus,
  shouldResetMonthlyCycle,
  trafficDelta,
  type EffectiveUserStatus,
  type TrafficResetPolicy,
} from '@proxyhub/users-core';
import type { AgentClient } from '../agent-client.js';
import { AppError } from '../errors.js';
import { reconcileUserAccess } from '../users/reconciler.js';

const RECONCILE_PENDING_KEY = 'userAccessReconcilePending';
const ACCOUNTING_FAILURE_KEY = 'trafficAccountingFailureActive';

function statusFor(
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
  return effectiveUserStatus(
    {
      adminEnabled: user.adminEnabled,
      expiresAt: user.expiresAt,
      trafficLimitBytes: user.trafficLimitBytes,
      currentCycleUplinkBytes: user.trafficUsage?.currentCycleUplinkBytes ?? 0n,
      currentCycleDownlinkBytes: user.trafficUsage?.currentCycleDownlinkBytes ?? 0n,
    },
    now,
  );
}

function transitionEvent(previous: EffectiveUserStatus, next: EffectiveUserStatus) {
  if (previous === next) return null;
  if (next === 'TRAFFIC_EXHAUSTED')
    return {
      action: 'USER_TRAFFIC_EXHAUSTED',
      level: 'WARNING',
      title: 'User traffic exhausted',
    };
  if (next === 'EXPIRED')
    return { action: 'USER_EXPIRED', level: 'WARNING', title: 'User expired' };
  if (next === 'ACTIVE' && (previous === 'TRAFFIC_EXHAUSTED' || previous === 'EXPIRED'))
    return { action: 'USER_REACTIVATED', level: 'SUCCESS', title: 'User reactivated' };
  return null;
}

export class TrafficAccountingService {
  private running = false;

  constructor(
    private readonly database: PrismaClient,
    private readonly agentClient: AgentClient,
  ) {}

  async markRecoveryPending(): Promise<void> {
    const accessCount = await this.database.userAccess.count({
      where: { revokedAt: null, user: { deletedAt: null } },
    });
    if (accessCount === 0) return;
    await this.database.systemSetting.upsert({
      where: { key: RECONCILE_PENDING_KEY },
      create: { key: RECONCILE_PENDING_KEY, value: 'true' },
      update: { value: 'true' },
    });
  }

  async tick(now = new Date()): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.runTick(now);
      const activeFailure = await this.database.systemSetting.findUnique({
        where: { key: ACCOUNTING_FAILURE_KEY },
      });
      if (activeFailure?.value === 'true') {
        await this.database.systemSetting.update({
          where: { key: ACCOUNTING_FAILURE_KEY },
          data: { value: 'false' },
        });
      }
    } catch (error) {
      await this.recordAccountingFailure(error).catch(() => undefined);
      throw error;
    } finally {
      this.running = false;
    }
  }

  private async recordAccountingFailure(error: unknown): Promise<void> {
    const activeFailure = await this.database.systemSetting.findUnique({
      where: { key: ACCOUNTING_FAILURE_KEY },
    });
    if (activeFailure?.value === 'true') return;
    await this.database.$transaction([
      this.database.systemSetting.upsert({
        where: { key: ACCOUNTING_FAILURE_KEY },
        create: { key: ACCOUNTING_FAILURE_KEY, value: 'true' },
        update: { value: 'true' },
      }),
      this.database.auditLog.create({
        data: {
          actorName: 'system',
          action: 'TRAFFIC_ACCOUNTING_FAILED',
          resource: 'TrafficAccounting',
          result: 'FAILURE',
          metadata: JSON.stringify({
            error:
              error instanceof AppError
                ? { code: error.code, statusCode: error.statusCode }
                : { code: 'TRAFFIC_ACCOUNTING_UNKNOWN_ERROR' },
          }),
        },
      }),
      this.database.notification.create({
        data: {
          level: 'CRITICAL',
          title: 'Traffic accounting failed',
          message: 'Xray user traffic could not be collected. Existing counters were preserved.',
          eventType: 'TRAFFIC_ACCOUNTING_FAILED',
        },
      }),
    ]);
  }

  private async runTick(now: Date): Promise<void> {
    const accesses = await this.database.userAccess.findMany({
      where: { revokedAt: null, user: { deletedAt: null } },
      include: {
        runtimeCounter: true,
        user: { include: { trafficUsage: true } },
      },
      orderBy: { id: 'asc' },
    });
    const previousStatuses = new Map(
      accesses.map((access) => [access.userId, access.user.lifecycleStatus as EffectiveUserStatus]),
    );
    const metrics =
      accesses.length === 0
        ? []
        : await this.agentClient.userStats?.().catch((error) => {
            throw new AppError(
              'TRAFFIC_ACCOUNTING_XRAY_ERROR',
              `Unable to read Xray user stats: ${(error as Error).message}`,
              503,
            );
          });
    if (accesses.length > 0 && metrics === undefined)
      throw new AppError(
        'TRAFFIC_ACCOUNTING_UNAVAILABLE',
        'The Agent does not expose Xray user statistics',
        503,
      );
    const metricMap = new Map(
      (metrics ?? []).map((metric) => {
        if (!/^\d+$/u.test(metric.uplinkBytes) || !/^\d+$/u.test(metric.downlinkBytes))
          throw new AppError('TRAFFIC_COUNTER_INVALID', 'Xray returned an invalid counter', 503);
        return [
          metric.statsIdentity,
          { uplinkBytes: BigInt(metric.uplinkBytes), downlinkBytes: BigInt(metric.downlinkBytes) },
        ];
      }),
    );
    const affectedUserIds = new Set(accesses.map((access) => access.userId));
    const transitions = await this.database.$transaction(async (transaction) => {
      for (const userId of affectedUserIds) {
        const access = accesses.find((candidate) => candidate.userId === userId)!;
        const usage = access.user.trafficUsage;
        if (
          usage &&
          shouldResetMonthlyCycle(
            access.user.resetPolicy as TrafficResetPolicy,
            usage.cycleEndsAt,
            now,
          )
        ) {
          const window = cycleWindow(
            access.user.resetPolicy as TrafficResetPolicy,
            access.user.resetDay,
            now,
          );
          await transaction.userTrafficUsage.update({
            where: { userId },
            data: {
              currentCycleUplinkBytes: 0n,
              currentCycleDownlinkBytes: 0n,
              cycleStartedAt: window.startedAt,
              cycleEndsAt: window.endsAt,
            },
          });
          await transaction.userAccessTrafficUsage.updateMany({
            where: { userAccess: { userId } },
            data: { currentCycleUplinkBytes: 0n, currentCycleDownlinkBytes: 0n },
          });
        }
      }

      for (const access of accesses) {
        const current = metricMap.get(access.statsIdentity);
        if (!current) continue;
        const delta = trafficDelta(
          {
            uplinkBytes: access.runtimeCounter?.uplinkBytes ?? 0n,
            downlinkBytes: access.runtimeCounter?.downlinkBytes ?? 0n,
          },
          current,
        );
        const active = delta.uplinkBytes > 0n || delta.downlinkBytes > 0n;
        await transaction.userTrafficRuntimeCounter.upsert({
          where: { userAccessId: access.id },
          create: {
            userAccessId: access.id,
            ...current,
            observedAt: now,
          },
          update: { ...current, observedAt: now },
        });
        if (!active) continue;
        await transaction.userAccessTrafficUsage.update({
          where: { userAccessId: access.id },
          data: {
            currentCycleUplinkBytes: { increment: delta.uplinkBytes },
            currentCycleDownlinkBytes: { increment: delta.downlinkBytes },
            lifetimeUplinkBytes: { increment: delta.uplinkBytes },
            lifetimeDownlinkBytes: { increment: delta.downlinkBytes },
            lastTrafficAt: now,
          },
        });
        await transaction.userTrafficUsage.update({
          where: { userId: access.userId },
          data: {
            currentCycleUplinkBytes: { increment: delta.uplinkBytes },
            currentCycleDownlinkBytes: { increment: delta.downlinkBytes },
            lifetimeUplinkBytes: { increment: delta.uplinkBytes },
            lifetimeDownlinkBytes: { increment: delta.downlinkBytes },
          },
        });
        await transaction.user.update({
          where: { id: access.userId },
          data: { lastTrafficAt: now },
        });
      }

      const updatedUsers = await transaction.user.findMany({
        where: { id: { in: [...affectedUserIds] } },
        include: { trafficUsage: true },
      });
      const changed: Array<{
        userId: string;
        userName: string;
        previous: EffectiveUserStatus;
        next: EffectiveUserStatus;
      }> = [];
      for (const user of updatedUsers) {
        const previous = previousStatuses.get(user.id) ?? statusFor(user);
        const next = statusFor(user, now);
        await transaction.user.update({
          where: { id: user.id },
          data: { lifecycleStatus: next },
        });
        const event = transitionEvent(previous, next);
        if (!event) continue;
        changed.push({ userId: user.id, userName: user.name, previous, next });
        await transaction.auditLog.create({
          data: {
            actorName: 'system',
            action: event.action,
            resource: 'User',
            resourceId: user.id,
            result: 'SUCCESS',
            metadata: JSON.stringify({ previousStatus: previous, nextStatus: next }),
          },
        });
        await transaction.notification.create({
          data: {
            level: event.level,
            title: event.title,
            message: `${user.name}: ${previous} → ${next}`,
            eventType: event.action,
          },
        });
      }
      if (changed.length > 0) {
        await transaction.systemSetting.upsert({
          where: { key: RECONCILE_PENDING_KEY },
          create: { key: RECONCILE_PENDING_KEY, value: 'true' },
          update: { value: 'true' },
        });
      }
      return changed;
    });

    const pending = await this.database.systemSetting.findUnique({
      where: { key: RECONCILE_PENDING_KEY },
    });
    if (transitions.length === 0 && pending?.value !== 'true') return;
    try {
      await reconcileUserAccess(this.agentClient);
      await this.database.systemSetting.upsert({
        where: { key: RECONCILE_PENDING_KEY },
        create: { key: RECONCILE_PENDING_KEY, value: 'false' },
        update: { value: 'false' },
      });
    } catch (error) {
      const duplicate = await this.database.notification.findFirst({
        where: { eventType: 'USER_RECONCILE_FAILED', readAt: null },
      });
      if (!duplicate) {
        await this.database.notification.create({
          data: {
            level: 'CRITICAL',
            title: 'User access reconciliation failed',
            message: 'Traffic enforcement could not synchronize the desired Xray client list.',
            eventType: 'USER_RECONCILE_FAILED',
          },
        });
      }
      throw error;
    }
  }
}
