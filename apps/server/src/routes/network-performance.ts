import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit.js';
import { requireRole } from '../auth/session.js';
import { auditContext, type NetworkPerformanceService } from '../network-performance/service.js';

const identifiers = z.object({
  id: z.string().cuid(),
  runId: z.string().cuid().optional(),
});

export const networkPerformanceRoutes: FastifyPluginAsync<{
  service: NetworkPerformanceService;
}> = async (app, { service }) => {
  app.get(
    '/performance-tests/capability',
    { preHandler: requireRole('ADMIN', 'OPERATOR', 'VIEWER') },
    async () => ({ success: true, data: await service.capability() }),
  );

  app.post(
    '/:id/performance-tests',
    {
      preHandler: requireRole('ADMIN', 'OPERATOR'),
      config: { rateLimit: { max: 6, timeWindow: '1 hour' } },
    },
    async (request, reply) => {
      const { id } = identifiers.parse(request.params);
      const run = await service.start(id, auditContext(request));
      await audit(request, 'NETWORK_PERFORMANCE_TEST_STARTED', 'Node', 'SUCCESS', id, {
        nodeId: id,
        status: run.status,
        runId: run.id,
      });
      return reply.code(202).send({ success: true, data: run });
    },
  );

  app.get(
    '/:id/performance-tests/:runId',
    { preHandler: requireRole('ADMIN', 'OPERATOR', 'VIEWER') },
    async (request) => {
      const { id, runId } = identifiers.parse(request.params);
      return { success: true, data: await service.get(id, runId!) };
    },
  );

  app.post(
    '/:id/performance-tests/:runId/cancel',
    {
      preHandler: requireRole('ADMIN', 'OPERATOR'),
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    },
    async (request) => {
      const { id, runId } = identifiers.parse(request.params);
      await service.cancel(id, runId!);
      return { success: true, data: { cancellationRequested: true } };
    },
  );

  app.get(
    '/:id/performance-tests',
    { preHandler: requireRole('ADMIN', 'OPERATOR', 'VIEWER') },
    async (request) => {
      const { id } = identifiers.parse(request.params);
      return { success: true, data: await service.history(id) };
    },
  );
};
