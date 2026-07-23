import type {
  CompilerRule,
  NormalizedPolicyInput,
  PolicyCompileInput,
  RuleSetResolutionIssue,
} from './types.js';

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function normalizePolicyInput(input: PolicyCompileInput): NormalizedPolicyInput {
  const nodes = [...input.nodes.filter((node) => node.enabled)].sort(
    (left, right) => compareText(left.name, right.name) || compareText(left.id, right.id),
  );
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const sourceRules = [...input.rules.filter((rule) => rule.enabled)].sort(
    (left, right) => left.priority - right.priority || compareText(left.id, right.id),
  );
  const ruleSetById = new Map((input.ruleSets ?? []).map((ruleSet) => [ruleSet.id, ruleSet]));
  const ruleSetIssues: RuleSetResolutionIssue[] = [];
  const referencedRuleSets = new Set<string>();
  const rules: CompilerRule[] = sourceRules.flatMap((rule) => {
    if ((rule.matchSourceType ?? 'INLINE') !== 'RULE_SET') return [rule];
    const ruleSet = ruleSetById.get(rule.ruleSetId ?? '');
    if (!ruleSet) {
      ruleSetIssues.push({
        code: 'RULE_SET_UNAVAILABLE',
        severity: 'ERROR',
        message: 'Referenced rule set is unavailable.',
        ruleId: rule.id,
        ruleName: rule.name,
        ...(rule.ruleSetId ? { ruleSetId: rule.ruleSetId } : {}),
      });
      return [];
    }
    referencedRuleSets.add(ruleSet.id);
    const identity = {
      ruleId: rule.id,
      ruleName: rule.name,
      ruleSetId: ruleSet.id,
      ruleSetName: ruleSet.name,
      sourceType: ruleSet.sourceType,
    } as const;
    if (!ruleSet.enabled || ruleSet.status === 'DISABLED') {
      ruleSetIssues.push({
        code: 'RULE_SET_DISABLED',
        severity: 'ERROR',
        message: `Rule set "${ruleSet.name}" is disabled.`,
        ...identity,
      });
      return [];
    }
    if (
      ruleSet.status === 'ERROR' ||
      (ruleSet.entries.length === 0 && ruleSet.status !== 'EMPTY')
    ) {
      ruleSetIssues.push({
        code: 'RULE_SET_UNAVAILABLE',
        severity: 'ERROR',
        message: `Rule set "${ruleSet.name}" has no usable cache.`,
        ...identity,
      });
      return [];
    }
    if (ruleSet.status === 'STALE') {
      ruleSetIssues.push({
        code: 'RULE_SET_STALE',
        severity: 'WARNING',
        message: `Rule set "${ruleSet.name}" is using its last known good cache.`,
        ...identity,
      });
    }
    if (ruleSet.entries.length === 0) {
      ruleSetIssues.push({
        code: 'RULE_SET_EMPTY',
        severity: 'WARNING',
        message: `Rule set "${ruleSet.name}" contains no rules.`,
        ...identity,
      });
      return [];
    }
    return [...ruleSet.entries]
      .sort((left, right) => left.order - right.order)
      .map((entry, index) => ({
        ...rule,
        id: `${rule.id}:${String(index)}`,
        name: `${rule.name} / ${ruleSet.name}`,
        matchType: entry.type,
        matchValue: entry.value,
        originRuleId: rule.id,
        ruleSetId: ruleSet.id,
        ruleSetName: ruleSet.name,
        ruleSetSourceType: ruleSet.sourceType,
        entryIndex: index,
      }));
  });
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
    ruleSetIssues,
    referencedRuleSetCount: referencedRuleSets.size,
  };
}
