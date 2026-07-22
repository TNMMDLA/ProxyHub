import { compilePolicy } from '@proxyhub/policy-core';
import type {
  CompilerFormat,
  CompilerNode,
  PolicyActionType,
  PolicyCompileInput,
  PolicyMatchType,
} from '@proxyhub/policy-core';
import { createVlessUri } from '@proxyhub/xray-manager';
import { prisma } from './db.js';
import { AppError } from './errors.js';

export async function loadPolicyCompileInput(policyId: string): Promise<PolicyCompileInput> {
  const [policy, nodes, nodePools] = await Promise.all([
    prisma.policy.findUnique({ where: { id: policyId }, include: { rules: true } }),
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
  };
}

export async function compileStoredPolicy(policyId: string, format: CompilerFormat) {
  const input = await loadPolicyCompileInput(policyId);
  return { input, result: compilePolicy(input, format) };
}

export function maskCompilerOutput(output: string, nodes: CompilerNode[]): string {
  return nodes.reduce((masked, node) => masked.split(node.uuid).join('[REDACTED-UUID]'), output);
}
