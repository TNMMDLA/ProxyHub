import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import type {
  NormalizedRuleSet,
  RuleSetDiagnostic,
  RuleSetRule,
  RuleSetRuleType,
} from './types.js';

const MAX_VALUE_LENGTH = 1000;

function validDomain(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 253 &&
    value.split('.').every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
  );
}

function normalizeIpv4Cidr(value: string): string | null {
  const [address, prefixText, extra] = value.split('/');
  if (!address || !prefixText || extra !== undefined || isIP(address) !== 4) return null;
  const prefix = Number(prefixText);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) return null;
  const integer = address
    .split('.')
    .reduce((result, part) => ((result << 8) | Number(part)) >>> 0, 0);
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  const network = (integer & mask) >>> 0;
  return `${[24, 16, 8, 0].map((shift) => (network >>> shift) & 255).join('.')}/${String(prefix)}`;
}

function normalizeIpv6Cidr(value: string): string | null {
  const [address, prefixText, extra] = value.split('/');
  if (!address || !prefixText || extra !== undefined || isIP(address) !== 6) return null;
  const prefix = Number(prefixText);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 128) return null;

  let expanded = address.toLowerCase();
  const ipv4Suffix = expanded.match(/(?:^|:)(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  if (ipv4Suffix) {
    const octets = ipv4Suffix.split('.').map(Number);
    expanded = `${expanded.slice(0, -ipv4Suffix.length)}${((octets[0]! << 8) | octets[1]!).toString(16)}:${((octets[2]! << 8) | octets[3]!).toString(16)}`;
  }
  const halves = expanded.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves[1] ? halves[1].split(':') : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || missing < 0) return null;
  const groups = [...left, ...Array<string>(missing).fill('0'), ...right].map((part) =>
    Number.parseInt(part, 16),
  );
  if (groups.length !== 8 || groups.some((part) => !Number.isInteger(part))) return null;

  let integer = groups.reduce((result, group) => (result << 16n) | BigInt(group), 0n);
  const hostBits = 128 - prefix;
  if (hostBits > 0) integer = (integer >> BigInt(hostBits)) << BigInt(hostBits);
  const networkGroups = Array.from({ length: 8 }, (_, index) =>
    Number((integer >> BigInt((7 - index) * 16)) & 0xffffn),
  );
  let bestStart = -1;
  let bestLength = 0;
  for (let index = 0; index < networkGroups.length;) {
    if (networkGroups[index] !== 0) {
      index += 1;
      continue;
    }
    let end = index;
    while (end < networkGroups.length && networkGroups[end] === 0) end += 1;
    if (end - index > bestLength && end - index >= 2) {
      bestStart = index;
      bestLength = end - index;
    }
    index = end;
  }
  const rendered = networkGroups.map((group) => group.toString(16));
  if (bestStart >= 0) rendered.splice(bestStart, bestLength, '');
  let canonical = rendered.join(':');
  if (bestStart === 0) canonical = `:${canonical}`;
  if (bestStart + bestLength === 8) canonical = `${canonical}:`;
  return `${canonical}/${String(prefix)}`;
}

function normalizeValue(type: RuleSetRuleType, rawValue: string): string | null {
  const value = rawValue.trim();
  if (!value || value.length > MAX_VALUE_LENGTH) return null;
  switch (type) {
    case 'DOMAIN':
    case 'DOMAIN_SUFFIX': {
      const domain = value.replace(/^\./, '').toLowerCase();
      return validDomain(domain) ? domain : null;
    }
    case 'DOMAIN_KEYWORD':
      return value.toLowerCase();
    case 'DOMAIN_REGEX':
      try {
        new RegExp(value);
        return value;
      } catch {
        return null;
      }
    case 'IP_CIDR':
      return normalizeIpv4Cidr(value);
    case 'IP_CIDR6':
      return normalizeIpv6Cidr(value);
    case 'DST_PORT': {
      const [startText, endText, extra] = value.split('-');
      if (!startText || extra !== undefined || !/^\d{1,5}$/.test(startText)) return null;
      const start = Number(startText);
      const end = endText === undefined ? start : Number(endText);
      if (
        start < 1 ||
        start > 65_535 ||
        end < start ||
        end > 65_535 ||
        (endText !== undefined && !/^\d{1,5}$/.test(endText))
      )
        return null;
      return start === end ? String(start) : `${String(start)}-${String(end)}`;
    }
    case 'NETWORK': {
      const network = value.toUpperCase();
      return network === 'TCP' || network === 'UDP' ? network : null;
    }
    case 'GEOIP':
    case 'GEOSITE':
      return /^[a-zA-Z0-9_-]+$/.test(value) ? value.toLowerCase() : null;
  }
}

export function normalizeRuleSet(rules: readonly RuleSetRule[]): NormalizedRuleSet {
  const normalized: RuleSetRule[] = [];
  const warnings: RuleSetDiagnostic[] = [];
  const errors: RuleSetDiagnostic[] = [];
  const seen = new Set<string>();
  let duplicateCount = 0;

  for (const rule of rules) {
    if (!rule.enabled) continue;
    const value = normalizeValue(rule.type, rule.value);
    if (value === null) {
      errors.push({
        code: 'RULE_SET_ENTRY_INVALID',
        severity: 'ERROR',
        message: `Invalid ${rule.type} value.`,
        ...(rule.lineNumber === undefined ? {} : { lineNumber: rule.lineNumber }),
        ruleType: rule.type,
        valuePreview: rule.value.slice(0, 120),
      });
      continue;
    }
    const key = `${rule.type}\u0000${value}`;
    if (seen.has(key)) {
      duplicateCount += 1;
      continue;
    }
    seen.add(key);
    normalized.push({ type: rule.type, value, order: normalized.length, enabled: true });
  }

  if (duplicateCount > 0) {
    warnings.push({
      code: 'RULE_SET_DUPLICATES_REMOVED',
      severity: 'WARNING',
      message: `${String(duplicateCount)} duplicate rule${duplicateCount === 1 ? '' : 's'} removed.`,
    });
  }
  const serialized = `${JSON.stringify(
    normalized.map(({ type, value }) => ({ type, value })),
    null,
    2,
  )}\n`;
  return {
    rules: normalized,
    serialized,
    contentHash: createHash('sha256').update(serialized).digest('hex'),
    duplicateCount,
    warnings,
    errors,
  };
}
