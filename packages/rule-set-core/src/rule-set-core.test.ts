import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { describe, expect, it } from 'vitest';
import { normalizeRuleSet, parseRuleSet, RULE_SET_PARSERS } from './index.js';
import type { RuleSetFormat, RuleSetRule } from './types.js';

const fixtureUrl = (name: string) => new URL(`./test-fixtures/${name}`, import.meta.url);

const fixtures: Array<{ name: string; format: RuleSetFormat; hash: string }> = [
  {
    name: 'openai',
    format: 'PROXYHUB_NATIVE',
    hash: '6432f29a5eb7ee749ad65717f0458d29a05d2c1400ceee1714595626c6a65a74',
  },
  {
    name: 'china',
    format: 'PLAIN_TEXT',
    hash: 'f761c5ff15e19f9dd25b5500e902944dac6233abf6f75dcaccc09ea0482d0298',
  },
  {
    name: 'advertising',
    format: 'MIHOMO',
    hash: 'f6f9628cbda4beb9e3fc7820873e8c52d7aaa408e20efbe55ffddc3ca94887ad',
  },
  {
    name: 'mixed',
    format: 'PLAIN_TEXT',
    hash: 'b8b7e52bee8db7009aa8808efeef4f4fcb758b9937dcf0f3e3e3d40274d243c6',
  },
];

describe('rule-set parser and normalizer golden fixtures', () => {
  it.each(fixtures)('$name remains byte-for-byte stable', ({ name, format, hash }) => {
    const source = readFileSync(
      fixtureUrl(`${name}.source.${name === 'openai' ? 'json' : 'txt'}`),
      'utf8',
    );
    const expected = `${readFileSync(fixtureUrl(`${name}.normalized.json`), 'utf8').trim()}\n`;
    const parsed = parseRuleSet(source, format);
    const normalized = normalizeRuleSet(parsed.parsedRules);
    expect(normalized.errors).toEqual([]);
    expect(normalized.serialized).toBe(expected);
    expect(normalized.contentHash).toBe(hash);
    expect(createHash('sha256').update(expected).digest('hex')).toBe(hash);
  });

  it('exposes modular detect and parse interfaces', () => {
    expect(RULE_SET_PARSERS.map((parser) => parser.format)).toEqual([
      'PROXYHUB_NATIVE',
      'MIHOMO',
      'PLAIN_TEXT',
    ]);
    expect(parseRuleSet('{"version":1,"rules":[]}').format).toBe('PROXYHUB_NATIVE');
    expect(parseRuleSet('payload:\n - DOMAIN-SUFFIX,example.com').format).toBe('MIHOMO');
  });

  it('handles comments, whitespace, CRLF, Unicode, duplicates, unsupported and malformed lines', () => {
    const parsed = parseRuleSet(
      '# comment\r\n DOMAIN_KEYWORD,例子 \r\nDOMAIN_KEYWORD,例子\r\nPROCESS_NAME,foo\r\nbroken',
      'PLAIN_TEXT',
    );
    const normalized = normalizeRuleSet(parsed.parsedRules);
    expect(parsed.warnings).toContainEqual(
      expect.objectContaining({ code: 'RULE_SET_RULE_UNSUPPORTED', lineNumber: 4 }),
    );
    expect(parsed.errors).toContainEqual(
      expect.objectContaining({ code: 'RULE_SET_PARSE_FAILED', lineNumber: 5 }),
    );
    expect(normalized.duplicateCount).toBe(1);
  });

  it.each([
    ['DOMAIN', 'bad domain'],
    ['IP_CIDR', '10.0.0.1/33'],
    ['IP_CIDR6', '2001:db8::/129'],
    ['DST_PORT', '0'],
    ['DST_PORT', '65536'],
    ['NETWORK', 'icmp'],
    ['GEOIP', ''],
  ] as const)('rejects invalid %s safely', (type, value) => {
    expect(normalizeRuleSet([{ type, value, enabled: true, order: 0 }]).errors[0]).toMatchObject({
      code: 'RULE_SET_ENTRY_INVALID',
      ruleType: type,
    });
  });

  it('canonicalizes IPv6 CIDRs to their network address', () => {
    const normalized = normalizeRuleSet([
      {
        type: 'IP_CIDR6',
        value: '2001:0DB8:0000:0000:0001:0000:0000:0001/64',
        enabled: true,
        order: 0,
      },
    ]);
    expect(normalized.rules[0]?.value).toBe('2001:db8::/64');
  });

  it('normalizes 10,000 rules without quadratic behavior', () => {
    const rules: RuleSetRule[] = Array.from({ length: 10_000 }, (_, index) => ({
      type: 'DOMAIN_SUFFIX',
      value: `service-${String(index)}.example.com`,
      enabled: true,
      order: index,
    }));
    const started = performance.now();
    const normalized = normalizeRuleSet(rules);
    expect(normalized.rules).toHaveLength(10_000);
    expect(performance.now() - started).toBeLessThan(5_000);
  });
});
