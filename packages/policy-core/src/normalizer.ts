import type { NormalizedPolicyInput, PolicyCompileInput } from './types.js';

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function normalizePolicyInput(input: PolicyCompileInput): NormalizedPolicyInput {
  const nodes = [...input.nodes.filter((node) => node.enabled)].sort(
    (left, right) => compareText(left.name, right.name) || compareText(left.id, right.id),
  );
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const rules = [...input.rules.filter((rule) => rule.enabled)].sort(
    (left, right) => left.priority - right.priority || compareText(left.id, right.id),
  );
  const nodePools = input.nodePools
    .map((pool) => ({
      ...pool,
      members: [...pool.members.filter((member) => nodeById.has(member.nodeId))].sort(
        (left, right) => left.priority - right.priority || compareText(left.nodeId, right.nodeId),
      ),
    }))
    .sort((left, right) => compareText(left.name, right.name) || compareText(left.id, right.id));
  return {
    policy: { ...input.policy },
    rules,
    nodes,
    nodePools,
    nodeById,
    poolById: new Map(nodePools.map((pool) => [pool.id, pool])),
  };
}
