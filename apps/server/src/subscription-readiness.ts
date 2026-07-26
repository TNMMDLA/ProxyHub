import { performance } from 'node:perf_hooks';
import { CAPABILITIES, type CompilerFormat } from '@proxyhub/policy-core';
import type {
  CompileStage,
  SubscriptionReadinessCheck,
  SubscriptionReadinessResult,
} from '@proxyhub/shared';
import { prisma } from './db.js';
import { compileStoredPolicy } from './policy-service.js';

export interface SubscriptionCandidate {
  id?: string;
  policyId: string;
  format: CompilerFormat;
  enabled: boolean;
  expiresAt: Date | string | null;
}

const readinessCache = new Map<
  string,
  { expiresAt: number; result: SubscriptionReadinessResult }
>();
const CACHE_TTL_MS = 30_000;
const COMPILE_TIMEOUT_MS = 10_000;
let activeCompiles = 0;
const waiting: Array<() => void> = [];

function releaseCompileSlot(): void {
  activeCompiles -= 1;
  waiting.shift()?.();
}

async function withCompileSlot<T>(operation: () => Promise<T>): Promise<T> {
  if (activeCompiles >= 2) await new Promise<void>((resolve) => waiting.push(resolve));
  activeCompiles += 1;
  const running = Promise.resolve().then(operation);
  let timedOut = false;
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      running,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          timedOut = true;
          reject(new Error('SUBSCRIPTION_COMPILE_TIMEOUT'));
        }, COMPILE_TIMEOUT_MS);
        timeout.unref?.();
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
    if (timedOut) {
      void running.then(releaseCompileSlot, releaseCompileSlot);
    } else {
      releaseCompileSlot();
    }
  }
}

function check(
  id: string,
  status: SubscriptionReadinessCheck['status'],
  stage: CompileStage,
  options: Partial<SubscriptionReadinessCheck> = {},
): SubscriptionReadinessCheck {
  const translationId = id.startsWith('node-pool-available-')
    ? 'node-pool-available'
    : id.startsWith('node-pool-')
      ? 'node-pool'
      : id.startsWith('rule-set-')
        ? 'rule-set'
        : id.startsWith('compiler-')
          ? 'compiler-diagnostic'
          : id;
  return {
    id,
    status,
    stage,
    titleCode: `readiness.checks.${translationId}`,
    summaryCode: `readiness.status.${status.toLowerCase()}`,
    recommendations: [],
    blocking: status === 'FAILED',
    ...options,
  };
}

function resultFrom(
  candidate: SubscriptionCandidate,
  checks: SubscriptionReadinessCheck[],
  startedAt: number,
): SubscriptionReadinessResult {
  const blockingCount = checks.filter((item) => item.blocking && item.status === 'FAILED').length;
  const warningCount = checks.filter((item) => item.status === 'WARNING').length;
  return {
    status: blockingCount > 0 ? 'BLOCKED' : warningCount > 0 ? 'READY_WITH_WARNINGS' : 'READY',
    ...(candidate.id ? { subscriptionId: candidate.id } : {}),
    format: candidate.format,
    checks,
    blockingCount,
    warningCount,
    checkedAt: new Date().toISOString(),
    durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
  };
}

function compilerStage(code: string): CompileStage {
  if (code.startsWith('RULE_SET_')) return 'RULE_SET_RESOLUTION';
  if (code.includes('NODE') || code.includes('POOL')) return 'NODE_RESOLUTION';
  if (code.includes('UNSUPPORTED')) return 'CAPABILITY_CHECK';
  if (code.includes('POLICY')) return 'POLICY_VALIDATION';
  return 'COMPILER';
}

export function getCachedReadiness(subscriptionId: string): SubscriptionReadinessResult | null {
  const cached = readinessCache.get(subscriptionId);
  if (!cached || cached.expiresAt <= Date.now()) {
    readinessCache.delete(subscriptionId);
    return null;
  }
  return cached.result;
}

export function invalidateReadiness(subscriptionId?: string): void {
  if (subscriptionId) readinessCache.delete(subscriptionId);
  else readinessCache.clear();
}

export async function runSubscriptionReadiness(
  candidate: SubscriptionCandidate,
  options: { cache?: boolean } = {},
): Promise<SubscriptionReadinessResult> {
  const startedAt = performance.now();
  if (candidate.id && options.cache) {
    const cached = getCachedReadiness(candidate.id);
    if (cached) return cached;
  }

  const checks: SubscriptionReadinessCheck[] = [];
  checks.push(
    check('subscription-enabled', candidate.enabled ? 'PASSED' : 'FAILED', 'POLICY_VALIDATION', {
      errorCode: candidate.enabled ? undefined : 'SUBSCRIPTION_DISABLED',
      resourceType: 'SUBSCRIPTION',
      resourceId: candidate.id,
      recommendations: candidate.enabled ? [] : ['ENABLE_SUBSCRIPTION'],
    }),
  );
  const expiresAt = candidate.expiresAt ? new Date(candidate.expiresAt) : null;
  const expired = Boolean(expiresAt && expiresAt <= new Date());
  checks.push(
    check('subscription-not-expired', expired ? 'FAILED' : 'PASSED', 'POLICY_VALIDATION', {
      errorCode: expired ? 'SUBSCRIPTION_EXPIRED' : undefined,
      resourceType: 'SUBSCRIPTION',
      resourceId: candidate.id,
      field: 'expiresAt',
      recommendations: expired ? ['UPDATE_SUBSCRIPTION_EXPIRY'] : [],
    }),
  );
  if (candidate.id) {
    const tokenState = await prisma.subscription.findUnique({
      where: { id: candidate.id },
      select: { tokenHash: true, tokenPrefix: true },
    });
    const tokenValid = Boolean(tokenState?.tokenHash && tokenState.tokenPrefix.length === 8);
    checks.push(
      check('token-state', tokenValid ? 'PASSED' : 'FAILED', 'DEPENDENCY_RESOLUTION', {
        errorCode: tokenValid ? undefined : 'SUBSCRIPTION_TOKEN_INVALID',
        resourceType: 'SUBSCRIPTION',
        resourceId: candidate.id,
        recommendations: tokenValid ? [] : ['ROTATE_SUBSCRIPTION_TOKEN'],
      }),
    );
  }
  checks.push(
    check('cache-state', 'UNKNOWN', 'OUTPUT_VALIDATION', {
      summaryCode: 'readiness.cacheOnDemand',
      recommendations: [],
    }),
  );

  const policy = await prisma.policy.findUnique({
    where: { id: candidate.policyId },
    include: {
      rules: { include: { ruleSet: { include: { cache: true } }, nodePool: true } },
      defaultNodePool: true,
    },
  });
  checks.push(
    check('policy-exists', policy ? 'PASSED' : 'FAILED', 'DEPENDENCY_RESOLUTION', {
      errorCode: policy ? undefined : 'POLICY_NOT_FOUND',
      resourceType: 'POLICY',
      resourceId: candidate.policyId,
      recommendations: policy ? [] : ['SELECT_EXISTING_POLICY'],
    }),
  );
  if (!policy) return resultFrom(candidate, checks, startedAt);

  checks.push(
    check('policy-enabled', policy.enabled ? 'PASSED' : 'FAILED', 'POLICY_VALIDATION', {
      errorCode: policy.enabled ? undefined : 'POLICY_DISABLED',
      resourceType: 'POLICY',
      resourceId: policy.id,
      resourceName: policy.name,
      field: 'enabled',
      recommendations: policy.enabled ? [] : ['ENABLE_POLICY'],
    }),
  );
  const finalValid = policy.defaultAction !== 'NODE_POOL' || Boolean(policy.defaultNodePoolId);
  checks.push(
    check('policy-final-behavior', finalValid ? 'PASSED' : 'FAILED', 'POLICY_VALIDATION', {
      errorCode: finalValid ? undefined : 'POLICY_FINAL_NODE_POOL_MISSING',
      resourceType: 'POLICY',
      resourceId: policy.id,
      resourceName: policy.name,
      field: 'defaultNodePoolId',
      recommendations: finalValid ? [] : ['CONFIGURE_POLICY_FINAL_BEHAVIOR'],
    }),
  );

  const poolIds = new Set<string>();
  if (policy.defaultAction === 'NODE_POOL' && policy.defaultNodePoolId) {
    poolIds.add(policy.defaultNodePoolId);
  }
  for (const rule of policy.rules) {
    if (rule.enabled && rule.actionType === 'NODE_POOL' && rule.nodePoolId) {
      poolIds.add(rule.nodePoolId);
    }
  }
  const pools = await prisma.nodePool.findMany({
    where: { id: { in: [...poolIds] } },
    include: { members: { include: { node: true } } },
  });
  const poolById = new Map(pools.map((pool) => [pool.id, pool]));
  for (const poolId of poolIds) {
    const pool = poolById.get(poolId);
    checks.push(
      check(`node-pool-${poolId}`, pool ? 'PASSED' : 'FAILED', 'DEPENDENCY_RESOLUTION', {
        errorCode: pool ? undefined : 'NODE_POOL_MISSING',
        resourceType: 'NODE_POOL',
        resourceId: poolId,
        resourceName: pool?.name,
        recommendations: pool ? [] : ['SELECT_EXISTING_NODE_POOL'],
      }),
    );
    if (!pool) continue;
    const enabledNodes = pool.members.filter((member) => member.node.enabled);
    checks.push(
      check(
        `node-pool-available-${poolId}`,
        !pool.enabled || enabledNodes.length === 0 ? 'FAILED' : 'PASSED',
        'NODE_RESOLUTION',
        {
          errorCode: !pool.enabled
            ? 'NODE_POOL_DISABLED'
            : enabledNodes.length === 0
              ? 'NODE_POOL_EMPTY'
              : undefined,
          resourceType: 'NODE_POOL',
          resourceId: pool.id,
          resourceName: pool.name,
          recommendations:
            !pool.enabled || enabledNodes.length === 0 ? ['ADD_ENABLED_NODE_TO_POOL'] : [],
        },
      ),
    );
  }

  for (const rule of policy.rules.filter(
    (item) => item.enabled && item.matchSourceType === 'RULE_SET',
  )) {
    const ruleSet = rule.ruleSet;
    if (!ruleSet) {
      checks.push(
        check(`rule-set-${rule.id}`, 'FAILED', 'RULE_SET_RESOLUTION', {
          errorCode: 'RULE_SET_MISSING',
          resourceType: 'POLICY_RULE',
          resourceId: rule.id,
          resourceName: rule.name,
          field: 'ruleSetId',
          recommendations: ['SELECT_EXISTING_RULE_SET'],
        }),
      );
      continue;
    }
    const hasLastKnownGood = Boolean(ruleSet.cache?.normalizedContent);
    const failed =
      !ruleSet.enabled ||
      ruleSet.status === 'EMPTY' ||
      (!hasLastKnownGood && ruleSet.status === 'ERROR');
    const warning = hasLastKnownGood && (ruleSet.status === 'STALE' || ruleSet.status === 'ERROR');
    checks.push(
      check(
        `rule-set-${ruleSet.id}`,
        failed ? 'FAILED' : warning ? 'WARNING' : 'PASSED',
        'RULE_SET_RESOLUTION',
        {
          errorCode: failed
            ? !ruleSet.enabled
              ? 'RULE_SET_DISABLED'
              : 'RULE_SET_UNAVAILABLE'
            : warning
              ? 'RULE_SET_LAST_KNOWN_GOOD'
              : undefined,
          resourceType: 'RULE_SET',
          resourceId: ruleSet.id,
          resourceName: ruleSet.name,
          recommendations: failed || warning ? ['REVIEW_RULE_SET'] : [],
        },
      ),
    );
  }

  const capability = CAPABILITIES[candidate.format];
  checks.push(
    check('format-capability', capability ? 'PASSED' : 'FAILED', 'CAPABILITY_CHECK', {
      errorCode: capability ? undefined : 'SUBSCRIPTION_FORMAT_UNSUPPORTED',
      field: 'format',
      recommendations: capability ? [] : ['SELECT_SUPPORTED_FORMAT'],
    }),
  );

  if (!checks.some((item) => item.blocking && item.status === 'FAILED')) {
    try {
      const { result } = await withCompileSlot(() =>
        compileStoredPolicy(policy.id, candidate.format),
      );
      for (const diagnostic of result.errors) {
        checks.push(
          check(
            `compiler-${diagnostic.code}-${checks.length}`,
            'FAILED',
            compilerStage(diagnostic.code),
            {
              errorCode: diagnostic.code,
              resourceType: diagnostic.ruleSetId
                ? 'RULE_SET'
                : diagnostic.ruleId
                  ? 'POLICY_RULE'
                  : 'POLICY',
              resourceId: diagnostic.ruleSetId ?? diagnostic.ruleId ?? policy.id,
              resourceName: diagnostic.ruleSetName ?? diagnostic.ruleName ?? policy.name,
              recommendations: ['REVIEW_COMPILER_DIAGNOSTIC'],
            },
          ),
        );
      }
      for (const diagnostic of result.warnings) {
        checks.push(
          check(
            `compiler-${diagnostic.code}-${checks.length}`,
            'WARNING',
            compilerStage(diagnostic.code),
            {
              errorCode: diagnostic.code,
              resourceType: diagnostic.ruleSetId
                ? 'RULE_SET'
                : diagnostic.ruleId
                  ? 'POLICY_RULE'
                  : 'POLICY',
              resourceId: diagnostic.ruleSetId ?? diagnostic.ruleId ?? policy.id,
              resourceName: diagnostic.ruleSetName ?? diagnostic.ruleName ?? policy.name,
              recommendations: ['REVIEW_COMPILER_DIAGNOSTIC'],
            },
          ),
        );
      }
      checks.push(
        check('compile-dry-run', result.success ? 'PASSED' : 'FAILED', 'OUTPUT_VALIDATION', {
          errorCode: result.success ? undefined : 'SUBSCRIPTION_COMPILE_FAILED',
          recommendations: result.success ? [] : ['OPEN_SUBSCRIPTION_DIAGNOSTICS'],
        }),
      );
    } catch (error) {
      checks.push(
        check('compile-dry-run', 'FAILED', 'COMPILER', {
          errorCode:
            error instanceof Error && error.message === 'SUBSCRIPTION_COMPILE_TIMEOUT'
              ? 'SUBSCRIPTION_COMPILE_TIMEOUT'
              : 'SUBSCRIPTION_COMPILE_FAILED',
          recommendations: ['OPEN_SUBSCRIPTION_DIAGNOSTICS'],
        }),
      );
    }
  }

  const result = resultFrom(candidate, checks, startedAt);
  if (candidate.id && options.cache) {
    readinessCache.set(candidate.id, { expiresAt: Date.now() + CACHE_TTL_MS, result });
  }
  return result;
}
