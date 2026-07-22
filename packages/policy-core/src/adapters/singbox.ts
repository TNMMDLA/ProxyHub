import { CAPABILITIES } from '../capabilities.js';
import type { CompilerRule, NormalizedPolicyInput } from '../types.js';
import { actionTarget, proxyName, referencedPoolIds } from './shared.js';

function routeRule(rule: CompilerRule, outbound: string): Record<string, unknown> {
  const base = rule.actionType === 'REJECT' ? { action: 'reject' } : { action: 'route', outbound };
  switch (rule.matchType) {
    case 'DOMAIN':
      return { domain: [rule.matchValue], ...base };
    case 'DOMAIN_SUFFIX':
      return { domain_suffix: [rule.matchValue], ...base };
    case 'DOMAIN_KEYWORD':
      return { domain_keyword: [rule.matchValue], ...base };
    case 'DOMAIN_REGEX':
      return { domain_regex: [rule.matchValue], ...base };
    case 'IP_CIDR':
    case 'IP_CIDR6':
      return { ip_cidr: [rule.matchValue], ...base };
    case 'DST_PORT': {
      const [start, end] = rule.matchValue.split('-').map(Number);
      return end
        ? { port_range: [`${String(start)}:${String(end)}`], ...base }
        : { port: [start], ...base };
    }
    case 'NETWORK':
      return { network: [rule.matchValue.toLowerCase()], ...base };
    case 'GEOIP':
    case 'GEOSITE':
      return base;
  }
}

export function compileSingBox(input: NormalizedPolicyInput): string {
  const outbounds: Array<Record<string, unknown>> = input.nodes.map((node) => ({
    type: 'vless',
    tag: proxyName(node.name, node.id),
    server: node.host,
    server_port: node.port,
    uuid: node.uuid,
    flow: node.flow,
    tls: {
      enabled: true,
      server_name: node.sni,
      utls: { enabled: true, fingerprint: node.fingerprint },
      reality: { enabled: true, public_key: node.realityPublicKey, short_id: node.shortId },
    },
  }));
  const usedPools = referencedPoolIds(input);
  for (const pool of input.nodePools.filter((item) => usedPools.has(item.id))) {
    outbounds.push({
      type: 'selector',
      tag: pool.name,
      outbounds: pool.members.flatMap((member) => {
        const node = input.nodeById.get(member.nodeId);
        return node ? [proxyName(node.name, node.id)] : [];
      }),
    });
  }
  outbounds.push({ type: 'direct', tag: 'DIRECT' });
  const rules = input.rules.flatMap((rule) =>
    CAPABILITIES['sing-box'].ruleTypes.has(rule.matchType)
      ? [routeRule(rule, actionTarget(input, rule.actionType, rule.nodePoolId))]
      : [],
  );
  if (input.policy.defaultAction === 'REJECT') rules.push({ action: 'reject' });
  return `${JSON.stringify(
    {
      log: { level: 'warn' },
      outbounds,
      route: {
        rules,
        final:
          input.policy.defaultAction === 'REJECT'
            ? 'DIRECT'
            : actionTarget(input, input.policy.defaultAction, input.policy.defaultNodePoolId),
      },
    },
    null,
    2,
  )}\n`;
}
