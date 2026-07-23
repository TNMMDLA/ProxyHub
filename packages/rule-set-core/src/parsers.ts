import { RULE_TYPES } from './types.js';
import type {
  RuleSetDiagnostic,
  RuleSetFormat,
  RuleSetParseResult,
  RuleSetParser,
  RuleSetRuleType,
} from './types.js';

const knownTypes = new Set<string>(RULE_TYPES);
const mihomoTypes: Record<string, RuleSetRuleType> = {
  DOMAIN: 'DOMAIN',
  'DOMAIN-SUFFIX': 'DOMAIN_SUFFIX',
  'DOMAIN-KEYWORD': 'DOMAIN_KEYWORD',
  'DOMAIN-REGEX': 'DOMAIN_REGEX',
  'IP-CIDR': 'IP_CIDR',
  'IP-CIDR6': 'IP_CIDR6',
  GEOIP: 'GEOIP',
  GEOSITE: 'GEOSITE',
  'DST-PORT': 'DST_PORT',
  NETWORK: 'NETWORK',
};

function preview(value: string): string {
  return value.replaceAll(/[\r\n\t]/g, ' ').slice(0, 120);
}

function result(format: RuleSetFormat, source: string): RuleSetParseResult {
  return {
    format,
    totalLines: source.split(/\r?\n/).length,
    parsedRules: [],
    skippedRules: 0,
    warnings: [],
    errors: [],
  };
}

function pushInvalid(
  target: RuleSetDiagnostic[],
  lineNumber: number,
  content: string,
  reason: string,
): void {
  target.push({
    code: 'RULE_SET_PARSE_FAILED',
    severity: 'ERROR',
    message: reason,
    lineNumber,
    valuePreview: preview(content),
  });
}

class ProxyHubNativeParser implements RuleSetParser {
  readonly format = 'PROXYHUB_NATIVE' as const;
  detect(source: string): boolean {
    return source.trimStart().startsWith('{');
  }
  parse(source: string): RuleSetParseResult {
    const parsed = result(this.format, source);
    let document: unknown;
    try {
      document = JSON.parse(source) as unknown;
    } catch {
      pushInvalid(parsed.errors, 1, source, 'ProxyHub Native source must be valid JSON.');
      return parsed;
    }
    if (!document || typeof document !== 'object') {
      pushInvalid(parsed.errors, 1, source, 'ProxyHub Native source must be an object.');
      return parsed;
    }
    const record = document as { version?: unknown; rules?: unknown };
    if (record.version !== 1 || !Array.isArray(record.rules)) {
      pushInvalid(
        parsed.errors,
        1,
        source,
        'ProxyHub Native version must be 1 and rules an array.',
      );
      return parsed;
    }
    record.rules.forEach((item, index) => {
      const lineNumber = index + 1;
      if (!item || typeof item !== 'object') {
        pushInvalid(parsed.errors, lineNumber, JSON.stringify(item), 'Rule must be an object.');
        return;
      }
      const rule = item as { type?: unknown; value?: unknown; enabled?: unknown };
      if (!knownTypes.has(String(rule.type)) || typeof rule.value !== 'string') {
        pushInvalid(
          parsed.errors,
          lineNumber,
          JSON.stringify(item),
          'Rule has an unsupported type or non-string value.',
        );
        return;
      }
      parsed.parsedRules.push({
        type: rule.type as RuleSetRuleType,
        value: rule.value,
        enabled: rule.enabled !== false,
        order: parsed.parsedRules.length,
        lineNumber,
      });
    });
    parsed.skippedRules = parsed.errors.length;
    parsed.totalLines = record.rules.length;
    return parsed;
  }
}

class DelimitedParser implements RuleSetParser {
  constructor(
    readonly format: 'PLAIN_TEXT' | 'MIHOMO',
    private readonly aliases: Readonly<Record<string, RuleSetRuleType>>,
  ) {}

  detect(source: string): boolean {
    if (this.format === 'PLAIN_TEXT') return !source.trimStart().startsWith('{');
    return /(?:DOMAIN|IP|GEO|DST|NETWORK)-[A-Z]+|^\s*payload\s*:/m.test(source);
  }

  parse(source: string): RuleSetParseResult {
    const parsed = result(this.format, source);
    const lines = source.split(/\r?\n/);
    for (const [index, original] of lines.entries()) {
      const lineNumber = index + 1;
      let line = original.trim();
      if (!line || line.startsWith('#') || line === 'payload:') continue;
      if (this.format === 'MIHOMO') {
        line = line.replace(/^\s*-\s*/, '').trim();
        if (
          (line.startsWith('"') && line.endsWith('"')) ||
          (line.startsWith("'") && line.endsWith("'"))
        )
          line = line.slice(1, -1);
      }
      const comma = line.indexOf(',');
      if (comma <= 0 || comma === line.length - 1) {
        parsed.skippedRules += 1;
        pushInvalid(parsed.errors, lineNumber, original, 'Expected TYPE,value.');
        continue;
      }
      const externalType = line.slice(0, comma).trim().toUpperCase();
      const mapped = this.aliases[externalType];
      if (!mapped) {
        parsed.skippedRules += 1;
        parsed.warnings.push({
          code: 'RULE_SET_RULE_UNSUPPORTED',
          severity: 'WARNING',
          message: `Unsupported rule type ${externalType}; line skipped.`,
          lineNumber,
          ruleType: externalType,
          valuePreview: preview(original),
        });
        continue;
      }
      parsed.parsedRules.push({
        type: mapped,
        value: line.slice(comma + 1).trim(),
        enabled: true,
        order: parsed.parsedRules.length,
        lineNumber,
      });
    }
    return parsed;
  }
}

const internalAliases = Object.fromEntries(RULE_TYPES.map((type) => [type, type])) as Record<
  string,
  RuleSetRuleType
>;

export const RULE_SET_PARSERS: readonly RuleSetParser[] = [
  new ProxyHubNativeParser(),
  new DelimitedParser('MIHOMO', mihomoTypes),
  new DelimitedParser('PLAIN_TEXT', internalAliases),
];

export function parseRuleSet(source: string, format?: RuleSetFormat): RuleSetParseResult {
  const parser = format
    ? RULE_SET_PARSERS.find((candidate) => candidate.format === format)
    : RULE_SET_PARSERS.find((candidate) => candidate.detect(source));
  if (!parser) return result(format ?? 'PLAIN_TEXT', source);
  return parser.parse(source);
}
