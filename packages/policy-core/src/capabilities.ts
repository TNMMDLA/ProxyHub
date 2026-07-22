import type {
  AdapterCapability,
  AdapterMetadata,
  CompilerFormat,
  PolicyMatchType,
} from './types.js';

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

export const ADAPTER_METADATA: Record<CompilerFormat, AdapterMetadata> = Object.fromEntries(
  (['mihomo', 'sing-box', 'raw'] as const).map((format) => {
    const capability = CAPABILITIES[format];
    return [
      format,
      {
        adapterName: format,
        adapterVersion: '1.0.0',
        validatedAgainst:
          format === 'mihomo'
            ? 'Mihomo v1.19.28'
            : format === 'sing-box'
              ? 'sing-box v1.13.12'
              : 'RFC 3986 VLESS URI list',
        capabilities: {
          routing: capability.routing,
          ruleTypes: [...capability.ruleTypes],
        },
      },
    ];
  }),
) as Record<CompilerFormat, AdapterMetadata>;
