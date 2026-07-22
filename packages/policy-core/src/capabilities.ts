import type { AdapterCapability, CompilerFormat, PolicyMatchType } from './types.js';

const allRuleTypes = new Set<PolicyMatchType>([
  'DOMAIN',
  'DOMAIN_SUFFIX',
  'DOMAIN_KEYWORD',
  'DOMAIN_REGEX',
  'IP_CIDR',
  'IP_CIDR6',
  'GEOIP',
  'GEOSITE',
  'DST_PORT',
  'NETWORK',
]);

export const CAPABILITIES: Record<CompilerFormat, AdapterCapability> = {
  mihomo: { format: 'mihomo', routing: true, ruleTypes: allRuleTypes },
  'sing-box': {
    format: 'sing-box',
    routing: true,
    ruleTypes: new Set([
      'DOMAIN',
      'DOMAIN_SUFFIX',
      'DOMAIN_KEYWORD',
      'DOMAIN_REGEX',
      'IP_CIDR',
      'IP_CIDR6',
      'DST_PORT',
      'NETWORK',
    ]),
  },
  raw: { format: 'raw', routing: false, ruleTypes: new Set() },
};
