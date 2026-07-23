import type { Prisma, RuleSet, RuleSetCache } from '@prisma/client';
import { normalizeRuleSet, parseRuleSet } from '@proxyhub/rule-set-core';
import type {
  NormalizedRuleSet,
  RuleSetDiagnostic,
  RuleSetFormat,
  RuleSetRule,
} from '@proxyhub/rule-set-core';
import { config } from '../config.js';
import { prisma } from '../db.js';
import { AppError } from '../errors.js';
import { fetchRemoteRuleSet, type RemoteFetchOptions } from './fetcher.js';
import { redactRemoteUrl } from './security.js';

const inFlight = new Map<string, Promise<RuleSetRefreshResult>>();
const UNSUPPORTED_FAILURE_RATIO = 0.25;

export interface RuleSetRefreshResult {
  status: string;
  changed: boolean;
  ruleCount: number;
  warnings: RuleSetDiagnostic[];
  errors: RuleSetDiagnostic[];
  contentHash: string | null;
  lastSuccessAt: Date | null;
}

type StoredRuleSet = RuleSet & { cache: RuleSetCache | null };

function nextUpdate(interval: number | null, from = new Date()): Date | null {
  return interval === null ? null : new Date(from.getTime() + interval * 60_000);
}

function decodeWarnings(value: string): RuleSetDiagnostic[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? (parsed as RuleSetDiagnostic[]) : [];
  } catch {
    return [];
  }
}

function validateParsed(
  source: string,
  format?: RuleSetFormat,
): NormalizedRuleSet & {
  parseWarnings: RuleSetDiagnostic[];
} {
  const parsed = parseRuleSet(source, format);
  const totalRules = parsed.parsedRules.length + parsed.skippedRules;
  if (
    parsed.errors.length > 0 ||
    (totalRules > 0 && parsed.skippedRules / totalRules > UNSUPPORTED_FAILURE_RATIO)
  ) {
    throw new AppError('RULE_SET_PARSE_FAILED', 'Remote rule set could not be parsed safely', 422, {
      warnings: parsed.warnings,
      errors: parsed.errors,
      parsedRules: parsed.parsedRules.length,
      skippedRules: parsed.skippedRules,
    });
  }
  const normalized = normalizeRuleSet(parsed.parsedRules);
  if (normalized.errors.length > 0) {
    throw new AppError(
      'RULE_SET_VALIDATION_FAILED',
      'Remote rule set contains invalid values',
      422,
      normalized.errors,
    );
  }
  if (normalized.rules.length > config.RULE_SET_MAX_RULES) {
    throw new AppError('RULE_SET_TOO_LARGE', 'Remote rule set exceeds the rule limit', 413);
  }
  return { ...normalized, parseWarnings: parsed.warnings };
}

async function transitionNotification(
  previousStatus: string,
  nextStatus: string,
  ruleSetName: string,
  hadPreviousSuccess = false,
): Promise<void> {
  if (previousStatus === nextStatus) return;
  if (nextStatus === 'STALE' || nextStatus === 'ERROR') {
    const eventType = nextStatus === 'ERROR' ? 'RULE_SET_UNAVAILABLE' : 'RULE_SET_STALE';
    const message =
      nextStatus === 'ERROR'
        ? `${ruleSetName} has no usable cache.`
        : `${ruleSetName} is using its last known good cache.`;
    const duplicate = await prisma.notification.findFirst({
      where: { eventType, message, readAt: null },
      select: { id: true },
    });
    if (duplicate) return;
    await prisma.notification.create({
      data: {
        level: nextStatus === 'ERROR' ? 'CRITICAL' : 'WARNING',
        title: nextStatus === 'ERROR' ? 'Rule set unavailable' : 'Rule set became stale',
        message,
        eventType,
      },
    });
  } else if (
    hadPreviousSuccess &&
    (previousStatus === 'STALE' || previousStatus === 'ERROR') &&
    nextStatus === 'READY'
  ) {
    await prisma.notification.updateMany({
      where: {
        eventType: { in: ['RULE_SET_STALE', 'RULE_SET_UNAVAILABLE'] },
        message: { startsWith: ruleSetName },
        readAt: null,
      },
      data: { readAt: new Date() },
    });
    await prisma.notification.create({
      data: {
        level: 'SUCCESS',
        title: 'Rule set recovered',
        message: `${ruleSetName} refreshed successfully.`,
        eventType: 'RULE_SET_RECOVERED',
      },
    });
  }
}

async function recordSystemAudit(
  ruleSet: StoredRuleSet,
  action: string,
  result: 'SUCCESS' | 'FAILURE',
  metadata: Record<string, unknown>,
): Promise<void> {
  await prisma.auditLog.create({
    data: {
      actorName: 'system',
      action,
      resource: 'RuleSet',
      resourceId: ruleSet.id,
      result,
      metadata: JSON.stringify({
        name: ruleSet.name,
        ...(ruleSet.sourceUrl ? { sourceUrl: redactRemoteUrl(ruleSet.sourceUrl) } : {}),
        ...metadata,
      }),
    },
  });
}

async function markFailure(ruleSet: StoredRuleSet, error: unknown): Promise<never> {
  const hasCache = ruleSet.cache !== null;
  const status = hasCache ? 'STALE' : 'ERROR';
  const code = error instanceof AppError ? error.code : 'RULE_SET_FETCH_FAILED';
  const message = error instanceof Error ? error.message : 'Remote rule set refresh failed';
  await prisma.ruleSet.update({
    where: { id: ruleSet.id },
    data: {
      status,
      lastFetchAt: new Date(),
      lastError: `${code}: ${message}`.slice(0, 500),
      nextUpdateAt: nextUpdate(ruleSet.updateIntervalMinutes),
    },
  });
  await Promise.all([
    transitionNotification(
      ruleSet.lastFetchAt === null ? 'UPDATING' : ruleSet.status,
      status,
      ruleSet.name,
    ),
    recordSystemAudit(ruleSet, 'RULE_SET_REFRESH_FAILED', 'FAILURE', { code, status }),
  ]);
  if (error instanceof AppError) throw error;
  throw new AppError('RULE_SET_FETCH_FAILED', 'Remote rule set refresh failed', 502);
}

async function executeRefresh(
  id: string,
  fetchOptions: RemoteFetchOptions = {},
): Promise<RuleSetRefreshResult> {
  const ruleSet = await prisma.ruleSet.findUnique({ where: { id }, include: { cache: true } });
  if (!ruleSet) throw new AppError('RULE_SET_NOT_FOUND', 'Rule set not found', 404);
  if (!ruleSet.enabled) throw new AppError('RULE_SET_DISABLED', 'Rule set is disabled', 409);
  if (ruleSet.sourceType !== 'REMOTE' || !ruleSet.sourceUrl) {
    throw new AppError('RULE_SET_VALIDATION_FAILED', 'Only remote rule sets can be refreshed', 422);
  }
  await prisma.ruleSet.update({ where: { id }, data: { status: 'UPDATING' } });
  try {
    const fetched = await fetchRemoteRuleSet(ruleSet.sourceUrl, {
      ...(ruleSet.cache ? { etag: ruleSet.cache.sourceEtag } : {}),
      ...(ruleSet.cache ? { lastModified: ruleSet.cache.sourceLastModified } : {}),
      maxBytes: config.RULE_SET_MAX_BYTES,
      timeoutMs: config.RULE_SET_FETCH_TIMEOUT_MS,
      maxRedirects: config.RULE_SET_MAX_REDIRECTS,
      allowHttp: config.RULE_SET_ALLOW_HTTP,
      ...fetchOptions,
    });
    const now = new Date();
    if (fetched.status === 304) {
      if (!ruleSet.cache) {
        throw new AppError(
          'RULE_SET_UNAVAILABLE',
          'Remote source returned 304 without a cache',
          502,
        );
      }
      const status = ruleSet.cache.ruleCount === 0 ? 'EMPTY' : 'READY';
      const updated = await prisma.ruleSet.update({
        where: { id },
        data: {
          status,
          lastFetchAt: now,
          lastSuccessAt: now,
          nextUpdateAt: nextUpdate(ruleSet.updateIntervalMinutes, now),
          lastError: null,
        },
      });
      await transitionNotification(
        ruleSet.status,
        status,
        ruleSet.name,
        ruleSet.lastSuccessAt !== null,
      );
      return {
        status,
        changed: false,
        ruleCount: ruleSet.cache.ruleCount,
        warnings: decodeWarnings(ruleSet.cache.warnings),
        errors: [],
        contentHash: ruleSet.cache.contentHash,
        lastSuccessAt: updated.lastSuccessAt,
      };
    }
    const normalized = validateParsed(
      fetched.content ?? '',
      ruleSet.format === 'AUTO' ? undefined : (ruleSet.format as RuleSetFormat),
    );
    const warnings = [...normalized.parseWarnings, ...normalized.warnings];
    const changed = normalized.contentHash !== ruleSet.cache?.contentHash;
    const status = normalized.rules.length === 0 ? 'EMPTY' : 'READY';
    const updated = await prisma.$transaction(async (transaction) => {
      if (changed || !ruleSet.cache) {
        await transaction.ruleSetCache.upsert({
          where: { ruleSetId: id },
          create: {
            ruleSetId: id,
            normalizedContent: normalized.serialized,
            contentHash: normalized.contentHash,
            ruleCount: normalized.rules.length,
            duplicateCount: normalized.duplicateCount,
            warnings: JSON.stringify(warnings),
            sourceEtag: fetched.etag,
            sourceLastModified: fetched.lastModified,
            fetchedAt: now,
            validatedAt: now,
          },
          update: {
            normalizedContent: normalized.serialized,
            contentHash: normalized.contentHash,
            ruleCount: normalized.rules.length,
            duplicateCount: normalized.duplicateCount,
            warnings: JSON.stringify(warnings),
            sourceEtag: fetched.etag,
            sourceLastModified: fetched.lastModified,
            fetchedAt: now,
            validatedAt: now,
          },
        });
      } else {
        await transaction.ruleSetCache.update({
          where: { ruleSetId: id },
          data: {
            fetchedAt: now,
            sourceEtag: fetched.etag,
            sourceLastModified: fetched.lastModified,
          },
        });
      }
      return transaction.ruleSet.update({
        where: { id },
        data: {
          status,
          lastFetchAt: now,
          lastSuccessAt: now,
          nextUpdateAt: nextUpdate(ruleSet.updateIntervalMinutes, now),
          lastError: null,
          contentHash: normalized.contentHash,
          ruleCount: normalized.rules.length,
          ...(changed ? { revision: { increment: 1 } } : {}),
        },
      });
    });
    await Promise.all([
      transitionNotification(ruleSet.status, status, ruleSet.name, ruleSet.lastSuccessAt !== null),
      recordSystemAudit(ruleSet, 'RULE_SET_REFRESHED', 'SUCCESS', {
        changed,
        ruleCount: normalized.rules.length,
        status,
      }),
    ]);
    return {
      status,
      changed,
      ruleCount: normalized.rules.length,
      warnings,
      errors: [],
      contentHash: normalized.contentHash,
      lastSuccessAt: updated.lastSuccessAt,
    };
  } catch (error) {
    return markFailure(ruleSet, error);
  }
}

export function refreshRuleSet(
  id: string,
  fetchOptions: RemoteFetchOptions = {},
): Promise<RuleSetRefreshResult> {
  const existing = inFlight.get(id);
  if (existing) return existing;
  const promise = executeRefresh(id, fetchOptions).finally(() => inFlight.delete(id));
  inFlight.set(id, promise);
  return promise;
}

export async function mutateManualRuleSet<T>(
  id: string,
  mutation: (transaction: Prisma.TransactionClient) => Promise<T>,
): Promise<{ value: T; result: RuleSetRefreshResult }> {
  return prisma.$transaction(
    async (transaction) => {
      const ruleSet = await transaction.ruleSet.findUnique({
        where: { id },
        include: { cache: true },
      });
      if (!ruleSet) throw new AppError('RULE_SET_NOT_FOUND', 'Rule set not found', 404);
      if (ruleSet.sourceType !== 'MANUAL') {
        throw new AppError('RULE_SET_VALIDATION_FAILED', 'Only manual rule sets have entries', 422);
      }
      const value = await mutation(transaction);
      const entries = await transaction.ruleSetEntry.findMany({
        where: { ruleSetId: id },
        orderBy: [{ order: 'asc' }, { id: 'asc' }],
      });
      const normalized = normalizeRuleSet(
        entries.map((entry) => ({
          type: entry.type as RuleSetRule['type'],
          value: entry.value,
          enabled: entry.enabled,
          order: entry.order,
        })),
      );
      if (normalized.errors.length > 0) {
        throw new AppError(
          'RULE_SET_VALIDATION_FAILED',
          'Manual rule set is invalid',
          422,
          normalized.errors,
        );
      }
      if (normalized.rules.length > config.RULE_SET_MAX_RULES) {
        throw new AppError('RULE_SET_TOO_LARGE', 'Manual rule set exceeds the rule limit', 413);
      }
      const now = new Date();
      const changed = normalized.contentHash !== ruleSet.cache?.contentHash;
      const status = ruleSet.enabled ? (normalized.rules.length ? 'READY' : 'EMPTY') : 'DISABLED';
      await transaction.ruleSetCache.upsert({
        where: { ruleSetId: id },
        create: {
          ruleSetId: id,
          normalizedContent: normalized.serialized,
          contentHash: normalized.contentHash,
          ruleCount: normalized.rules.length,
          duplicateCount: normalized.duplicateCount,
          warnings: JSON.stringify(normalized.warnings),
          fetchedAt: now,
          validatedAt: now,
        },
        update: {
          normalizedContent: normalized.serialized,
          contentHash: normalized.contentHash,
          ruleCount: normalized.rules.length,
          duplicateCount: normalized.duplicateCount,
          warnings: JSON.stringify(normalized.warnings),
          fetchedAt: now,
          validatedAt: now,
        },
      });
      await transaction.ruleSet.update({
        where: { id },
        data: {
          status,
          contentHash: normalized.contentHash,
          ruleCount: normalized.rules.length,
          lastSuccessAt: now,
          lastError: null,
          ...(changed ? { revision: { increment: 1 } } : {}),
        },
      });
      return {
        value,
        result: {
          status,
          changed,
          ruleCount: normalized.rules.length,
          warnings: normalized.warnings,
          errors: [],
          contentHash: normalized.contentHash,
          lastSuccessAt: now,
        },
      };
    },
    { timeout: 30_000 },
  );
}

export async function rebuildManualRuleSet(id: string): Promise<RuleSetRefreshResult> {
  return (await mutateManualRuleSet(id, async () => undefined)).result;
}

export async function testRemoteRuleSet(
  sourceUrl: string,
  format: RuleSetFormat | 'AUTO',
  fetchOptions: RemoteFetchOptions = {},
): Promise<RuleSetRefreshResult & { sample: RuleSetRule[] }> {
  const fetched = await fetchRemoteRuleSet(sourceUrl, {
    maxBytes: config.RULE_SET_MAX_BYTES,
    timeoutMs: config.RULE_SET_FETCH_TIMEOUT_MS,
    maxRedirects: config.RULE_SET_MAX_REDIRECTS,
    allowHttp: config.RULE_SET_ALLOW_HTTP,
    ...fetchOptions,
  });
  if (fetched.status !== 200 || fetched.content === null) {
    throw new AppError('RULE_SET_FETCH_FAILED', 'Test source returned no content', 422);
  }
  const normalized = validateParsed(fetched.content, format === 'AUTO' ? undefined : format);
  return {
    status: normalized.rules.length ? 'READY' : 'EMPTY',
    changed: true,
    ruleCount: normalized.rules.length,
    warnings: [...normalized.parseWarnings, ...normalized.warnings],
    errors: [],
    contentHash: normalized.contentHash,
    lastSuccessAt: null,
    sample: normalized.rules.slice(0, 50),
  };
}
