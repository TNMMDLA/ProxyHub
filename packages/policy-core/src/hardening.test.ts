import { parse as parseYaml } from 'yaml';
import { describe, expect, it } from 'vitest';
import inputJson from './test-fixtures/basic-routing.input.json';
import { ADAPTER_METADATA, CAPABILITIES, compilePolicy, normalizePolicyInput } from './index.js';
import type { CompilerRule, PolicyCompileInput, PolicyMatchType } from './types.js';

function fixture(): PolicyCompileInput {
  return structuredClone(inputJson) as PolicyCompileInput;
}

const validValues: Record<PolicyMatchType, string> = {
  DOMAIN: 'example.com',
  DOMAIN_SUFFIX: '.example.com',
  DOMAIN_KEYWORD: 'example',
  DOMAIN_REGEX: '^example\\.(com|net)$',
  IP_CIDR: '10.0.0.0/8',
  IP_CIDR6: '2001:db8::/32',
  GEOIP: 'CN',
  GEOSITE: 'google',
  DST_PORT: '443-8443',
  NETWORK: 'TCP',
};

function directRule(matchType: PolicyMatchType, matchValue = validValues[matchType]): CompilerRule {
  return {
    id: `rule-${matchType.toLowerCase()}`,
    name: `${matchType} rule`,
    description: '',
    enabled: true,
    priority: 10,
    matchType,
    matchValue,
    actionType: 'DIRECT',
    nodePoolId: null,
  };
}

describe('golden scenario coverage', () => {
  it('covers basic node-pool routing', () => {
    expect(compilePolicy(fixture(), 'mihomo').output).toContain('DOMAIN,example.com,Primary Pool');
  });

  it('covers DIRECT and REJECT rules', () => {
    const input = fixture();
    input.rules = [directRule('DOMAIN'), { ...directRule('DOMAIN_SUFFIX'), actionType: 'REJECT' }];
    const output = compilePolicy(input, 'mihomo').output;
    expect(output).toContain('DOMAIN,example.com,DIRECT');
    expect(output).toContain('DOMAIN-SUFFIX,.example.com,REJECT');
  });

  it('covers multiple nodes and multiple pools', () => {
    const input = fixture();
    input.nodePools.push({
      id: 'pool-secondary',
      name: 'Secondary Pool',
      enabled: true,
      strategy: 'FALLBACK',
      members: [{ nodeId: 'node-amsterdam', priority: 0 }],
    });
    input.rules.push({
      ...directRule('DOMAIN_KEYWORD'),
      id: 'rule-secondary',
      priority: 5,
      actionType: 'NODE_POOL',
      nodePoolId: 'pool-secondary',
    });
    const output = compilePolicy(input, 'mihomo').output;
    expect(output).toContain('Secondary Pool');
    expect(output).toContain('Amsterdam');
  });

  it('excludes disabled nodes', () => {
    const input = fixture();
    input.nodes[0]!.enabled = false;
    const normalized = normalizePolicyInput(input);
    expect(normalized.nodes.map((node) => node.id)).not.toContain('node-tokyo');
  });

  it('retains an enabled but temporarily offline node', () => {
    expect(compilePolicy(fixture(), 'raw').output).toContain('@tokyo.example.com');
  });

  it('excludes disabled rules', () => {
    const input = fixture();
    input.rules[0]!.enabled = false;
    expect(compilePolicy(input, 'mihomo').output).not.toContain('ads.example.com');
  });

  it('preserves First Match Wins priority ordering', () => {
    const rules = normalizePolicyInput(fixture()).rules;
    expect(rules.map((rule) => rule.id)).toEqual(['rule-pool', 'rule-reject']);
  });

  it.each(['DIRECT', 'REJECT'] as const)('covers a %s default action', (defaultAction) => {
    const input = fixture();
    input.policy.defaultAction = defaultAction;
    input.policy.defaultNodePoolId = null;
    expect(compilePolicy(input, 'mihomo').output).toContain(`MATCH,${defaultAction}`);
  });

  it('covers a NODE_POOL default action', () => {
    const input = fixture();
    input.rules = [];
    input.policy.defaultAction = 'NODE_POOL';
    input.policy.defaultNodePoolId = 'pool-primary';
    expect(compilePolicy(input, 'mihomo').output).toContain('MATCH,Primary Pool');
  });

  it('reports a fixed diagnostic for an empty pool', () => {
    const input = fixture();
    input.nodes.forEach((node) => (node.enabled = false));
    expect(compilePolicy(input, 'mihomo').errors).toContainEqual(
      expect.objectContaining({ code: 'NODE_POOL_EMPTY', severity: 'ERROR', adapter: 'mihomo' }),
    );
  });

  it('reports a fixed diagnostic for a missing pool', () => {
    const input = fixture();
    input.nodePools = [];
    expect(compilePolicy(input, 'mihomo').errors).toContainEqual(
      expect.objectContaining({ code: 'POLICY_NODE_POOL_MISSING', severity: 'ERROR' }),
    );
  });

  it('includes rule identity on unsupported-rule diagnostics', () => {
    const input = fixture();
    input.rules = [directRule('GEOSITE')];
    expect(compilePolicy(input, 'sing-box').warnings[0]).toMatchObject({
      code: 'POLICY_RULE_UNSUPPORTED',
      severity: 'WARNING',
      adapter: 'sing-box',
      ruleId: 'rule-geosite',
      ruleName: 'GEOSITE rule',
      ruleType: 'GEOSITE',
    });
  });

  it('escapes YAML and JSON special characters without structural injection', () => {
    const input = fixture();
    const special = 'Edge: # " \' line\nUnicode 😀';
    input.nodes[0]!.name = special;
    input.nodePools[0]!.name = special;
    input.rules = [
      {
        ...directRule('DOMAIN_KEYWORD', 'needle\nrules:\n  - MATCH,REJECT'),
        name: special,
        actionType: 'NODE_POOL',
        nodePoolId: 'pool-primary',
      },
    ];
    const yaml = parseYaml(compilePolicy(input, 'mihomo').output) as {
      proxies: Array<{ name: string }>;
      'proxy-groups': Array<{ name: string }>;
      rules: string[];
    };
    const json = JSON.parse(compilePolicy(input, 'sing-box').output) as {
      outbounds: Array<{ tag: string }>;
      route: { rules: Array<{ domain_keyword: string[]; outbound: string }> };
    };
    expect(yaml.proxies.some((proxy) => proxy.name.startsWith(special))).toBe(true);
    expect(yaml['proxy-groups'][0]!.name).toBe(special);
    expect(yaml.rules).toHaveLength(2);
    expect(json.outbounds.some((outbound) => outbound.tag.startsWith(special))).toBe(true);
    expect(json.route.rules[0]!.domain_keyword[0]).toContain('rules:');
    expect(json.route.rules[0]!.outbound).toBe(special);
  });
});

describe('adapter capability matrix', () => {
  const rows = (['mihomo', 'sing-box', 'raw'] as const).flatMap((format) =>
    (Object.keys(validValues) as PolicyMatchType[]).map(
      (matchType) => [format, matchType] as const,
    ),
  );

  it.each(rows)('%s capability for %s matches emitted diagnostics', (format, matchType) => {
    const input = fixture();
    input.rules = [directRule(matchType)];
    const result = compilePolicy(input, format);
    const supported = CAPABILITIES[format].ruleTypes.has(matchType);
    expect(result.warnings.some((warning) => warning.code === 'POLICY_RULE_UNSUPPORTED')).toBe(
      !supported,
    );
    expect(result.metadata.adapter.capabilities.ruleTypes.includes(matchType)).toBe(supported);
  });

  it.each(['mihomo', 'sing-box', 'raw'] as const)(
    '%s metadata is versioned and explicit',
    (format) => {
      expect(ADAPTER_METADATA[format]).toMatchObject({
        adapterName: format,
        adapterVersion: '1.0.0',
        capabilities: { routing: format !== 'raw' },
      });
    },
  );
});

describe('rule boundary and fuzz-style validation', () => {
  const invalidCases: Array<[string, PolicyMatchType, string]> = [
    ['empty domain', 'DOMAIN', ''],
    ['malformed domain', 'DOMAIN', 'bad domain'],
    ['empty keyword', 'DOMAIN_KEYWORD', '   '],
    ['invalid IPv4 prefix', 'IP_CIDR', '10.0.0.0/33'],
    ['invalid IPv4 address', 'IP_CIDR', '10.0.0.999/24'],
    ['invalid IPv6 prefix', 'IP_CIDR6', '2001:db8::/129'],
    ['invalid IPv6 address', 'IP_CIDR6', '2001:::1/64'],
    ['zero port', 'DST_PORT', '0'],
    ['oversized port', 'DST_PORT', '65536'],
    ['reversed port range', 'DST_PORT', '8443-443'],
    ['invalid network', 'NETWORK', 'ICMP'],
    ['empty geo value', 'GEOIP', ''],
    ['leading whitespace', 'DOMAIN', ' example.com'],
    ['trailing whitespace', 'DOMAIN_SUFFIX', 'example.com '],
    ['overlong match value', 'DOMAIN_KEYWORD', 'a'.repeat(1001)],
  ];

  it.each(invalidCases)('rejects %s', (_name, matchType, matchValue) => {
    const input = fixture();
    input.rules = [directRule(matchType, matchValue)];
    expect(compilePolicy(input, 'mihomo').errors).toContainEqual(
      expect.objectContaining({
        code: 'POLICY_RULE_INVALID',
        severity: 'ERROR',
        ruleType: matchType,
      }),
    );
  });

  it('rejects an overlong rule name', () => {
    const input = fixture();
    input.rules = [{ ...directRule('DOMAIN'), name: 'n'.repeat(101) }];
    expect(compilePolicy(input, 'mihomo').success).toBe(false);
  });

  it('accepts the valid CIDR and port boundaries', () => {
    for (const [matchType, value] of [
      ['IP_CIDR', '0.0.0.0/0'],
      ['IP_CIDR', '255.255.255.255/32'],
      ['IP_CIDR6', '::/0'],
      ['IP_CIDR6', 'ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff/128'],
      ['DST_PORT', '1'],
      ['DST_PORT', '65535'],
      ['DST_PORT', '1-65535'],
    ] as const) {
      const input = fixture();
      input.rules = [directRule(matchType, value)];
      expect(compilePolicy(input, 'mihomo').success, `${matchType}:${value}`).toBe(true);
    }
  });

  it('emits empty Mihomo collections as arrays instead of null YAML values', () => {
    const input = fixture();
    input.rules = [];
    input.nodes = [];
    input.nodePools = [];
    const parsed = parseYaml(compilePolicy(input, 'mihomo').output) as {
      proxies: unknown[];
      'proxy-groups': unknown[];
    };
    expect(parsed.proxies).toEqual([]);
    expect(parsed['proxy-groups']).toEqual([]);
  });
});
