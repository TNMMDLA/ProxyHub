import { compilePolicy } from '@proxyhub/policy-core';
import type {
  CompilerFormat,
  CompilerNode,
  CompilerRuleSet,
  PolicyActionType,
  PolicyCompileInput,
  PolicyMatchType,
} from '@proxyhub/policy-core';
import { createVlessUri } from '@proxyhub/xray-manager';
import { prisma } from './db.js';
import { AppError } from './errors.js';

export async function loadPolicyCompileInput(policyId: string): Promise<PolicyCompileInput> {
  const [policy, nodes, nodePools] = await Promise.all([
    prisma.policy.findUnique({
      where: { id: policyId },
      include: {
        rules: {
          include: {
            ruleSet: { include: { cache: true } },
          },
        },
      },
    }),
    prisma.node.findMany(),
    prisma.nodePool.findMany({ include: { members: true } }),
  ]);
  if (!policy) throw new AppError('POLICY_NOT_FOUND', 'Policy not found', 404);
  const compilerNodes: CompilerNode[] = nodes.map((node) => ({
    id: node.id,
    name: node.name,
    host: node.host,
    port: node.port,
    uuid: node.uuid,
    flow: node.flow,
    sni: node.sni,
    fingerprint: node.fingerprint,
    realityPublicKey: node.realityPublicKey,
    shortId: node.shortId,
    enabled: node.enabled,
    status: node.status,
    uri: createVlessUri(node),
  }));
  const compilerRuleSets = new Map<string, CompilerRuleSet>();
  for (const rule of policy.rules) {
    if (!rule.ruleSet || compilerRuleSets.has(rule.ruleSet.id)) continue;
    let entries: Array<{ type: PolicyMatchType; value: string; order: number }> = [];
    try {
      const normalized = JSON.parse(rule.ruleSet.cache?.normalizedContent ?? '[]') as Array<{
        type: PolicyMatchType;
        value: string;
      }>;
      entries = normalized.map((entry, order) => ({ ...entry, order }));
    } catch {
      entries = [];
    }
    compilerRuleSets.set(rule.ruleSet.id, {
      id: rule.ruleSet.id,
      name: rule.ruleSet.name,
      enabled: rule.ruleSet.enabled,
      sourceType: rule.ruleSet.sourceType as CompilerRuleSet['sourceType'],
      status: rule.ruleSet.status as CompilerRuleSet['status'],
      entries,
    });
  }
  return {
    policy: {
      id: policy.id,
      name: policy.name,
      description: policy.description,
      enabled: policy.enabled,
      revision: policy.revision,
      defaultAction: policy.defaultAction as PolicyActionType,
      defaultNodePoolId: policy.defaultNodePoolId,
    },
    rules: policy.rules.map((rule) => ({
      id: rule.id,
      name: rule.name,
      description: rule.description,
      enabled: rule.enabled,
      priority: rule.priority,
      matchType: rule.matchType as PolicyMatchType,
      matchValue: rule.matchValue,
      actionType: rule.actionType as PolicyActionType,
      nodePoolId: rule.nodePoolId,
      matchSourceType: rule.matchSourceType as 'INLINE' | 'RULE_SET',
      ruleSetId: rule.ruleSetId,
      ruleSetName: rule.ruleSet?.name ?? null,
    })),
    nodes: compilerNodes,
    nodePools: nodePools.map((pool) => ({
      id: pool.id,
      name: pool.name,
      enabled: pool.enabled,
      strategy: pool.strategy,
      members: pool.members.map((member) => ({
        nodeId: member.nodeId,
        priority: member.priority,
      })),
    })),
    ruleSets: [...compilerRuleSets.values()],
  };
}

export async function compileStoredPolicy(policyId: string, format: CompilerFormat) {
  const input = await loadPolicyCompileInput(policyId);
  return { input, result: compilePolicy(input, format) };
}

export function maskCompilerOutput(output: string, nodes: CompilerNode[]): string {
  return nodes.reduce((masked, node) => masked.split(node.uuid).join('[REDACTED-UUID]'), output);
}
