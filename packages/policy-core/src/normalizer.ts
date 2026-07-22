import type { NormalizedPolicyInput, PolicyCompileInput } from './types.js';

export function normalizePolicyInput(input: PolicyCompileInput): NormalizedPolicyInput {
  const nodes = [...input.nodes.filter((node) => node.enabled)].sort(
    (left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id),
  );
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const rules = [...input.rules.filter((rule) => rule.enabled)].sort(
    (left, right) => left.priority - right.priority || left.id.localeCompare(right.id),
  );
  const nodePools = input.nodePools
    .map((pool) => ({
      ...pool,
      members: [...pool.members.filter((member) => nodeById.has(member.nodeId))].sort(
        (left, right) => left.priority - right.priority || left.nodeId.localeCompare(right.nodeId),
      ),
    }))
    .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
  return {
    policy: { ...input.policy },
    rules,
    nodes,
    nodePools,
    nodeById,
    poolById: new Map(nodePools.map((pool) => [pool.id, pool])),
  };
}
