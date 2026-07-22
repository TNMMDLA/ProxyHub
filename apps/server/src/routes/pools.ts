import type { FastifyPluginAsync } from 'fastify';
import { createPoolSchema } from '@proxyhub/shared';
import { audit } from '../audit.js';
import { requireRole } from '../auth/session.js';
import { prisma } from '../db.js';
import { AppError } from '../errors.js';

const include = {
  members: {
    include: {
      node: { select: { id: true, name: true, status: true, enabled: true, latency: true } },
    },
  },
} as const;

export const poolRoutes: FastifyPluginAsync = async (app) => {
  app.get('/', { preHandler: requireRole('ADMIN', 'OPERATOR', 'VIEWER') }, async () => ({
    success: true,
    data: await prisma.nodePool.findMany({ include, orderBy: { createdAt: 'desc' } }),
  }));

  app.post('/', { preHandler: requireRole('ADMIN', 'OPERATOR') }, async (request, reply) => {
    const input = createPoolSchema.parse(request.body);
    const pool = await prisma.nodePool.create({
      data: {
        name: input.name,
        description: input.description,
        region: input.region,
        strategy: input.strategy,
        enabled: input.enabled,
        members: { create: input.nodeIds.map((nodeId, priority) => ({ nodeId, priority })) },
      },
      include,
    });
    await audit(request, 'NODE_POOL_CREATE', 'NodePool', 'SUCCESS', pool.id);
    return reply.code(201).send({ success: true, data: pool });
  });

  app.put('/:id', { preHandler: requireRole('ADMIN', 'OPERATOR') }, async (request) => {
    const id = (request.params as { id: string }).id;
    const input = createPoolSchema.parse(request.body);
    const existing = await prisma.nodePool.findUnique({
      where: { id },
      include: {
        ...include,
        defaultPolicies: { select: { id: true, name: true } },
        policyRules: { select: { policy: { select: { id: true, name: true } } } },
      },
    });
    if (!existing) throw new AppError('POOL_NOT_FOUND', 'Node pool not found', 404);
    const pool = await prisma.$transaction(async (tx) => {
      await tx.nodePoolMember.deleteMany({ where: { nodePoolId: id } });
      return tx.nodePool.update({
        where: { id },
        data: {
          name: input.name,
          description: input.description,
          region: input.region,
          strategy: input.strategy,
          enabled: input.enabled,
          members: { create: input.nodeIds.map((nodeId, priority) => ({ nodeId, priority })) },
        },
        include,
      });
    });
    await audit(request, 'NODE_POOL_UPDATE', 'NodePool', 'SUCCESS', id);
    const wasAvailable = existing.enabled && existing.members.some((member) => member.node.enabled);
    const isAvailable = pool.enabled && pool.members.some((member) => member.node.enabled);
    if (wasAvailable && !isAvailable) {
      const policies = [
        ...existing.defaultPolicies,
        ...existing.policyRules.map((rule) => rule.policy),
      ].filter((policy, index, all) => all.findIndex((item) => item.id === policy.id) === index);
      if (policies.length) {
        await prisma.notification.create({
          data: {
            level: 'WARNING',
            title: 'Referenced node pool unavailable',
            message: `${pool.name} no longer has enabled nodes for ${String(policies.length)} referenced polic${policies.length === 1 ? 'y' : 'ies'}.`,
            eventType: 'NODE_POOL_REFERENCED_UNAVAILABLE',
          },
        });
      }
    }
    return { success: true, data: pool };
  });

  app.delete('/:id', { preHandler: requireRole('ADMIN', 'OPERATOR') }, async (request) => {
    const id = (request.params as { id: string }).id;
    const references = await prisma.nodePool.findUnique({
      where: { id },
      include: {
        defaultPolicies: { select: { id: true, name: true } },
        policyRules: { select: { policy: { select: { id: true, name: true } } } },
      },
    });
    if (!references) throw new AppError('POOL_NOT_FOUND', 'Node pool not found', 404);
    const policies = [
      ...references.defaultPolicies,
      ...references.policyRules.map((rule) => rule.policy),
    ].filter((policy, index, all) => all.findIndex((item) => item.id === policy.id) === index);
    if (policies.length) {
      throw new AppError('NODE_POOL_IN_USE', 'Node pool is referenced by policies', 409, {
        policies,
      });
    }
    await prisma.nodePool.delete({ where: { id } });
    await audit(request, 'NODE_POOL_DELETE', 'NodePool', 'SUCCESS', id);
    return { success: true, data: null };
  });
};
