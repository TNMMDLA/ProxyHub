import { CAPABILITIES } from './capabilities.js';
import type {
  CompilerDiagnostic,
  CompilerFormat,
  CompilerRule,
  NormalizedPolicyInput,
} from './types.js';

function diagnostic(
  format: CompilerFormat,
  code: string,
  message: string,
  rule?: CompilerRule,
): CompilerDiagnostic {
  return {
    code,
    message,
    adapter: format,
    ...(rule ? { ruleId: rule.id, ruleName: rule.name, ruleType: rule.matchType } : {}),
  };
}

function validIpv4Cidr(value: string): boolean {
  const [address, prefix, extra] = value.split('/');
  if (!address || !prefix || extra !== undefined) return false;
  const octets = address.split('.');
  return (
    octets.length === 4 &&
    octets.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255) &&
    /^\d{1,2}$/.test(prefix) &&
    Number(prefix) <= 32
  );
}

function validIpv6Cidr(value: string): boolean {
  const [address, prefix, extra] = value.split('/');
  return Boolean(
    address &&
    address.includes(':') &&
    /^[0-9a-fA-F:]+$/.test(address) &&
    prefix &&
    /^\d{1,3}$/.test(prefix) &&
    Number(prefix) <= 128 &&
    extra === undefined,
  );
}

function validDomain(value: string): boolean {
  const candidate = value.startsWith('.') ? value.slice(1) : value;
  return (
    candidate.length > 0 &&
    candidate.length <= 253 &&
    candidate
      .split('.')
      .every((label) => /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/.test(label))
  );
}

function ruleValueValid(rule: CompilerRule): boolean {
  switch (rule.matchType) {
    case 'DOMAIN':
    case 'DOMAIN_SUFFIX':
      return validDomain(rule.matchValue);
    case 'DOMAIN_REGEX':
      try {
        new RegExp(rule.matchValue);
        return true;
      } catch {
        return false;
      }
    case 'IP_CIDR':
      return validIpv4Cidr(rule.matchValue);
    case 'IP_CIDR6':
      return validIpv6Cidr(rule.matchValue);
    case 'DST_PORT': {
      const [start, end, extra] = rule.matchValue.split('-');
      const valid = (part: string | undefined) =>
        Boolean(part && /^\d{1,5}$/.test(part) && Number(part) >= 1 && Number(part) <= 65_535);
      return valid(start) && (end === undefined || valid(end)) && extra === undefined;
    }
    case 'NETWORK':
      return ['TCP', 'UDP'].includes(rule.matchValue.toUpperCase());
    case 'GEOIP':
    case 'GEOSITE':
      return /^[a-zA-Z0-9_-]+$/.test(rule.matchValue);
    case 'DOMAIN_KEYWORD':
      return rule.matchValue.length > 0;
  }
}

export function validatePolicy(
  input: NormalizedPolicyInput,
  format: CompilerFormat,
): { warnings: CompilerDiagnostic[]; errors: CompilerDiagnostic[] } {
  const warnings: CompilerDiagnostic[] = [];
  const errors: CompilerDiagnostic[] = [];
  const capability = CAPABILITIES[format];

  if (!input.policy.enabled) {
    errors.push(
      diagnostic(format, 'POLICY_DISABLED', `Policy “${input.policy.name}” is disabled.`),
    );
  }

  const requiredPoolIds = new Set<string>();
  if (input.policy.defaultAction === 'NODE_POOL') {
    if (input.policy.defaultNodePoolId) requiredPoolIds.add(input.policy.defaultNodePoolId);
    else errors.push(diagnostic(format, 'POLICY_INVALID', 'Default NODE_POOL action has no pool.'));
  }

  const duplicateKeys = new Map<string, CompilerRule>();
  for (const rule of input.rules) {
    if (!ruleValueValid(rule)) {
      errors.push(
        diagnostic(
          format,
          'POLICY_RULE_INVALID',
          `Rule “${rule.name}” has an invalid value.`,
          rule,
        ),
      );
    }
    if (!capability.ruleTypes.has(rule.matchType)) {
      warnings.push(
        diagnostic(
          format,
          'POLICY_RULE_UNSUPPORTED',
          `${format} cannot represent ${rule.matchType}; the rule is not emitted.`,
          rule,
        ),
      );
    }
    if (rule.actionType === 'NODE_POOL') {
      if (rule.nodePoolId) requiredPoolIds.add(rule.nodePoolId);
      else {
        errors.push(
          diagnostic(format, 'POLICY_RULE_INVALID', `Rule “${rule.name}” has no node pool.`, rule),
        );
      }
    }
    const key = [rule.matchType, rule.matchValue, rule.actionType, rule.nodePoolId ?? ''].join(
      '\u0000',
    );
    const duplicate = duplicateKeys.get(key);
    if (duplicate) {
      warnings.push(
        diagnostic(
          format,
          'POLICY_RULE_DUPLICATE',
          `Rule duplicates “${duplicate.name}”; First Match Wins keeps the earlier rule.`,
          rule,
        ),
      );
    } else duplicateKeys.set(key, rule);
  }

  for (const poolId of requiredPoolIds) {
    const pool = input.poolById.get(poolId);
    if (!pool) {
      errors.push(
        diagnostic(
          format,
          'POLICY_NODE_POOL_MISSING',
          `Referenced node pool ${poolId} is missing.`,
        ),
      );
      continue;
    }
    if (!pool.enabled) {
      warnings.push(
        diagnostic(format, 'NODE_POOL_DISABLED', `Node pool “${pool.name}” is disabled.`),
      );
    }
    if (pool.members.length === 0) {
      errors.push(
        diagnostic(format, 'NODE_POOL_EMPTY', `Node pool “${pool.name}” has no enabled nodes.`),
      );
    }
  }
  return { warnings, errors };
}
