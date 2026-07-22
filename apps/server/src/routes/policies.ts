import type { Prisma } from '@prisma/client';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import {
  compilePolicySchema,
  createPolicySchema,
  policyRuleInputSchema,
  reorderPolicyRulesSchema,
  updatePolicyRuleSchema,
  updatePolicySchema,
} from '@proxyhub/shared';
import { audit } from '../audit.js';
import { requireRole } from '../auth/session.js';
import { prisma } from '../db.js';
import { AppError } from '../errors.js';
import { compileStoredPolicy, maskCompilerOutput } from '../policy-service.js';

const policyInclude = {
  defaultNodePool: { select: { id: true, name: true, enabled: true } },
  rules: {
    include: { nodePool: { select: { id: true, name: true, enabled: true } } },
    orderBy: [{ priority: 'asc' as const }, { id: 'asc' as const }],
  },
  _count: { select: { subscriptions: true } },
} satisfies Prisma.PolicyInclude;

async function validatedPoolId(action: string, poolId: string | null): Promise<string | null> {
  if (action !== 'NODE_POOL') return null;
  if (!poolId) throw new AppError('POLICY_INVALID', 'NODE_POOL action requires a node pool', 422);
  if (!(await prisma.nodePool.findUnique({ where: { id: poolId }, select: { id: true } }))) {
    throw new AppError('POLICY_NODE_POOL_MISSING', 'The selected node pool does not exist', 422);
  }
  return poolId;
}

async function notifyCompileFailure(policyName: string, errorCount: number): Promise<void> {
  await prisma.notification.create({
    data: {
      level: 'CRITICAL',
      title: 'Policy compile failed',
      message: `${policyName} has ${String(errorCount)} compile error${errorCount === 1 ? '' : 's'}.`,
      eventType: 'POLICY_COMPILE_FAILED',
    },
  });
}

function idFrom(request: FastifyRequest): string {
  return (request.params as { id: string }).id;
}

export const policyRoutes: FastifyPluginAsync = async (app) => {
  app.get('/', { preHandler: requireRole('ADMIN', 'OPERATOR', 'VIEWER') }, async () => ({
    success: true,
    data: await prisma.policy.findMany({
      include: {
        defaultNodePool: { select: { id: true, name: true, enabled: true } },
        _count: { select: { rules: true, subscriptions: true } },
      },
      orderBy: { updatedAt: 'desc' },
    }),
  }));

  app.post('/', { preHandler: requireRole('ADMIN', 'OPERATOR') }, async (request, reply) => {
    const input = createPolicySchema.parse(request.body);
    const defaultNodePoolId = await validatedPoolId(input.defaultAction, input.defaultNodePoolId);
    const policy = await prisma.policy.create({
      data: { ...input, defaultNodePoolId },
      include: policyInclude,
    });
    await audit(request, 'POLICY_CREATED', 'Policy', 'SUCCESS', policy.id, { name: policy.name });
    return reply.code(201).send({ success: true, data: policy });
  });

  app.get('/:id', { preHandler: requireRole('ADMIN', 'OPERATOR', 'VIEWER') }, async (request) => {
    const policy = await prisma.policy.findUnique({
      where: { id: idFrom(request) },
      include: policyInclude,
    });
    if (!policy) throw new AppError('POLICY_NOT_FOUND', 'Policy not found', 404);
    return { success: true, data: policy };
  });

  app.patch('/:id', { preHandler: requireRole('ADMIN', 'OPERATOR') }, async (request) => {
    const id = idFrom(request);
    const patch = updatePolicySchema.parse(request.body);
    const current = await prisma.policy.findUnique({ where: { id } });
    if (!current) throw new AppError('POLICY_NOT_FOUND', 'Policy not found', 404);
    const candidate = createPolicySchema.parse({ ...current, ...patch });
    const defaultNodePoolId = await validatedPoolId(
      candidate.defaultAction,
      candidate.defaultNodePoolId,
    );
    const policy = await prisma.policy.update({
      where: { id },
      data: { ...candidate, defaultNodePoolId, revision: { increment: 1 } },
      include: policyInclude,
    });
    const action =
      patch.enabled === undefined
        ? 'POLICY_UPDATED'
        : patch.enabled
          ? 'POLICY_ENABLED'
          : 'POLICY_DISABLED';
    await audit(request, action, 'Policy', 'SUCCESS', id, { fields: Object.keys(patch) });
    return { success: true, data: policy };
  });

  app.post(
    '/:id/duplicate',
    { preHandler: requireRole('ADMIN', 'OPERATOR') },
    async (request, reply) => {
      const source = await prisma.policy.findUnique({
        where: { id: idFrom(request) },
        include: { rules: { orderBy: { priority: 'asc' } } },
      });
      if (!source) throw new AppError('POLICY_NOT_FOUND', 'Policy not found', 404);
      const suffix = Date.now().toString(36).slice(-5);
      const duplicate = await prisma.policy.create({
        data: {
          name: `${source.name.slice(0, 88)} Copy ${suffix}`,
          description: source.description,
          enabled: false,
          defaultAction: source.defaultAction,
          defaultNodePoolId: source.defaultNodePoolId,
          rules: {
            create: source.rules.map((rule) => ({
              name: rule.name,
              description: rule.description,
              enabled: rule.enabled,
              priority: rule.priority,
              matchType: rule.matchType,
              matchValue: rule.matchValue,
              actionType: rule.actionType,
              nodePoolId: rule.nodePoolId,
            })),
          },
        },
        include: policyInclude,
      });
      await audit(request, 'POLICY_CREATED', 'Policy', 'SUCCESS', duplicate.id, {
        duplicatedFrom: source.id,
      });
      return reply.code(201).send({ success: true, data: duplicate });
    },
  );

  app.delete('/:id', { preHandler: requireRole('ADMIN', 'OPERATOR') }, async (request) => {
    const id = idFrom(request);
    const policy = await prisma.policy.findUnique({
      where: { id },
      include: { _count: { select: { subscriptions: true } } },
    });
    if (!policy) throw new AppError('POLICY_NOT_FOUND', 'Policy not found', 404);
    if (policy._count.subscriptions > 0) {
      throw new AppError('POLICY_IN_USE', 'Policy is used by subscriptions', 409, {
        subscriptions: policy._count.subscriptions,
      });
    }
    await prisma.policy.delete({ where: { id } });
    await audit(request, 'POLICY_DELETED', 'Policy', 'SUCCESS', id, { name: policy.name });
    return { success: true, data: null };
  });

  app.post(
    '/:id/rules',
    { preHandler: requireRole('ADMIN', 'OPERATOR') },
    async (request, reply) => {
      const policyId = idFrom(request);
      const input = policyRuleInputSchema.parse(request.body);
      if (!(await prisma.policy.findUnique({ where: { id: policyId }, select: { id: true } }))) {
        throw new AppError('POLICY_NOT_FOUND', 'Policy not found', 404);
      }
      const nodePoolId = await validatedPoolId(input.actionType, input.nodePoolId);
      const highest = await prisma.policyRule.aggregate({
        where: { policyId },
        _max: { priority: true },
      });
      const rule = await prisma.$transaction(async (transaction) => {
        const created = await transaction.policyRule.create({
          data: { ...input, nodePoolId, policyId, priority: (highest._max.priority ?? 0) + 10 },
          include: { nodePool: true },
        });
        await transaction.policy.update({
          where: { id: policyId },
          data: { revision: { increment: 1 } },
        });
        return created;
      });
      await audit(request, 'RULE_CREATED', 'PolicyRule', 'SUCCESS', rule.id, {
        policyId,
        name: rule.name,
      });
      return reply.code(201).send({ success: true, data: rule });
    },
  );

  app.patch(
    '/:id/rules/:ruleId',
    { preHandler: requireRole('ADMIN', 'OPERATOR') },
    async (request) => {
      const { id: policyId, ruleId } = request.params as { id: string; ruleId: string };
      const patch = updatePolicyRuleSchema.parse(request.body);
      const current = await prisma.policyRule.findFirst({ where: { id: ruleId, policyId } });
      if (!current) throw new AppError('POLICY_RULE_NOT_FOUND', 'Policy rule not found', 404);
      const candidate = policyRuleInputSchema.parse({ ...current, ...patch });
      const nodePoolId = await validatedPoolId(candidate.actionType, candidate.nodePoolId);
      const rule = await prisma.$transaction(async (transaction) => {
        const updated = await transaction.policyRule.update({
          where: { id: ruleId },
          data: { ...candidate, nodePoolId },
          include: { nodePool: true },
        });
        await transaction.policy.update({
          where: { id: policyId },
          data: { revision: { increment: 1 } },
        });
        return updated;
      });
      const action =
        patch.enabled === undefined
          ? 'RULE_UPDATED'
          : patch.enabled
            ? 'RULE_ENABLED'
            : 'RULE_DISABLED';
      await audit(request, action, 'PolicyRule', 'SUCCESS', ruleId, {
        policyId,
        fields: Object.keys(patch),
      });
      return { success: true, data: rule };
    },
  );

  app.delete(
    '/:id/rules/:ruleId',
    { preHandler: requireRole('ADMIN', 'OPERATOR') },
    async (request) => {
      const { id: policyId, ruleId } = request.params as { id: string; ruleId: string };
      const rule = await prisma.policyRule.findFirst({ where: { id: ruleId, policyId } });
      if (!rule) throw new AppError('POLICY_RULE_NOT_FOUND', 'Policy rule not found', 404);
      await prisma.$transaction([
        prisma.policyRule.delete({ where: { id: ruleId } }),
        prisma.policy.update({ where: { id: policyId }, data: { revision: { increment: 1 } } }),
      ]);
      await audit(request, 'RULE_DELETED', 'PolicyRule', 'SUCCESS', ruleId, {
        policyId,
        name: rule.name,
      });
      return { success: true, data: null };
    },
  );

  app.put(
    '/:id/rules/reorder',
    { preHandler: requireRole('ADMIN', 'OPERATOR') },
    async (request) => {
      const policyId = idFrom(request);
      const { ruleIds } = reorderPolicyRulesSchema.parse(request.body);
      const existing = await prisma.policyRule.findMany({
        where: { policyId },
        select: { id: true },
      });
      const existingIds = new Set(existing.map((rule) => rule.id));
      if (
        ruleIds.length !== existingIds.size ||
        new Set(ruleIds).size !== ruleIds.length ||
        ruleIds.some((id) => !existingIds.has(id))
      ) {
        throw new AppError(
          'POLICY_RULE_INVALID',
          'Reorder must include every policy rule exactly once',
          422,
        );
      }
      await prisma.$transaction([
        ...ruleIds.map((ruleId, index) =>
          prisma.policyRule.update({ where: { id: ruleId }, data: { priority: (index + 1) * 10 } }),
        ),
        prisma.policy.update({ where: { id: policyId }, data: { revision: { increment: 1 } } }),
      ]);
      await audit(request, 'RULE_REORDERED', 'Policy', 'SUCCESS', policyId, { ruleIds });
      return {
        success: true,
        data: await prisma.policyRule.findMany({
          where: { policyId },
          orderBy: { priority: 'asc' },
        }),
      };
    },
  );

  app.post(
    '/:id/compile-preview',
    { preHandler: requireRole('ADMIN', 'OPERATOR', 'VIEWER') },
    async (request) => {
      const policyId = idFrom(request);
      const { format } = compilePolicySchema.parse(request.body);
      const { input, result } = await compileStoredPolicy(policyId, format);
      if (!result.success) await notifyCompileFailure(input.policy.name, result.errors.length);
      return {
        success: true,
        data: {
          ...result,
          maskedOutput: maskCompilerOutput(result.output, input.nodes),
        },
      };
    },
  );
};
