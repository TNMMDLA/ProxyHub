import { describe, expect, it } from 'vitest';
import { compilePolicy, normalizePolicyInput } from './index.js';
import type { PolicyCompileInput } from './types.js';

function fixture(): PolicyCompileInput {
  return {
    policy: {
      id: 'policy-1',
      name: 'Default Policy',
      description: '',
      enabled: true,
      revision: 3,
      defaultAction: 'DIRECT',
      defaultNodePoolId: null,
    },
    rules: [
      {
        id: 'rule-2',
        name: 'Reject ads',
        description: '',
        enabled: true,
        priority: 20,
        matchType: 'DOMAIN_SUFFIX',
        matchValue: 'ads.example.com',
        actionType: 'REJECT',
        nodePoolId: null,
      },
      {
        id: 'rule-1',
        name: 'Route example',
        description: '',
        enabled: true,
        priority: 10,
        matchType: 'DOMAIN',
        matchValue: 'example.com',
        actionType: 'NODE_POOL',
        nodePoolId: 'pool-1',
      },
      {
        id: 'rule-disabled',
        name: 'Disabled',
        description: '',
        enabled: false,
        priority: 1,
        matchType: 'DOMAIN',
        matchValue: 'disabled.example.com',
        actionType: 'REJECT',
        nodePoolId: null,
      },
    ],
    nodes: [
      {
        id: 'node-b',
        name: 'Tokyo',
        host: 'tokyo.example.com',
        port: 443,
        uuid: '11111111-1111-4111-8111-111111111111',
        flow: 'xtls-rprx-vision',
        sni: 'www.microsoft.com',
        fingerprint: 'chrome',
        realityPublicKey: 'public-key',
        shortId: '1234567890abcdef',
        enabled: true,
        status: 'OFFLINE',
        uri: 'vless://tokyo',
      },
      {
        id: 'node-a',
        name: 'Disabled node',
        host: 'disabled.example.com',
        port: 8443,
        uuid: '22222222-2222-4222-8222-222222222222',
        flow: 'xtls-rprx-vision',
        sni: 'www.microsoft.com',
        fingerprint: 'chrome',
        realityPublicKey: 'public-key-2',
        shortId: 'abcdef1234567890',
        enabled: false,
        status: 'HEALTHY',
        uri: 'vless://disabled',
      },
    ],
    nodePools: [
      {
        id: 'pool-1',
        name: 'Primary Pool',
        enabled: true,
        strategy: 'MANUAL',
        members: [
          { nodeId: 'node-b', priority: 1 },
          { nodeId: 'node-a', priority: 0 },
        ],
      },
    ],
  };
}

describe('policy-core', () => {
  it('compiles a valid policy', () => {
    expect(compilePolicy(fixture(), 'mihomo').success).toBe(true);
  });

  it('rejects a disabled policy', () => {
    const input = fixture();
    input.policy.enabled = false;
    expect(compilePolicy(input, 'mihomo').errors[0]?.code).toBe('POLICY_DISABLED');
  });

  it('orders rules by priority and filters disabled rules', () => {
    expect(normalizePolicyInput(fixture()).rules.map((rule) => rule.id)).toEqual([
      'rule-1',
      'rule-2',
    ]);
  });

  it('reports a missing node pool', () => {
    const input = fixture();
    input.nodePools = [];
    expect(
      compilePolicy(input, 'mihomo').errors.some(
        (item) => item.code === 'POLICY_NODE_POOL_MISSING',
      ),
    ).toBe(true);
  });

  it('rejects an empty node pool instead of emitting an invalid group', () => {
    const input = fixture();
    input.nodes[0]!.enabled = false;
    expect(
      compilePolicy(input, 'mihomo').errors.some((item) => item.code === 'NODE_POOL_EMPTY'),
    ).toBe(true);
  });

  it('excludes disabled nodes but retains temporarily offline nodes', () => {
    const output = compilePolicy(fixture(), 'mihomo').output;
    expect(output).toContain('Tokyo');
    expect(output).not.toContain('Disabled node');
  });

  it('warns for duplicate rules', () => {
    const input = fixture();
    input.rules.push({ ...input.rules[0]!, id: 'duplicate', name: 'Duplicate', priority: 30 });
    expect(
      compilePolicy(input, 'mihomo').warnings.some((item) => item.code === 'POLICY_RULE_DUPLICATE'),
    ).toBe(true);
  });

  it('rejects invalid domains', () => {
    const input = fixture();
    input.rules[0]!.matchValue = 'bad domain';
    expect(
      compilePolicy(input, 'mihomo').errors.some((item) => item.code === 'POLICY_RULE_INVALID'),
    ).toBe(true);
  });

  it('rejects invalid CIDR values', () => {
    const input = fixture();
    input.rules[0]!.matchType = 'IP_CIDR';
    input.rules[0]!.matchValue = '10.0.0.999/99';
    expect(compilePolicy(input, 'mihomo').success).toBe(false);
  });

  it('reports unsupported adapter capabilities with rule identity', () => {
    const input = fixture();
    input.rules[0]!.matchType = 'GEOSITE';
    input.rules[0]!.matchValue = 'google';
    const warning = compilePolicy(input, 'sing-box').warnings.find(
      (item) => item.code === 'POLICY_RULE_UNSUPPORTED',
    );
    expect(warning).toMatchObject({
      ruleId: 'rule-2',
      ruleName: 'Reject ads',
      ruleType: 'GEOSITE',
    });
  });

  it('generates Mihomo proxies, groups, rules, and final action', () => {
    const output = compilePolicy(fixture(), 'mihomo').output;
    expect(output).toContain('proxies:');
    expect(output).toContain('proxy-groups:');
    expect(output).toContain('DOMAIN,example.com,Primary Pool');
    expect(output).toContain('MATCH,DIRECT');
  });

  it('generates sing-box outbounds, selectors, route rules, and final action', () => {
    const config = JSON.parse(compilePolicy(fixture(), 'sing-box').output) as {
      outbounds: Array<{ type: string }>;
      route: { rules: unknown[]; final: string };
    };
    expect(config.outbounds.some((outbound) => outbound.type === 'selector')).toBe(true);
    expect(config.route.rules).toHaveLength(2);
    expect(config.route.final).toBe('DIRECT');
  });

  it('generates a stable raw subscription from enabled nodes only', () => {
    const input = fixture();
    input.nodes.push({ ...input.nodes[0]!, id: 'node-c', name: 'Amsterdam', uri: 'vless://ams' });
    expect(compilePolicy(input, 'raw').output).toBe('vless://ams\nvless://tokyo\n');
  });

  it('produces deterministic output for equivalent unordered input', () => {
    const first = fixture();
    const second = fixture();
    second.nodes.reverse();
    second.rules.reverse();
    second.nodePools.reverse();
    expect(compilePolicy(first, 'mihomo').output).toBe(compilePolicy(second, 'mihomo').output);
  });

  it('applies a NODE_POOL default action', () => {
    const input = fixture();
    input.policy.defaultAction = 'NODE_POOL';
    input.policy.defaultNodePoolId = 'pool-1';
    expect(compilePolicy(input, 'mihomo').output).toContain('MATCH,Primary Pool');
  });
});
