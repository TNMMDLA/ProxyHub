import type { NormalizedPolicyInput, PolicyActionType } from '../types.js';

export function proxyName(name: string, id: string): string {
  return `${name} [${id.slice(0, 6)}]`;
}

export function actionTarget(
  input: NormalizedPolicyInput,
  action: PolicyActionType,
  nodePoolId: string | null,
): string {
  if (action !== 'NODE_POOL') return action;
  return input.poolById.get(nodePoolId ?? '')?.name ?? 'REJECT';
}

export function yamlString(value: string): string {
  return JSON.stringify(value);
}

export function referencedPoolIds(input: NormalizedPolicyInput): Set<string> {
  const ids = new Set<string>();
  if (input.policy.defaultAction === 'NODE_POOL' && input.policy.defaultNodePoolId) {
    ids.add(input.policy.defaultNodePoolId);
  }
  for (const rule of input.rules) {
    if (rule.actionType === 'NODE_POOL' && rule.nodePoolId) ids.add(rule.nodePoolId);
  }
  return ids;
}
