export type PolicyActionType = 'DIRECT' | 'REJECT' | 'NODE_POOL';
export type PolicyMatchType =
  | 'DOMAIN'
  | 'DOMAIN_SUFFIX'
  | 'DOMAIN_KEYWORD'
  | 'DOMAIN_REGEX'
  | 'IP_CIDR'
  | 'IP_CIDR6'
  | 'GEOIP'
  | 'GEOSITE'
  | 'DST_PORT'
  | 'NETWORK';
export type CompilerFormat = 'mihomo' | 'sing-box' | 'raw';
export type PolicyMatchSourceType = 'INLINE' | 'RULE_SET';

export interface CompilerPolicy {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  revision: number;
  defaultAction: PolicyActionType;
  defaultNodePoolId: string | null;
}

export interface CompilerRule {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  priority: number;
  matchType: PolicyMatchType;
  matchValue: string;
  actionType: PolicyActionType;
  nodePoolId: string | null;
  matchSourceType?: PolicyMatchSourceType;
  ruleSetId?: string | null;
  ruleSetName?: string | null;
  ruleSetSourceType?: 'MANUAL' | 'REMOTE';
  entryIndex?: number;
  originRuleId?: string;
}

export interface CompilerRuleSetEntry {
  type: PolicyMatchType;
  value: string;
  order: number;
}

export interface CompilerRuleSet {
  id: string;
  name: string;
  enabled: boolean;
  sourceType: 'MANUAL' | 'REMOTE';
  status: 'READY' | 'UPDATING' | 'STALE' | 'ERROR' | 'DISABLED' | 'EMPTY';
  entries: CompilerRuleSetEntry[];
}

export interface CompilerNode {
  id: string;
  name: string;
  host: string;
  port: number;
  uuid: string;
  flow: string;
  sni: string;
  fingerprint: string;
  realityPublicKey: string;
  shortId: string;
  enabled: boolean;
  status: string;
  uri: string;
}

export interface CompilerNodePool {
  id: string;
  name: string;
  enabled: boolean;
  strategy: string;
  members: Array<{ nodeId: string; priority: number }>;
}

export interface PolicyCompileInput {
  policy: CompilerPolicy;
  rules: CompilerRule[];
  nodes: CompilerNode[];
  nodePools: CompilerNodePool[];
  ruleSets?: CompilerRuleSet[];
}

export interface CompilerDiagnostic {
  code: string;
  severity: 'WARNING' | 'ERROR';
  message: string;
  adapter: CompilerFormat;
  ruleId?: string;
  ruleName?: string;
  ruleType?: PolicyMatchType;
  ruleSetId?: string;
  ruleSetName?: string;
  sourceType?: 'MANUAL' | 'REMOTE';
  entryIndex?: number;
}

export interface CompilerResult {
  success: boolean;
  format: CompilerFormat;
  output: string;
  warnings: CompilerDiagnostic[];
  errors: CompilerDiagnostic[];
  metadata: {
    policyId: string;
    revision: number;
    ruleCount: number;
    nodeCount: number;
    poolCount: number;
    sourceRuleCount: number;
    expandedRuleCount: number;
    ruleSetCount: number;
    adapter: AdapterMetadata;
  };
}

export interface NormalizedPolicyInput extends PolicyCompileInput {
  rules: CompilerRule[];
  nodes: CompilerNode[];
  nodePools: CompilerNodePool[];
  nodeById: Map<string, CompilerNode>;
  poolById: Map<string, CompilerNodePool>;
  ruleSetIssues: RuleSetResolutionIssue[];
  referencedRuleSetCount: number;
}

export interface RuleSetResolutionIssue {
  code: string;
  severity: 'WARNING' | 'ERROR';
  message: string;
  ruleId: string;
  ruleName: string;
  ruleSetId?: string;
  ruleSetName?: string;
  sourceType?: 'MANUAL' | 'REMOTE';
}

export interface AdapterCapability {
  format: CompilerFormat;
  ruleTypes: ReadonlySet<PolicyMatchType>;
  routing: boolean;
}

export interface AdapterMetadata {
  adapterName: CompilerFormat;
  adapterVersion: string;
  validatedAgainst: string;
  capabilities: {
    routing: boolean;
    ruleTypes: PolicyMatchType[];
  };
}
