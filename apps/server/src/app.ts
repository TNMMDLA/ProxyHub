import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import Fastify from 'fastify';
import type { FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import { authRoutes } from './routes/auth.js';
import { nodeRoutes } from './routes/nodes.js';
import { poolRoutes } from './routes/pools.js';
import { operationRoutes } from './routes/operations.js';
import { policyRoutes } from './routes/policies.js';
import { publicSubscriptionRoutes, subscriptionRoutes } from './routes/subscriptions.js';
import { ruleSetRoutes } from './routes/rule-sets.js';
import { config } from './config.js';
import { AppError } from './errors.js';
import { defaultAgentClient, type AgentClient } from './agent-client.js';
import { getBuildMetadata } from './release/build-metadata.js';
import { diagnosticsRoutes } from './routes/diagnostics.js';
import { DiagnosticsService } from './diagnostics/service.js';
import { prisma } from './db.js';

export function redactRequestUrl(url: string | undefined): string | undefined {
  return url?.replace(/(\/sub\/)[^/?#]+/g, '$1[REDACTED]');
}

export async function buildApp(options: { agentClient?: AgentClient; logFile?: string } = {}) {
  const agentClient = options.agentClient ?? defaultAgentClient;
  const app = Fastify({
    logger: {
      level: options.logFile ? 'info' : config.NODE_ENV === 'test' ? 'silent' : 'info',
      ...(options.logFile ? { file: options.logFile } : {}),
      redact: [
        'req.headers.authorization',
        'req.headers.cookie',
        'body.password',
        'body.totp',
        'body.token',
      ],
      serializers: {
        req: (incoming: FastifyRequest) => ({
          method: incoming.method,
          url: redactRequestUrl(incoming.url) ?? '',
        }),
      },
    },
    trustProxy: config.TRUST_PROXY,
  });
  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(cookie);
  await app.register(cors, { origin: config.WEB_ORIGIN, credentials: true });
  await app.register(rateLimit, { max: 120, timeWindow: '1 minute' });

  app.setNotFoundHandler((_request, reply) =>
    reply
      .code(404)
      .send({ success: false, error: { code: 'NOT_FOUND', message: 'Resource not found' } }),
  );
  app.setErrorHandler((error, request, reply) => {
    const validationError = error as { name?: unknown; issues?: unknown };
    if (
      error instanceof ZodError ||
      (validationError.name === 'ZodError' && Array.isArray(validationError.issues))
    ) {
      const issues = validationError.issues;
      return reply.code(422).send({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: 'The request is invalid', details: issues },
      });
    }
    if (error instanceof AppError)
      return reply.code(error.statusCode).send({
        success: false,
        error: { code: error.code, message: error.message, details: error.details },
      });
    if ((error as { code?: string }).code === 'P2002')
      return reply.code(409).send({
        success: false,
        error: { code: 'CONFLICT', message: 'A record with these values already exists' },
      });
    if ((error as { statusCode?: number }).statusCode === 429)
      return reply.code(429).send({
        success: false,
        error: { code: 'RATE_LIMITED', message: 'Too many requests; try again later' },
      });
    request.log.error(error);
    return reply.code(500).send({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' },
    });
  });

  app.get('/api/health', async () => ({
    success: true,
    data: { status: 'ok', ...(await getBuildMetadata()) },
  }));
  await app.register(authRoutes, { prefix: '/api/auth' });
  await app.register(nodeRoutes, { prefix: '/api/nodes', agentClient });
  await app.register(poolRoutes, { prefix: '/api/node-pools' });
  await app.register(policyRoutes, { prefix: '/api/policies' });
  await app.register(ruleSetRoutes, { prefix: '/api/rule-sets' });
  await app.register(subscriptionRoutes, { prefix: '/api/subscriptions' });
  await app.register(publicSubscriptionRoutes, { prefix: '/sub' });
  await app.register(operationRoutes, { prefix: '/api', agentClient });
  await app.register(diagnosticsRoutes, {
    prefix: '/api/diagnostics',
    service: new DiagnosticsService(prisma, agentClient, config),
  });
  return app;
}
