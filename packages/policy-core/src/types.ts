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
}

export interface CompilerDiagnostic {
  code: string;
  message: string;
  adapter: CompilerFormat;
  ruleId?: string;
  ruleName?: string;
  ruleType?: PolicyMatchType;
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
  };
}

export interface NormalizedPolicyInput extends PolicyCompileInput {
  rules: CompilerRule[];
  nodes: CompilerNode[];
  nodePools: CompilerNodePool[];
  nodeById: Map<string, CompilerNode>;
  poolById: Map<string, CompilerNodePool>;
}

export interface AdapterCapability {
  format: CompilerFormat;
  ruleTypes: ReadonlySet<PolicyMatchType>;
  routing: boolean;
}
