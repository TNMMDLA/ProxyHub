import type {
  DeleteImpactResult,
  DependencyRelationCode,
  ResourceDependencyResult,
  ResourceReference,
  ResourceType,
} from '@proxyhub/shared';
import type { FastifyRequest } from 'fastify';
import { audit } from './audit.js';
import { prisma } from './db.js';
import { AppError } from './errors.js';

const MAX_DEPENDENCIES = 100;

function reference(
  resourceType: ResourceReference['resourceType'],
  resourceId: string,
  name: string,
  relation: DependencyRelationCode,
  direct = true,
): ResourceReference {
  return { resourceType, resourceId, name, relation, direct };
}

function bounded(
  resourceType: ResourceType,
  resourceId: string,
  usedBy: ResourceReference[],
): ResourceDependencyResult {
  const unique = usedBy.filter(
    (item, index, all) =>
      all.findIndex(
        (candidate) =>
          candidate.resourceType === item.resourceType &&
          candidate.resourceId === item.resourceId &&
          candidate.relation === item.relation,
      ) === index,
  );
  return {
    resourceType,
    resourceId,
    usedBy: unique.slice(0, MAX_DEPENDENCIES),
    truncated: unique.length > MAX_DEPENDENCIES,
  };
}

export async function getResourceDependencies(
  resourceType: ResourceType,
  resourceId: string,
): Promise<ResourceDependencyResult> {
  if (resourceType === 'SERVER') {
    const server = await prisma.server.findUnique({
      where: { id: resourceId },
      select: {
        id: true,
        nodes: {
          select: {
            id: true,
            name: true,
            pools: {
              select: {
                nodePool: {
                  select: {
                    id: true,
                    name: true,
                    defaultPolicies: { select: { id: true, name: true } },
                    policyRules: {
                      select: { policy: { select: { id: true, name: true } } },
                    },
                  },
                },
              },
            },
          },
        },
      },
    });
    if (!server) throw new AppError('SERVER_NOT_FOUND', 'Server not found', 404);
    const usedBy: ResourceReference[] = [];
    for (const node of server.nodes) {
      usedBy.push(reference('NODE', node.id, node.name, 'SERVER_HAS_NODE'));
      for (const membership of node.pools) {
        const pool = membership.nodePool;
        usedBy.push(reference('NODE_POOL', pool.id, pool.name, 'NODE_IN_NODE_POOL', false));
        for (const policy of pool.defaultPolicies) {
          usedBy.push(
            reference('POLICY', policy.id, policy.name, 'NODE_POOL_USED_BY_POLICY', false),
          );
        }
        for (const rule of pool.policyRules) {
          usedBy.push(
            reference(
              'POLICY',
              rule.policy.id,
              rule.policy.name,
              'NODE_POOL_USED_BY_POLICY',
              false,
            ),
          );
        }
      }
    }
    return bounded(resourceType, resourceId, usedBy);
  }

  if (resourceType === 'NODE') {
    const node = await prisma.node.findUnique({
      where: { id: resourceId },
      select: {
        id: true,
        pools: {
          select: {
            nodePool: {
              select: {
                id: true,
                name: true,
                defaultPolicies: { select: { id: true, name: true } },
                policyRules: { select: { policy: { select: { id: true, name: true } } } },
              },
            },
          },
        },
        userAccesses: {
          where: { revokedAt: null, user: { deletedAt: null } },
          select: { user: { select: { id: true, name: true } } },
        },
      },
    });
    if (!node) throw new AppError('NODE_NOT_FOUND', 'Node not found', 404);
    const usedBy: ResourceReference[] = [];
    for (const membership of node.pools) {
      const pool = membership.nodePool;
      usedBy.push(reference('NODE_POOL', pool.id, pool.name, 'NODE_IN_NODE_POOL'));
      for (const policy of pool.defaultPolicies) {
        usedBy.push(reference('POLICY', policy.id, policy.name, 'NODE_POOL_USED_BY_POLICY', false));
      }
      for (const rule of pool.policyRules) {
        usedBy.push(
          reference('POLICY', rule.policy.id, rule.policy.name, 'NODE_POOL_USED_BY_POLICY', false),
        );
      }
    }
    for (const access of node.userAccesses) {
      usedBy.push(reference('USER', access.user.id, access.user.name, 'NODE_AUTHORIZED_TO_USER'));
    }
    return bounded(resourceType, resourceId, usedBy);
  }

  if (resourceType === 'NODE_POOL') {
    const pool = await prisma.nodePool.findUnique({
      where: { id: resourceId },
      select: {
        id: true,
        defaultPolicies: { select: { id: true, name: true } },
        policyRules: { select: { policy: { select: { id: true, name: true } } } },
      },
    });
    if (!pool) throw new AppError('POOL_NOT_FOUND', 'Node pool not found', 404);
    return bounded(resourceType, resourceId, [
      ...pool.defaultPolicies.map((policy) =>
        reference('POLICY', policy.id, policy.name, 'NODE_POOL_USED_BY_POLICY'),
      ),
      ...pool.policyRules.map(({ policy }) =>
        reference('POLICY', policy.id, policy.name, 'NODE_POOL_USED_BY_POLICY'),
      ),
    ]);
  }

  if (resourceType === 'RULE_SET') {
    const ruleSet = await prisma.ruleSet.findUnique({
      where: { id: resourceId },
      select: {
        id: true,
        policyRules: { select: { policy: { select: { id: true, name: true } } } },
      },
    });
    if (!ruleSet) throw new AppError('RULE_SET_NOT_FOUND', 'Rule set not found', 404);
    return bounded(
      resourceType,
      resourceId,
      ruleSet.policyRules.map(({ policy }) =>
        reference('POLICY', policy.id, policy.name, 'RULE_SET_USED_BY_POLICY'),
      ),
    );
  }

  if (resourceType === 'POLICY') {
    const policy = await prisma.policy.findUnique({
      where: { id: resourceId },
      select: { id: true, subscriptions: { select: { id: true, name: true } } },
    });
    if (!policy) throw new AppError('POLICY_NOT_FOUND', 'Policy not found', 404);
    return bounded(
      resourceType,
      resourceId,
      policy.subscriptions.map((subscription) =>
        reference(
          'SUBSCRIPTION',
          subscription.id,
          subscription.name,
          'POLICY_USED_BY_SUBSCRIPTION',
        ),
      ),
    );
  }

  if (resourceType === 'USER') {
    const user = await prisma.user.findFirst({
      where: { id: resourceId, deletedAt: null },
      select: {
        id: true,
        accesses: {
          where: { revokedAt: null },
          select: { node: { select: { id: true, name: true } } },
        },
      },
    });
    if (!user) throw new AppError('USER_NOT_FOUND', 'User not found', 404);
    return bounded(
      resourceType,
      resourceId,
      user.accesses.map(({ node }) =>
        reference('NODE', node.id, node.name, 'NODE_AUTHORIZED_TO_USER'),
      ),
    );
  }

  const subscription = await prisma.subscription.findUnique({
    where: { id: resourceId },
    select: { id: true },
  });
  if (!subscription) throw new AppError('SUBSCRIPTION_NOT_FOUND', 'Subscription not found', 404);
  return bounded(resourceType, resourceId, []);
}

export async function getDeleteImpact(
  resourceType: ResourceType,
  resourceId: string,
): Promise<DeleteImpactResult> {
  const dependencies = await getResourceDependencies(resourceType, resourceId);
  const impacts: DeleteImpactResult['impacts'] = [];

  if (resourceType === 'NODE') {
    const memberships = await prisma.nodePoolMember.findMany({
      where: { nodeId: resourceId },
      select: {
        nodePool: {
          select: { id: true, name: true, _count: { select: { members: true } } },
        },
      },
    });
    for (const { nodePool } of memberships) {
      impacts.push({
        code:
          nodePool._count.members <= 1
            ? 'NODE_POOL_WOULD_BE_EMPTY'
            : 'NODE_POOL_MEMBERSHIP_REMOVED',
        severity: nodePool._count.members <= 1 ? 'BLOCKING' : 'WARNING',
        resourceType: 'NODE_POOL',
        resourceId: nodePool.id,
        name: nodePool.name,
      });
    }
    for (const item of dependencies.usedBy.filter(
      (dependency) => dependency.relation === 'NODE_AUTHORIZED_TO_USER',
    )) {
      impacts.push({
        code: 'NODE_HAS_USER_ACCESS',
        severity: 'BLOCKING',
        resourceType: item.resourceType,
        resourceId: item.resourceId,
        name: item.name,
      });
    }
  } else if (resourceType === 'SERVER') {
    for (const item of dependencies.usedBy) {
      impacts.push({
        code: 'SERVER_HAS_NODES',
        severity: 'BLOCKING',
        resourceType: item.resourceType,
        resourceId: item.resourceId,
        name: item.name,
      });
    }
  } else if (resourceType === 'NODE_POOL') {
    for (const item of dependencies.usedBy) {
      impacts.push({
        code: 'POLICY_WOULD_LOSE_NODE_POOL',
        severity: 'BLOCKING',
        resourceType: item.resourceType,
        resourceId: item.resourceId,
        name: item.name,
      });
    }
  } else if (resourceType === 'POLICY') {
    for (const item of dependencies.usedBy) {
      impacts.push({
        code: 'SUBSCRIPTION_WOULD_LOSE_POLICY',
        severity: 'BLOCKING',
        resourceType: item.resourceType,
        resourceId: item.resourceId,
        name: item.name,
      });
    }
  } else if (resourceType === 'RULE_SET') {
    for (const item of dependencies.usedBy) {
      impacts.push({
        code: 'POLICY_WOULD_LOSE_RULE_SET',
        severity: 'BLOCKING',
        resourceType: item.resourceType,
        resourceId: item.resourceId,
        name: item.name,
      });
    }
  }

  const status = impacts.some((impact) => impact.severity === 'BLOCKING')
    ? 'BLOCKED'
    : impacts.length > 0
      ? 'WARNING'
      : 'SAFE';
  return {
    ...dependencies,
    status,
    codes: [...new Set(impacts.map((impact) => impact.code))],
    impacts,
  };
}

export async function assertDeleteAllowed(
  resourceType: ResourceType,
  resourceId: string,
  request?: FastifyRequest,
): Promise<DeleteImpactResult> {
  const impact = await getDeleteImpact(resourceType, resourceId);
  if (impact.status === 'BLOCKED') {
    if (request) {
      await audit(request, 'DELETE_BLOCKED_BY_DEPENDENCY', resourceType, 'FAILURE', resourceId, {
        codes: impact.codes,
      });
    }
    throw new AppError(
      'DELETE_BLOCKED_BY_DEPENDENCY',
      'Delete is blocked by resource dependencies',
      409,
      impact,
    );
  }
  return impact;
}
