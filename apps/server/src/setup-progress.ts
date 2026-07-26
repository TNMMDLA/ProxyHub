import type { SetupProgressResult, SetupProgressStep } from '@proxyhub/shared';
import { prisma } from './db.js';
import { getCachedReadiness } from './subscription-readiness.js';

let cached: { expiresAt: number; value: SetupProgressResult } | null = null;
const CACHE_TTL_MS = 5_000;

export function invalidateSetupProgress(): void {
  cached = null;
}

export async function getSetupProgress(): Promise<SetupProgressResult> {
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const [servers, nodes, pools, policies, ruleSets, subscriptions] = await Promise.all([
    prisma.server.count(),
    prisma.node.count({ where: { enabled: true } }),
    prisma.nodePool.count({
      where: { enabled: true, members: { some: { node: { enabled: true } } } },
    }),
    prisma.policy.count({ where: { enabled: true } }),
    prisma.ruleSet.count({ where: { enabled: true, status: { in: ['READY', 'STALE'] } } }),
    prisma.subscription.findMany({
      where: { enabled: true },
      select: { id: true },
      take: 100,
    }),
  ]);
  const anyReady = subscriptions.some((subscription) => {
    const readiness = getCachedReadiness(subscription.id);
    return readiness?.status === 'READY' || readiness?.status === 'READY_WITH_WARNINGS';
  });
  const status = (complete: boolean, blockedByPrevious = false): SetupProgressStep['status'] =>
    complete ? 'COMPLETED' : blockedByPrevious ? 'BLOCKED' : 'NOT_STARTED';
  const steps: SetupProgressStep[] = [
    {
      id: 'add-server',
      status: status(servers > 0),
      targetRoute: '/servers',
      blockingCodes: [],
    },
    {
      id: 'create-node',
      status: status(nodes > 0, servers === 0),
      targetRoute: '/nodes?create=1',
      blockingCodes: servers === 0 ? ['SERVER_REQUIRED'] : [],
    },
    {
      id: 'validate-reality',
      status: status(nodes > 0, nodes === 0),
      targetRoute: '/nodes?reality=1',
      blockingCodes: nodes === 0 ? ['NODE_REQUIRED'] : [],
    },
    {
      id: 'create-node-pool',
      status: status(pools > 0, nodes === 0),
      targetRoute: '/node-pools',
      blockingCodes: nodes === 0 ? ['NODE_REQUIRED'] : [],
    },
    {
      id: 'create-policy',
      status: status(policies > 0, pools === 0),
      targetRoute: '/policies',
      blockingCodes: pools === 0 ? ['NODE_POOL_REQUIRED'] : [],
    },
    {
      id: 'add-rule-set',
      status: ruleSets > 0 ? 'COMPLETED' : policies > 0 ? 'NOT_STARTED' : 'BLOCKED',
      targetRoute: '/rule-sets',
      blockingCodes: policies === 0 ? ['POLICY_REQUIRED'] : [],
    },
    {
      id: 'create-subscription',
      status: status(subscriptions.length > 0, policies === 0),
      targetRoute: '/subscriptions',
      blockingCodes: policies === 0 ? ['POLICY_REQUIRED'] : [],
    },
    {
      id: 'check-readiness',
      status: anyReady ? 'COMPLETED' : subscriptions.length > 0 ? 'IN_PROGRESS' : 'BLOCKED',
      targetRoute: '/subscriptions',
      blockingCodes: subscriptions.length === 0 ? ['SUBSCRIPTION_REQUIRED'] : [],
    },
    {
      id: 'import-client',
      status: anyReady ? 'IN_PROGRESS' : 'BLOCKED',
      targetRoute: '/subscriptions?guide=1',
      blockingCodes: anyReady ? [] : ['READINESS_REQUIRED'],
    },
  ];
  const completedSteps = steps.filter((step) => step.status === 'COMPLETED').length;
  const overallStatus =
    completedSteps === steps.length
      ? 'COMPLETED'
      : steps.some((step) => step.status === 'BLOCKED')
        ? completedSteps === 0
          ? 'NOT_STARTED'
          : 'BLOCKED'
        : 'IN_PROGRESS';
  const value: SetupProgressResult = {
    overallStatus,
    completedSteps,
    totalSteps: steps.length,
    steps,
    generatedAt: new Date().toISOString(),
  };
  cached = { expiresAt: Date.now() + CACHE_TTL_MS, value };
  return value;
}
