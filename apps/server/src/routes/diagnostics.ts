import type { FastifyPluginAsync } from 'fastify';
import { DiagnosticsError, diagnosticsReportSchema } from '@proxyhub/diagnostics-core';
import { requireRole } from '../auth/session.js';
import { audit } from '../audit.js';
import { AppError } from '../errors.js';
import type { DiagnosticsService } from '../diagnostics/service.js';

function translate(error: unknown): never {
  if (!(error instanceof DiagnosticsError)) throw error;
  const status =
    error.code === 'DIAGNOSTICS_SCAN_BUSY'
      ? 409
      : error.code === 'DIAGNOSTICS_SCAN_TIMEOUT'
        ? 504
        : error.code === 'DIAGNOSTICS_SCAN_CANCELLED'
          ? 499
          : 500;
  throw new AppError(error.code, error.message, status);
}

export const diagnosticsRoutes: FastifyPluginAsync<{ service: DiagnosticsService }> = async (
  app,
  { service },
) => {
  const auth = { preHandler: requireRole('ADMIN') };

  app.get('/overview', auth, async (request) => {
    const query = request.query as { refresh?: string };
    return { success: true, data: await service.overview(query.refresh === 'true') };
  });

  const sections = {
    '/runtime': 'RUNTIME',
    '/database': 'DATABASE',
    '/storage': 'STORAGE',
    '/network': 'NETWORK',
    '/operations': 'OPERATIONS',
    '/rule-sets': 'RULE_SET',
    '/subscriptions': 'SUBSCRIPTION',
    '/security': 'SECURITY',
  } as const;
  for (const [path, category] of Object.entries(sections)) {
    app.get(path, auth, async () => ({ success: true, data: await service.section(category) }));
  }

  app.post(
    '/run',
    { ...auth, config: { rateLimit: { max: 3, timeWindow: '1 minute' } } },
    async (request) => {
      const controller = new AbortController();
      const cancel = () => controller.abort();
      request.raw.once('aborted', cancel);
      try {
        const data = diagnosticsReportSchema.parse(await service.deep(controller.signal));
        await audit(request, 'DIAGNOSTICS_DEEP_SCAN', 'Diagnostics', 'SUCCESS', undefined, {
          status: data.status,
          durationMs: data.durationMs,
          itemCount: data.items.length,
        });
        return { success: true, data };
      } catch (error) {
        await audit(request, 'DIAGNOSTICS_DEEP_SCAN', 'Diagnostics', 'FAILURE', undefined, {
          code: error instanceof DiagnosticsError ? error.code : 'DIAGNOSTICS_SCAN_FAILED',
        }).catch(() => undefined);
        return translate(error);
      } finally {
        request.raw.off('aborted', cancel);
      }
    },
  );

  app.get(
    '/export',
    { ...auth, config: { rateLimit: { max: 5, timeWindow: '1 minute' } } },
    async (request, reply) => {
      try {
        const exported = await service.export();
        await audit(request, 'DIAGNOSTICS_EXPORTED', 'Diagnostics', 'SUCCESS', undefined, {
          itemCount: exported.report.items.length,
        });
        return reply
          .header('content-type', 'application/json; charset=utf-8')
          .header('content-disposition', `attachment; filename="${exported.filename}"`)
          .send({ success: true, data: exported.report });
      } catch (error) {
        await audit(request, 'DIAGNOSTICS_EXPORTED', 'Diagnostics', 'FAILURE').catch(
          () => undefined,
        );
        return translate(error);
      }
    },
  );
};
