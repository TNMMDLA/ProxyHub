import type { Prisma } from '@prisma/client';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { normalizeRuleSet, parseRuleSet } from '@proxyhub/rule-set-core';
import type { RuleSetFormat } from '@proxyhub/rule-set-core';
import {
  bulkDeleteRuleSetEntriesSchema,
  bulkRuleSetEntriesSchema,
  createRuleSetSchema,
  parseRuleSetPreviewSchema,
  reorderPolicyRulesSchema,
  ruleSetEntrySchema,
  testRuleSetSourceSchema,
  updateRuleSetEntrySchema,
  updateRuleSetSchema,
} from '@proxyhub/shared';
import { audit } from '../audit.js';
import { requireRole } from '../auth/session.js';
import { prisma } from '../db.js';
import { AppError } from '../errors.js';
import { redactRemoteUrl } from '../rule-set/security.js';
import {
  mutateManualRuleSet,
  rebuildManualRuleSet,
  refreshRuleSet,
  testRemoteRuleSet,
} from '../rule-set/service.js';

const ruleSetInclude = {
  cache: {
    select: {
      contentHash: true,
      normalizedContent: true,
      ruleCount: true,
      duplicateCount: true,
      warnings: true,
      sourceEtag: true,
      sourceLastModified: true,
      fetchedAt: true,
      validatedAt: true,
    },
  },
  entries: { orderBy: [{ order: 'asc' as const }, { id: 'asc' as const }] },
  policyRules: {
    select: { policy: { select: { id: true, name: true } } },
    distinct: ['policyId' as const],
  },
  _count: { select: { entries: true, policyRules: true } },
} satisfies Prisma.RuleSetInclude;

function idFrom(request: FastifyRequest): string {
  return (request.params as { id: string }).id;
}

function safeRuleSet<T extends { sourceUrl: string | null }>(ruleSet: T) {
  const safe = {
    ...ruleSet,
    sourceUrl: ruleSet.sourceUrl ? redactRemoteUrl(ruleSet.sourceUrl) : null,
  } as T & { cache?: unknown };
  if ('cache' in safe) delete safe.cache;
  return safe;
}

async function findRuleSet(id: string) {
  const ruleSet = await prisma.ruleSet.findUnique({ where: { id }, include: ruleSetInclude });
  if (!ruleSet) throw new AppError('RULE_SET_NOT_FOUND', 'Rule set not found', 404);
  return ruleSet;
}

async function assertManual(id: string) {
  const ruleSet = await prisma.ruleSet.findUnique({ where: { id } });
  if (!ruleSet) throw new AppError('RULE_SET_NOT_FOUND', 'Rule set not found', 404);
  if (ruleSet.sourceType !== 'MANUAL') {
    throw new AppError(
      'RULE_SET_VALIDATION_FAILED',
      'Remote rule sets do not have editable entries',
      422,
    );
  }
  return ruleSet;
}

function normalizedPreview(content: string, format?: RuleSetFormat | 'AUTO') {
  const parsed = parseRuleSet(content, format === 'AUTO' ? undefined : format);
  const normalized = normalizeRuleSet(parsed.parsedRules);
  const distribution = Object.fromEntries(
    [...new Set(normalized.rules.map((rule) => rule.type))].map((type) => [
      type,
      normalized.rules.filter((rule) => rule.type === type).length,
    ]),
  );
  return {
    sourceType: 'IMPORT',
    detectedFormat: parsed.format,
    totalLines: parsed.totalLines,
    parsedRules: normalized.rules.length,
    skippedRules: parsed.skippedRules,
    duplicateCount: normalized.duplicateCount,
    warnings: [...parsed.warnings, ...normalized.warnings],
    errors: [...parsed.errors, ...normalized.errors],
    sampleRules: normalized.rules.slice(0, 50),
    distribution,
    contentHash: normalized.contentHash,
  };
}

async function notifyDisabledReference(id: string, name: string): Promise<void> {
  const count = await prisma.policyRule.count({ where: { ruleSetId: id } });
  if (count === 0) return;
  await prisma.notification.create({
    data: {
      level: 'CRITICAL',
      title: 'Referenced rule set disabled',
      message: `${name} is referenced by ${String(count)} policy rule${count === 1 ? '' : 's'}.`,
      eventType: 'RULE_SET_REFERENCED_DISABLED',
    },
  });
}

export const ruleSetRoutes: FastifyPluginAsync = async (app) => {
  app.get('/', { preHandler: requireRole('ADMIN', 'OPERATOR', 'VIEWER') }, async () => ({
    success: true,
    data: (
      await prisma.ruleSet.findMany({
        include: {
          _count: { select: { entries: true, policyRules: true } },
          policyRules: {
            select: { policy: { select: { id: true, name: true } } },
            distinct: ['policyId'],
          },
        },
        orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
      })
    ).map(safeRuleSet),
  }));

  app.post('/', { preHandler: requireRole('ADMIN', 'OPERATOR') }, async (request, reply) => {
    const input = createRuleSetSchema.parse(request.body);
    const ruleSet = await prisma.ruleSet.create({
      data: {
        ...input,
        sourceUrl: input.sourceType === 'REMOTE' ? input.sourceUrl : null,
        updateIntervalMinutes: input.sourceType === 'REMOTE' ? input.updateIntervalMinutes : null,
        status: input.enabled ? (input.sourceType === 'REMOTE' ? 'ERROR' : 'EMPTY') : 'DISABLED',
        nextUpdateAt:
          input.enabled && input.sourceType === 'REMOTE' && input.updateIntervalMinutes
            ? new Date()
            : null,
      },
      include: ruleSetInclude,
    });
    if (input.sourceType === 'MANUAL') await rebuildManualRuleSet(ruleSet.id);
    await audit(request, 'RULE_SET_CREATED', 'RuleSet', 'SUCCESS', ruleSet.id, {
      name: ruleSet.name,
      sourceType: ruleSet.sourceType,
      ...(ruleSet.sourceUrl ? { sourceUrl: redactRemoteUrl(ruleSet.sourceUrl) } : {}),
    });
    return reply
      .code(201)
      .send({ success: true, data: safeRuleSet(await findRuleSet(ruleSet.id)) });
  });

  app.post(
    '/parse-preview',
    { preHandler: requireRole('ADMIN', 'OPERATOR', 'VIEWER') },
    async (request) => {
      const input = parseRuleSetPreviewSchema.parse(request.body);
      return { success: true, data: normalizedPreview(input.content, input.format) };
    },
  );

  app.post('/test-source', { preHandler: requireRole('ADMIN', 'OPERATOR') }, async (request) => {
    const input = testRuleSetSourceSchema.parse(request.body);
    const tested = await testRemoteRuleSet(input.url, input.format);
    await audit(request, 'RULE_SET_SOURCE_TESTED', 'RuleSet', 'SUCCESS', undefined, {
      sourceUrl: redactRemoteUrl(input.url),
      format: input.format,
      ruleCount: tested.ruleCount,
    });
    return { success: true, data: tested };
  });

  app.get('/:id', { preHandler: requireRole('ADMIN', 'OPERATOR', 'VIEWER') }, async (request) => ({
    success: true,
    data: safeRuleSet(await findRuleSet(idFrom(request))),
  }));

  app.patch('/:id', { preHandler: requireRole('ADMIN', 'OPERATOR') }, async (request) => {
    const id = idFrom(request);
    const current = await findRuleSet(id);
    const patch = updateRuleSetSchema.parse(request.body);
    if (current.sourceType === 'MANUAL' && (patch.sourceUrl || patch.updateIntervalMinutes)) {
      throw new AppError(
        'RULE_SET_VALIDATION_FAILED',
        'Manual rule sets cannot have remote settings',
        422,
      );
    }
    if (current.sourceType === 'REMOTE' && patch.sourceUrl === null) {
      throw new AppError('RULE_SET_VALIDATION_FAILED', 'Remote rule sets require a URL', 422);
    }
    const sourceChanged =
      (patch.sourceUrl !== undefined && patch.sourceUrl !== current.sourceUrl) ||
      (patch.format !== undefined && patch.format !== current.format);
    const requestedEnabled = patch.enabled ?? current.enabled;
    const lifecyclePatch: Prisma.RuleSetUpdateInput = !requestedEnabled
      ? { status: 'DISABLED', nextUpdateAt: null }
      : sourceChanged
        ? {
            status: current.cache ? 'STALE' : 'ERROR',
            lastError: 'Remote source changed; refresh required.',
            nextUpdateAt: new Date(),
          }
        : patch.enabled === true
          ? {
              status: current.cache
                ? current.ruleCount > 0
                  ? 'READY'
                  : 'EMPTY'
                : current.sourceType === 'REMOTE'
                  ? 'ERROR'
                  : 'EMPTY',
              nextUpdateAt:
                current.sourceType === 'REMOTE' &&
                (patch.updateIntervalMinutes ?? current.updateIntervalMinutes)
                  ? new Date()
                  : null,
            }
          : {};
    const data: Prisma.RuleSetUpdateInput = {
      ...(patch.name === undefined ? {} : { name: patch.name }),
      ...(patch.description === undefined ? {} : { description: patch.description }),
      ...(patch.enabled === undefined ? {} : { enabled: patch.enabled }),
      ...(patch.format === undefined ? {} : { format: patch.format }),
      ...(patch.sourceUrl === undefined ? {} : { sourceUrl: patch.sourceUrl }),
      ...(patch.updateIntervalMinutes === undefined
        ? {}
        : { updateIntervalMinutes: patch.updateIntervalMinutes }),
      ...lifecyclePatch,
    };
    await prisma.ruleSet.update({
      where: { id },
      data,
    });
    if (current.enabled && patch.enabled === false) {
      await notifyDisabledReference(id, current.name);
    }
    await audit(request, 'RULE_SET_UPDATED', 'RuleSet', 'SUCCESS', id, {
      fields: Object.keys(patch),
      ...(patch.sourceUrl ? { sourceUrl: redactRemoteUrl(patch.sourceUrl) } : {}),
    });
    return { success: true, data: safeRuleSet(await findRuleSet(id)) };
  });

  for (const [path, enabled] of [
    ['enable', true],
    ['disable', false],
  ] as const) {
    app.post(`/:id/${path}`, { preHandler: requireRole('ADMIN', 'OPERATOR') }, async (request) => {
      const id = idFrom(request);
      const current = await findRuleSet(id);
      await prisma.ruleSet.update({
        where: { id },
        data: {
          enabled,
          status: enabled
            ? current.cache
              ? current.ruleCount
                ? 'READY'
                : 'EMPTY'
              : 'ERROR'
            : 'DISABLED',
          nextUpdateAt:
            enabled && current.sourceType === 'REMOTE' && current.updateIntervalMinutes
              ? new Date()
              : null,
        },
      });
      if (current.enabled && !enabled) await notifyDisabledReference(id, current.name);
      await audit(
        request,
        enabled ? 'RULE_SET_ENABLED' : 'RULE_SET_DISABLED',
        'RuleSet',
        'SUCCESS',
        id,
        { name: current.name },
      );
      return { success: true, data: safeRuleSet(await findRuleSet(id)) };
    });
  }

  app.post(
    '/:id/duplicate',
    { preHandler: requireRole('ADMIN', 'OPERATOR') },
    async (request, reply) => {
      const source = await findRuleSet(idFrom(request));
      const suffix = Date.now().toString(36).slice(-5);
      const duplicate = await prisma.ruleSet.create({
        data: {
          name: `${source.name.slice(0, 88)} Copy ${suffix}`,
          description: source.description,
          enabled: false,
          sourceType: 'MANUAL',
          format: 'PROXYHUB_NATIVE',
          status: 'DISABLED',
          entries: {
            create: source.cache
              ? (
                  JSON.parse(source.cache.normalizedContent) as Array<{
                    type: string;
                    value: string;
                  }>
                ).map((rule, order) => ({ ...rule, order }))
              : [],
          },
        },
      });
      await rebuildManualRuleSet(duplicate.id);
      await audit(request, 'RULE_SET_CREATED', 'RuleSet', 'SUCCESS', duplicate.id, {
        duplicatedFrom: source.id,
      });
      return reply
        .code(201)
        .send({ success: true, data: safeRuleSet(await findRuleSet(duplicate.id)) });
    },
  );

  app.post('/:id/refresh', { preHandler: requireRole('ADMIN', 'OPERATOR') }, async (request) => {
    const result = await refreshRuleSet(idFrom(request));
    return { success: true, data: result };
  });

  app.get(
    '/:id/preview',
    { preHandler: requireRole('ADMIN', 'OPERATOR', 'VIEWER') },
    async (request) => {
      const ruleSet = await findRuleSet(idFrom(request));
      const query = request.query as { offset?: string; limit?: string };
      const offset = Math.max(0, Number(query.offset ?? 0) || 0);
      const limit = Math.min(100, Math.max(1, Number(query.limit ?? 50) || 50));
      const rules = ruleSet.cache
        ? (JSON.parse(ruleSet.cache.normalizedContent) as Array<{ type: string; value: string }>)
        : [];
      const distribution = Object.fromEntries(
        [...new Set(rules.map((rule) => rule.type))].map((type) => [
          type,
          rules.filter((rule) => rule.type === type).length,
        ]),
      );
      return {
        success: true,
        data: {
          totalRules: rules.length,
          offset,
          limit,
          rules: rules.slice(offset, offset + limit),
          distribution,
          duplicateCount: ruleSet.cache?.duplicateCount ?? 0,
          warnings: ruleSet.cache ? (JSON.parse(ruleSet.cache.warnings) as unknown[]) : [],
          status: ruleSet.status,
          contentHash: ruleSet.contentHash,
        },
      };
    },
  );

  app.get(
    '/:id/export',
    { preHandler: requireRole('ADMIN', 'OPERATOR', 'VIEWER') },
    async (request) => {
      const ruleSet = await findRuleSet(idFrom(request));
      const rules = ruleSet.cache
        ? (JSON.parse(ruleSet.cache.normalizedContent) as Array<{ type: string; value: string }>)
        : [];
      return {
        success: true,
        data: {
          version: 1,
          name: ruleSet.name,
          description: ruleSet.description,
          sourceType: ruleSet.sourceType,
          format: 'PROXYHUB_NATIVE',
          contentHash: ruleSet.contentHash,
          rules,
        },
      };
    },
  );

  app.post('/:id/import', { preHandler: requireRole('ADMIN', 'OPERATOR') }, async (request) => {
    const id = idFrom(request);
    await assertManual(id);
    const body = request.body as { content?: unknown; format?: unknown; mode?: unknown };
    const input = parseRuleSetPreviewSchema.parse({ content: body.content, format: body.format });
    const preview = normalizedPreview(input.content, input.format);
    if (preview.errors.length) {
      throw new AppError(
        'RULE_SET_PARSE_FAILED',
        'Imported rule set is invalid',
        422,
        preview.errors,
      );
    }
    const normalized = normalizeRuleSet(
      parseRuleSet(input.content, input.format === 'AUTO' ? undefined : input.format).parsedRules,
    );
    const mode = body.mode === 'APPEND' ? 'APPEND' : 'REPLACE';
    const { result: rebuilt } = await mutateManualRuleSet(id, async (transaction) => {
      if (mode === 'REPLACE')
        await transaction.ruleSetEntry.deleteMany({ where: { ruleSetId: id } });
      const highest =
        mode === 'APPEND'
          ? ((
              await transaction.ruleSetEntry.aggregate({
                where: { ruleSetId: id },
                _max: { order: true },
              })
            )._max.order ?? -1) + 1
          : 0;
      if (normalized.rules.length) {
        await transaction.ruleSetEntry.createMany({
          data: normalized.rules.map((rule, index) => ({
            ruleSetId: id,
            type: rule.type,
            value: rule.value,
            enabled: true,
            order: highest + index,
          })),
        });
      }
    });
    await audit(request, 'RULE_SET_BULK_IMPORT', 'RuleSet', 'SUCCESS', id, {
      mode,
      ruleCount: normalized.rules.length,
      duplicateCount: normalized.duplicateCount,
    });
    return { success: true, data: { ...rebuilt, preview } };
  });

  app.post(
    '/:id/entries',
    { preHandler: requireRole('ADMIN', 'OPERATOR') },
    async (request, reply) => {
      const id = idFrom(request);
      await assertManual(id);
      const input = ruleSetEntrySchema.parse(request.body);
      const { value: entry } = await mutateManualRuleSet(id, async (transaction) => {
        const highest = await transaction.ruleSetEntry.aggregate({
          where: { ruleSetId: id },
          _max: { order: true },
        });
        return transaction.ruleSetEntry.create({
          data: { ...input, ruleSetId: id, order: (highest._max.order ?? -1) + 1 },
        });
      });
      await audit(request, 'RULE_SET_ENTRY_CREATED', 'RuleSetEntry', 'SUCCESS', entry.id, {
        ruleSetId: id,
        type: entry.type,
      });
      return reply.code(201).send({ success: true, data: entry });
    },
  );

  app.post(
    '/:id/entries/bulk',
    { preHandler: requireRole('ADMIN', 'OPERATOR') },
    async (request, reply) => {
      const id = idFrom(request);
      await assertManual(id);
      const input = bulkRuleSetEntriesSchema.parse(request.body);
      const { result: rebuilt } = await mutateManualRuleSet(id, async (transaction) => {
        const highest = await transaction.ruleSetEntry.aggregate({
          where: { ruleSetId: id },
          _max: { order: true },
        });
        const start = (highest._max.order ?? -1) + 1;
        await transaction.ruleSetEntry.createMany({
          data: input.entries.map((entry, index) => ({
            ...entry,
            ruleSetId: id,
            order: start + index,
          })),
        });
      });
      await audit(request, 'RULE_SET_BULK_IMPORT', 'RuleSet', 'SUCCESS', id, {
        ruleCount: input.entries.length,
      });
      return reply.code(201).send({ success: true, data: rebuilt });
    },
  );

  app.delete(
    '/:id/entries/bulk',
    { preHandler: requireRole('ADMIN', 'OPERATOR') },
    async (request) => {
      const id = idFrom(request);
      await assertManual(id);
      const input = bulkDeleteRuleSetEntriesSchema.parse(request.body);
      const { value: deleted } = await mutateManualRuleSet(id, (transaction) =>
        transaction.ruleSetEntry.deleteMany({
          where: { ruleSetId: id, id: { in: input.entryIds } },
        }),
      );
      await audit(request, 'RULE_SET_BULK_DELETE', 'RuleSet', 'SUCCESS', id, {
        count: deleted.count,
      });
      return { success: true, data: { deleted: deleted.count } };
    },
  );

  app.patch(
    '/:id/entries/:entryId',
    { preHandler: requireRole('ADMIN', 'OPERATOR') },
    async (request) => {
      const { id, entryId } = request.params as { id: string; entryId: string };
      await assertManual(id);
      const patch = updateRuleSetEntrySchema.parse(request.body);
      const { value: entry } = await mutateManualRuleSet(id, async (transaction) => {
        const existing = await transaction.ruleSetEntry.findFirst({
          where: { id: entryId, ruleSetId: id },
        });
        if (!existing)
          throw new AppError('RULE_SET_ENTRY_NOT_FOUND', 'Rule set entry not found', 404);
        return transaction.ruleSetEntry.update({
          where: { id: entryId },
          data: {
            ...(patch.type === undefined ? {} : { type: patch.type }),
            ...(patch.value === undefined ? {} : { value: patch.value }),
            ...(patch.enabled === undefined ? {} : { enabled: patch.enabled }),
          },
        });
      });
      await audit(request, 'RULE_SET_ENTRY_UPDATED', 'RuleSetEntry', 'SUCCESS', entryId, {
        ruleSetId: id,
        fields: Object.keys(patch),
      });
      return { success: true, data: entry };
    },
  );

  app.delete(
    '/:id/entries/:entryId',
    { preHandler: requireRole('ADMIN', 'OPERATOR') },
    async (request) => {
      const { id, entryId } = request.params as { id: string; entryId: string };
      await assertManual(id);
      await mutateManualRuleSet(id, async (transaction) => {
        const deleted = await transaction.ruleSetEntry.deleteMany({
          where: { id: entryId, ruleSetId: id },
        });
        if (!deleted.count)
          throw new AppError('RULE_SET_ENTRY_NOT_FOUND', 'Rule set entry not found', 404);
      });
      await audit(request, 'RULE_SET_ENTRY_DELETED', 'RuleSetEntry', 'SUCCESS', entryId, {
        ruleSetId: id,
      });
      return { success: true, data: null };
    },
  );

  app.put(
    '/:id/entries/reorder',
    { preHandler: requireRole('ADMIN', 'OPERATOR') },
    async (request) => {
      const id = idFrom(request);
      await assertManual(id);
      const { ruleIds } = reorderPolicyRulesSchema.parse(request.body);
      const existing = await prisma.ruleSetEntry.findMany({
        where: { ruleSetId: id },
        select: { id: true },
      });
      const ids = new Set(existing.map((entry) => entry.id));
      if (
        ruleIds.length !== ids.size ||
        new Set(ruleIds).size !== ruleIds.length ||
        ruleIds.some((entryId) => !ids.has(entryId))
      ) {
        throw new AppError(
          'RULE_SET_VALIDATION_FAILED',
          'Reorder must include every entry exactly once',
          422,
        );
      }
      await mutateManualRuleSet(id, async (transaction) => {
        for (const [order, entryId] of ruleIds.entries()) {
          await transaction.ruleSetEntry.update({ where: { id: entryId }, data: { order } });
        }
      });
      await audit(request, 'RULE_SET_ENTRIES_REORDERED', 'RuleSet', 'SUCCESS', id, {
        entryIds: ruleIds,
      });
      return { success: true, data: (await findRuleSet(id)).entries };
    },
  );

  app.delete('/:id', { preHandler: requireRole('ADMIN', 'OPERATOR') }, async (request) => {
    const id = idFrom(request);
    const ruleSet = await findRuleSet(id);
    if (ruleSet.policyRules.length > 0) {
      await audit(request, 'DELETE_BLOCKED_BY_DEPENDENCY', 'RuleSet', 'FAILURE', id, {
        codes: ['POLICY_WOULD_LOSE_RULE_SET'],
      });
      throw new AppError('RULE_SET_IN_USE', 'Rule set is used by policies', 409, {
        policies: ruleSet.policyRules.map(({ policy }) => policy),
      });
    }
    await prisma.ruleSet.delete({ where: { id } });
    await audit(request, 'RULE_SET_DELETED', 'RuleSet', 'SUCCESS', id, { name: ruleSet.name });
    return { success: true, data: null };
  });
};
