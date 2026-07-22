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
    if (!(await prisma.nodePool.findUnique({ where: { id } })))
      throw new AppError('POOL_NOT_FOUND', 'Node pool not found', 404);
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
    return { success: true, data: pool };
  });

  app.delete('/:id', { preHandler: requireRole('ADMIN', 'OPERATOR') }, async (request) => {
    const id = (request.params as { id: string }).id;
    await prisma.nodePool.delete({ where: { id } });
    await audit(request, 'NODE_POOL_DELETE', 'NodePool', 'SUCCESS', id);
    return { success: true, data: null };
  });
};
