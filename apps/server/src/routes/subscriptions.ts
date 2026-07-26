import { createHash } from 'node:crypto';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import {
  createSubscriptionSchema,
  subscriptionPreviewSchema,
  subscriptionReadinessInputSchema,
  updateSubscriptionSchema,
} from '@proxyhub/shared';
import type { CompilerFormat } from '@proxyhub/policy-core';
import { audit } from '../audit.js';
import { requireRole } from '../auth/session.js';
import { prisma } from '../db.js';
import { AppError } from '../errors.js';
import { compileStoredPolicy } from '../policy-service.js';
import { hashToken, newOpaqueToken } from '../security/crypto.js';
import {
  invalidateReadiness,
  runSubscriptionReadiness,
  type SubscriptionCandidate,
} from '../subscription-readiness.js';
import {
  contentTypeFor,
  generateSubscriptionPreview,
  subscriptionCapabilities,
  testSubscriptionResponse,
} from '../subscription-delivery.js';
import { assertDeleteAllowed } from '../resource-dependencies.js';
import { invalidateSetupProgress } from '../setup-progress.js';

const subscriptionSelect = {
  id: true,
  name: true,
  enabled: true,
  policyId: true,
  format: true,
  tokenPrefix: true,
  expiresAt: true,
  lastAccessAt: true,
  createdAt: true,
  updatedAt: true,
  policy: { select: { id: true, name: true, enabled: true, revision: true } },
} as const;

function idFrom(request: FastifyRequest): string {
  return (request.params as { id: string }).id;
}

async function assertPolicy(policyId: string): Promise<void> {
  if (!(await prisma.policy.findUnique({ where: { id: policyId }, select: { id: true } }))) {
    throw new AppError('POLICY_NOT_FOUND', 'Policy not found', 404);
  }
}

function issueSubscriptionToken(): { token: string; tokenHash: string; tokenPrefix: string } {
  const token = newOpaqueToken(32);
  return { token, tokenHash: hashToken(token), tokenPrefix: token.slice(0, 8) };
}

async function compileSubscription(policyId: string, format: CompilerFormat) {
  const compiled = await compileStoredPolicy(policyId, format);
  if (!compiled.result.success) {
    throw new AppError(
      'SUBSCRIPTION_COMPILE_FAILED',
      'Subscription policy could not be compiled',
      422,
      compiled.result.errors,
    );
  }
  return compiled;
}

function candidateFrom(value: {
  id?: string;
  policyId: string;
  format: string;
  enabled: boolean;
  expiresAt: Date | string | null;
}): SubscriptionCandidate {
  return {
    ...(value.id ? { id: value.id } : {}),
    policyId: value.policyId,
    format: value.format as CompilerFormat,
    enabled: value.enabled,
    expiresAt: value.expiresAt,
  };
}

async function assertPreflight(candidate: SubscriptionCandidate) {
  const readiness = await runSubscriptionReadiness(candidate, { cache: false });
  const lifecycleOnly = readiness.checks
    .filter((item) => item.blocking && item.status === 'FAILED')
    .every((item) =>
      ['SUBSCRIPTION_DISABLED', 'SUBSCRIPTION_EXPIRED'].includes(item.errorCode ?? ''),
    );
  if (readiness.status === 'BLOCKED' && !lifecycleOnly) {
    throw new AppError(
      'SUBSCRIPTION_NOT_READY',
      'Subscription dependencies are not ready',
      422,
      readiness,
    );
  }
  return readiness;
}

export const subscriptionRoutes: FastifyPluginAsync = async (app) => {
  app.get('/', { preHandler: requireRole('ADMIN', 'OPERATOR', 'VIEWER') }, async () => ({
    success: true,
    data: await prisma.subscription.findMany({
      select: subscriptionSelect,
      orderBy: { createdAt: 'desc' },
    }),
  }));

  app.get(
    '/capabilities',
    { preHandler: requireRole('ADMIN', 'OPERATOR', 'VIEWER') },
    async () => ({ success: true, data: subscriptionCapabilities() }),
  );

  app.post('/readiness', { preHandler: requireRole('ADMIN', 'OPERATOR') }, async (request) => {
    const input = subscriptionReadinessInputSchema.parse(request.body);
    if (!input.policyId || !input.format) {
      throw new AppError('VALIDATION_ERROR', 'Policy and format are required for readiness', 422);
    }
    const readiness = await runSubscriptionReadiness(
      candidateFrom({
        policyId: input.policyId,
        format: input.format,
        enabled: input.enabled ?? true,
        expiresAt: input.expiresAt ?? null,
      }),
    );
    await audit(
      request,
      'SUBSCRIPTION_READINESS_TESTED',
      'Subscription',
      readiness.status === 'BLOCKED' ? 'FAILURE' : 'SUCCESS',
      undefined,
      {
        status: readiness.status,
        format: readiness.format,
      },
    );
    return { success: true, data: readiness };
  });

  app.post('/', { preHandler: requireRole('ADMIN', 'OPERATOR') }, async (request, reply) => {
    const input = createSubscriptionSchema.parse(request.body);
    await assertPolicy(input.policyId);
    const readiness = await assertPreflight(candidateFrom(input));
    const issued = issueSubscriptionToken();
    const subscription = await prisma.subscription.create({
      data: {
        name: input.name,
        enabled: input.enabled,
        policyId: input.policyId,
        format: input.format,
        expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
        tokenHash: issued.tokenHash,
        tokenPrefix: issued.tokenPrefix,
      },
      select: subscriptionSelect,
    });
    await audit(request, 'SUBSCRIPTION_CREATED', 'Subscription', 'SUCCESS', subscription.id, {
      name: subscription.name,
      format: subscription.format,
      tokenPrefix: subscription.tokenPrefix,
    });
    invalidateReadiness(subscription.id);
    invalidateSetupProgress();
    return reply.code(201).send({
      success: true,
      data: { subscription, token: issued.token, path: `/sub/${issued.token}`, readiness },
    });
  });

  app.get('/:id', { preHandler: requireRole('ADMIN', 'OPERATOR', 'VIEWER') }, async (request) => {
    const subscription = await prisma.subscription.findUnique({
      where: { id: idFrom(request) },
      select: subscriptionSelect,
    });
    if (!subscription) throw new AppError('SUBSCRIPTION_NOT_FOUND', 'Subscription not found', 404);
    return { success: true, data: subscription };
  });

  app.patch('/:id', { preHandler: requireRole('ADMIN', 'OPERATOR') }, async (request) => {
    const id = idFrom(request);
    const patch = updateSubscriptionSchema.parse(request.body);
    const current = await prisma.subscription.findUnique({ where: { id } });
    if (!current) throw new AppError('SUBSCRIPTION_NOT_FOUND', 'Subscription not found', 404);
    if (patch.policyId) await assertPolicy(patch.policyId);
    const candidate = candidateFrom({
      id,
      policyId: patch.policyId ?? current.policyId,
      format: patch.format ?? current.format,
      enabled: patch.enabled ?? current.enabled,
      expiresAt: patch.expiresAt === undefined ? current.expiresAt : patch.expiresAt,
    });
    const readiness = await assertPreflight(candidate);
    const subscription = await prisma.subscription.update({
      where: { id },
      data: {
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
        ...(patch.policyId !== undefined ? { policyId: patch.policyId } : {}),
        ...(patch.format !== undefined ? { format: patch.format } : {}),
        ...(patch.expiresAt !== undefined
          ? { expiresAt: patch.expiresAt ? new Date(patch.expiresAt) : null }
          : {}),
      },
      select: subscriptionSelect,
    });
    const action =
      patch.enabled === undefined
        ? 'SUBSCRIPTION_UPDATED'
        : patch.enabled
          ? 'SUBSCRIPTION_ENABLED'
          : 'SUBSCRIPTION_DISABLED';
    await audit(request, action, 'Subscription', 'SUCCESS', id, {
      fields: Object.keys(patch),
      tokenPrefix: current.tokenPrefix,
    });
    invalidateReadiness(id);
    invalidateSetupProgress();
    return { success: true, data: { ...subscription, readiness } };
  });

  app.post(
    '/:id/rotate-token',
    { preHandler: requireRole('ADMIN', 'OPERATOR') },
    async (request) => {
      const id = idFrom(request);
      const current = await prisma.subscription.findUnique({ where: { id } });
      if (!current) throw new AppError('SUBSCRIPTION_NOT_FOUND', 'Subscription not found', 404);
      const issued = issueSubscriptionToken();
      const subscription = await prisma.subscription.update({
        where: { id },
        data: { tokenHash: issued.tokenHash, tokenPrefix: issued.tokenPrefix },
        select: subscriptionSelect,
      });
      await audit(request, 'SUBSCRIPTION_TOKEN_ROTATED', 'Subscription', 'SUCCESS', id, {
        oldTokenPrefix: current.tokenPrefix,
        tokenPrefix: issued.tokenPrefix,
      });
      return {
        success: true,
        data: { subscription, token: issued.token, path: `/sub/${issued.token}` },
      };
    },
  );

  app.post('/:id/readiness', { preHandler: requireRole('ADMIN', 'OPERATOR') }, async (request) => {
    const id = idFrom(request);
    const subscription = await prisma.subscription.findUnique({ where: { id } });
    if (!subscription) throw new AppError('SUBSCRIPTION_NOT_FOUND', 'Subscription not found', 404);
    const readiness = await runSubscriptionReadiness(candidateFrom(subscription), {
      cache: true,
    });
    await audit(
      request,
      'SUBSCRIPTION_READINESS_TESTED',
      'Subscription',
      readiness.status === 'BLOCKED' ? 'FAILURE' : 'SUCCESS',
      id,
      {
        status: readiness.status,
        format: readiness.format,
      },
    );
    invalidateSetupProgress();
    return { success: true, data: readiness };
  });

  app.post(
    '/:id/preview',
    {
      preHandler: requireRole('ADMIN', 'OPERATOR'),
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    },
    async (request) => {
      const subscription = await prisma.subscription.findUnique({ where: { id: idFrom(request) } });
      if (!subscription)
        throw new AppError('SUBSCRIPTION_NOT_FOUND', 'Subscription not found', 404);
      const { format } = subscriptionPreviewSchema.parse(request.body ?? {});
      const preview = await generateSubscriptionPreview(candidateFrom(subscription), format);
      await audit(
        request,
        'SUBSCRIPTION_PREVIEW_GENERATED',
        'Subscription',
        'SUCCESS',
        subscription.id,
        {
          format: preview.format,
          truncated: preview.truncated,
        },
      );
      return { success: true, data: preview };
    },
  );

  app.post(
    '/:id/test-response',
    {
      preHandler: requireRole('ADMIN', 'OPERATOR'),
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    },
    async (request) => {
      const subscription = await prisma.subscription.findUnique({ where: { id: idFrom(request) } });
      if (!subscription)
        throw new AppError('SUBSCRIPTION_NOT_FOUND', 'Subscription not found', 404);
      const responseTest = await testSubscriptionResponse(candidateFrom(subscription));
      await audit(
        request,
        'SUBSCRIPTION_RESPONSE_TESTED',
        'Subscription',
        responseTest.accessible ? 'SUCCESS' : 'FAILURE',
        subscription.id,
        {
          statusCode: responseTest.statusCode,
          accessible: responseTest.accessible,
        },
      );
      return { success: true, data: responseTest };
    },
  );

  app.delete('/:id', { preHandler: requireRole('ADMIN', 'OPERATOR') }, async (request) => {
    const id = idFrom(request);
    const subscription = await prisma.subscription.findUnique({ where: { id } });
    if (!subscription) throw new AppError('SUBSCRIPTION_NOT_FOUND', 'Subscription not found', 404);
    await assertDeleteAllowed('SUBSCRIPTION', id, request);
    await prisma.subscription.delete({ where: { id } });
    await audit(request, 'SUBSCRIPTION_DELETED', 'Subscription', 'SUCCESS', id, {
      name: subscription.name,
      tokenPrefix: subscription.tokenPrefix,
    });
    invalidateReadiness(id);
    invalidateSetupProgress();
    return { success: true, data: null };
  });
};

export const publicSubscriptionRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    '/:token',
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const token = (request.params as { token: string }).token;
      const subscription = await prisma.subscription.findUnique({
        where: { tokenHash: hashToken(token) },
      });
      if (!subscription) {
        throw new AppError('SUBSCRIPTION_TOKEN_INVALID', 'Subscription token is invalid', 404);
      }
      if (!subscription.enabled) {
        throw new AppError('SUBSCRIPTION_DISABLED', 'Subscription is disabled', 403);
      }
      if (subscription.expiresAt && subscription.expiresAt <= new Date()) {
        throw new AppError('SUBSCRIPTION_EXPIRED', 'Subscription has expired', 410);
      }
      let compiled;
      try {
        compiled = await compileSubscription(
          subscription.policyId,
          subscription.format as CompilerFormat,
        );
      } catch {
        await prisma.notification.create({
          data: {
            level: 'CRITICAL',
            title: 'Subscription compile failed',
            message: `${subscription.name} could not be served because its policy is invalid.`,
            eventType: 'SUBSCRIPTION_COMPILE_FAILED',
          },
        });
        throw new AppError(
          'SUBSCRIPTION_COMPILE_FAILED',
          'Subscription content is temporarily unavailable',
          422,
        );
      }
      const output = compiled.result.output;
      const etag = `"${createHash('sha256').update(output).digest('hex')}"`;
      const contentType = contentTypeFor(subscription.format as CompilerFormat);
      reply.type(contentType).header('cache-control', 'private, no-store').header('etag', etag);
      await prisma.subscription.update({
        where: { id: subscription.id },
        data: { lastAccessAt: new Date() },
      });
      if (request.headers['if-none-match'] === etag) return reply.code(304).send();
      return reply.send(output);
    },
  );
};
