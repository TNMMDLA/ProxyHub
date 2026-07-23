export const RULE_TYPES = [
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
] as const;

export type RuleSetRuleType = (typeof RULE_TYPES)[number];
export type RuleSetFormat = 'PROXYHUB_NATIVE' | 'PLAIN_TEXT' | 'MIHOMO';

export interface RuleSetRule {
  type: RuleSetRuleType;
  value: string;
  order: number;
  enabled: boolean;
  lineNumber?: number;
}

export interface RuleSetDiagnostic {
  code: string;
  severity: 'WARNING' | 'ERROR';
  message: string;
  lineNumber?: number;
  ruleType?: string;
  valuePreview?: string;
}

export interface RuleSetParseResult {
  format: RuleSetFormat;
  totalLines: number;
  parsedRules: RuleSetRule[];
  skippedRules: number;
  warnings: RuleSetDiagnostic[];
  errors: RuleSetDiagnostic[];
}

export interface NormalizedRuleSet {
  rules: RuleSetRule[];
  contentHash: string;
  duplicateCount: number;
  warnings: RuleSetDiagnostic[];
  errors: RuleSetDiagnostic[];
  serialized: string;
}

export interface RuleSetParser {
  readonly format: RuleSetFormat;
  detect(source: string): boolean;
  parse(source: string): RuleSetParseResult;
}
