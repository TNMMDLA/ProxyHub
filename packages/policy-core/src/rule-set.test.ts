import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { describe, expect, it } from 'vitest';
import inputJson from './test-fixtures/basic-routing.input.json';
import { compilePolicy, normalizePolicyInput } from './index.js';
import type { PolicyCompileInput } from './types.js';

function fixture(
  status: 'READY' | 'STALE' | 'EMPTY' | 'ERROR' | 'DISABLED' = 'READY',
): PolicyCompileInput {
  const input = structuredClone(inputJson) as PolicyCompileInput;
  input.rules.splice(1, 0, {
    id: 'rule-openai',
    name: 'OpenAI applications',
    description: '',
    enabled: true,
    priority: 15,
    matchSourceType: 'RULE_SET',
    matchType: 'DOMAIN',
    matchValue: '',
    ruleSetId: 'ruleset-openai',
    ruleSetName: 'OpenAI',
    actionType: 'DIRECT',
    nodePoolId: null,
  });
  input.ruleSets = [
    {
      id: 'ruleset-openai',
      name: 'OpenAI',
      enabled: status !== 'DISABLED',
      sourceType: 'REMOTE',
      status,
      entries:
        status === 'EMPTY' || status === 'ERROR'
          ? []
          : [
              { type: 'DOMAIN_SUFFIX', value: 'openai.com', order: 0 },
              { type: 'DOMAIN_SUFFIX', value: 'chatgpt.com', order: 1 },
            ],
    },
  ];
  return input;
}

describe('policy rule set resolution', () => {
  it('expands at the PolicyRule position and preserves internal order', () => {
    const rules = normalizePolicyInput(fixture()).rules;
    expect(rules.map((rule) => rule.matchValue)).toEqual([
      'example.com',
      'openai.com',
      'chatgpt.com',
      'ads.example.com',
    ]);
  });

  it('compiles stale Last Known Good content with one warning', () => {
    const result = compilePolicy(fixture('STALE'), 'mihomo');
    expect(result.success).toBe(true);
    expect(result.output).toContain('DOMAIN-SUFFIX,openai.com,DIRECT');
    expect(result.warnings).toContainEqual(
      expect.objectContaining({
        code: 'RULE_SET_STALE',
        ruleSetId: 'ruleset-openai',
        ruleSetName: 'OpenAI',
      }),
    );
  });

  it.each(['DISABLED', 'ERROR'] as const)('blocks an unavailable %s rule set', (status) => {
    const result = compilePolicy(fixture(status), 'mihomo');
    expect(result.success).toBe(false);
    expect(result.errors[0]?.code).toBe(
      status === 'DISABLED' ? 'RULE_SET_DISABLED' : 'RULE_SET_UNAVAILABLE',
    );
  });

  it('allows an empty rule set with an explicit warning', () => {
    const result = compilePolicy(fixture('EMPTY'), 'mihomo');
    expect(result.success).toBe(true);
    expect(result.warnings).toContainEqual(expect.objectContaining({ code: 'RULE_SET_EMPTY' }));
  });

  it('keeps all adapters deterministic over 100 runs', () => {
    for (const format of ['mihomo', 'sing-box', 'raw'] as const) {
      const hashes = Array.from({ length: 100 }, () =>
        createHash('sha256').update(compilePolicy(fixture(), format).output).digest('hex'),
      );
      expect(new Set(hashes).size).toBe(1);
    }
  });

  it('does not change Raw VLESS URI order or encoding', () => {
    const withRuleSet = compilePolicy(fixture(), 'raw').output;
    const withoutRuleSet = structuredClone(inputJson) as PolicyCompileInput;
    expect(withRuleSet).toBe(compilePolicy(withoutRuleSet, 'raw').output);
  });

  it('resolves and compiles 10,000 rules without quadratic behavior', () => {
    const input = fixture();
    input.ruleSets![0]!.entries = Array.from({ length: 10_000 }, (_, order) => ({
      type: 'DOMAIN_SUFFIX',
      value: `service-${String(order)}.example.com`,
      order,
    }));
    const started = performance.now();
    const result = compilePolicy(input, 'mihomo');
    expect(result.success).toBe(true);
    expect(result.metadata.expandedRuleCount).toBe(10_002);
    expect(performance.now() - started).toBeLessThan(10_000);
  });
});
