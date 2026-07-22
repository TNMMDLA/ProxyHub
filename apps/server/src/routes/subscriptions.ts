import { createHash } from 'node:crypto';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { createSubscriptionSchema, updateSubscriptionSchema } from '@proxyhub/shared';
import type { CompilerFormat } from '@proxyhub/policy-core';
import { audit } from '../audit.js';
import { requireRole } from '../auth/session.js';
import { prisma } from '../db.js';
import { AppError } from '../errors.js';
import { compileStoredPolicy, maskCompilerOutput } from '../policy-service.js';
import { hashToken, newOpaqueToken } from '../security/crypto.js';

const subscriptionInclude = {
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

export const subscriptionRoutes: FastifyPluginAsync = async (app) => {
  app.get('/', { preHandler: requireRole('ADMIN', 'OPERATOR', 'VIEWER') }, async () => ({
    success: true,
    data: await prisma.subscription.findMany({
      include: subscriptionInclude,
      orderBy: { createdAt: 'desc' },
    }),
  }));

  app.post('/', { preHandler: requireRole('ADMIN', 'OPERATOR') }, async (request, reply) => {
    const input = createSubscriptionSchema.parse(request.body);
    await assertPolicy(input.policyId);
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
      include: subscriptionInclude,
    });
    await audit(request, 'SUBSCRIPTION_CREATED', 'Subscription', 'SUCCESS', subscription.id, {
      name: subscription.name,
      format: subscription.format,
      tokenPrefix: subscription.tokenPrefix,
    });
    return reply.code(201).send({
      success: true,
      data: { subscription, token: issued.token, path: `/sub/${issued.token}` },
    });
  });

  app.get('/:id', { preHandler: requireRole('ADMIN', 'OPERATOR', 'VIEWER') }, async (request) => {
    const subscription = await prisma.subscription.findUnique({
      where: { id: idFrom(request) },
      include: subscriptionInclude,
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
      include: subscriptionInclude,
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
    return { success: true, data: subscription };
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
        include: subscriptionInclude,
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

  app.post(
    '/:id/preview',
    { preHandler: requireRole('ADMIN', 'OPERATOR', 'VIEWER') },
    async (request) => {
      const subscription = await prisma.subscription.findUnique({ where: { id: idFrom(request) } });
      if (!subscription)
        throw new AppError('SUBSCRIPTION_NOT_FOUND', 'Subscription not found', 404);
      try {
        const { input, result } = await compileSubscription(
          subscription.policyId,
          subscription.format as CompilerFormat,
        );
        return {
          success: true,
          data: { ...result, maskedOutput: maskCompilerOutput(result.output, input.nodes) },
        };
      } catch (error) {
        await prisma.notification.create({
          data: {
            level: 'CRITICAL',
            title: 'Subscription compile failed',
            message: `${subscription.name} could not be compiled from its current policy.`,
            eventType: 'SUBSCRIPTION_COMPILE_FAILED',
          },
        });
        throw error;
      }
    },
  );

  app.delete('/:id', { preHandler: requireRole('ADMIN', 'OPERATOR') }, async (request) => {
    const id = idFrom(request);
    const subscription = await prisma.subscription.findUnique({ where: { id } });
    if (!subscription) throw new AppError('SUBSCRIPTION_NOT_FOUND', 'Subscription not found', 404);
    await prisma.subscription.delete({ where: { id } });
    await audit(request, 'SUBSCRIPTION_DELETED', 'Subscription', 'SUCCESS', id, {
      name: subscription.name,
      tokenPrefix: subscription.tokenPrefix,
    });
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
      } catch (error) {
        await prisma.notification.create({
          data: {
            level: 'CRITICAL',
            title: 'Subscription compile failed',
            message: `${subscription.name} could not be served because its policy is invalid.`,
            eventType: 'SUBSCRIPTION_COMPILE_FAILED',
          },
        });
        throw error;
      }
      const output = compiled.result.output;
      const etag = `"${createHash('sha256').update(output).digest('hex')}"`;
      if (request.headers['if-none-match'] === etag) return reply.code(304).send();
      await prisma.subscription.update({
        where: { id: subscription.id },
        data: { lastAccessAt: new Date() },
      });
      const contentType =
        subscription.format === 'mihomo'
          ? 'text/yaml; charset=utf-8'
          : subscription.format === 'sing-box'
            ? 'application/json; charset=utf-8'
            : 'text/plain; charset=utf-8';
      return reply
        .type(contentType)
        .header('cache-control', 'private, no-cache')
        .header('etag', etag)
        .send(output);
    },
  );
};
