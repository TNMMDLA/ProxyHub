import type { FastifyPluginAsync } from 'fastify';
import { resourceTypeSchema } from '@proxyhub/shared';
import { z } from 'zod';
import { requireRole } from '../auth/session.js';
import { getDeleteImpact, getResourceDependencies } from '../resource-dependencies.js';

const resourceParamsSchema = z.object({
  type: z.string().trim().min(1).max(32),
  id: z.string().trim().min(1).max(80),
});

function paramsOf(params: unknown) {
  const value = resourceParamsSchema.parse(params);
  return { type: resourceTypeSchema.parse(value.type.toUpperCase()), id: value.id };
}

export const resourceRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    '/:type/:id/dependencies',
    { preHandler: requireRole('ADMIN', 'OPERATOR', 'VIEWER') },
    async (request) => {
      const { type, id } = paramsOf(request.params);
      return { success: true, data: await getResourceDependencies(type, id) };
    },
  );

  app.get(
    '/:type/:id/delete-impact',
    { preHandler: requireRole('ADMIN', 'OPERATOR', 'VIEWER') },
    async (request) => {
      const { type, id } = paramsOf(request.params);
      return { success: true, data: await getDeleteImpact(type, id) };
    },
  );
};
