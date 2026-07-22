export interface Admin {
  id: string;
  username: string;
  role: string;
  totpEnabled: boolean;
}
export interface ServerRecord {
  id: string;
  name: string;
  hostname: string;
  ip: string;
  region: string;
  status: string;
  cpuUsage: number;
  memoryUsage: number;
  diskUsage: number;
  lastHeartbeat: string | null;
  xrayVersion: string | null;
  _count?: { nodes: number };
}
export interface NodeRecord {
  id: string;
  serverId: string;
  name: string;
  host: string;
  port: number;
  uuid: string;
  flow: string;
  realityPublicKey: string;
  shortId: string;
  sni: string;
  dest: string;
  fingerprint: string;
  status: string;
  enabled: boolean;
  latency: number | null;
  createdAt: string;
  server: { name: string; status: string };
  pools: Array<{ nodePool: PoolRecord }>;
}
export interface PoolRecord {
  id: string;
  name: string;
  description: string;
  region: string;
  strategy: string;
  enabled: boolean;
  members: Array<{ node: Pick<NodeRecord, 'id' | 'name' | 'status' | 'enabled' | 'latency'> }>;
}
export interface NotificationRecord {
  id: string;
  level: string;
  title: string;
  message: string;
  readAt: string | null;
  createdAt: string;
}
export interface AuditRecord {
  id: string;
  actorName: string;
  action: string;
  resource: string;
  resourceId: string | null;
  ip: string | null;
  result: string;
  createdAt: string;
}

export type PolicyAction = 'DIRECT' | 'REJECT' | 'NODE_POOL';
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
export type SubscriptionFormat = 'mihomo' | 'sing-box' | 'raw';

export interface PolicyRuleRecord {
  id: string;
  policyId: string;
  name: string;
  description: string;
  enabled: boolean;
  priority: number;
  matchType: PolicyMatchType;
  matchValue: string;
  actionType: PolicyAction;
  nodePoolId: string | null;
  nodePool: { id: string; name: string; enabled: boolean } | null;
  createdAt: string;
  updatedAt: string;
}

export interface PolicyRecord {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  revision: number;
  defaultAction: PolicyAction;
  defaultNodePoolId: string | null;
  defaultNodePool: { id: string; name: string; enabled: boolean } | null;
  rules?: PolicyRuleRecord[];
  _count: { rules?: number; subscriptions: number };
  createdAt: string;
  updatedAt: string;
}

export interface CompilerDiagnosticRecord {
  code: string;
  message: string;
  adapter: SubscriptionFormat;
  ruleId?: string;
  ruleName?: string;
  ruleType?: PolicyMatchType;
}

export interface CompilerPreviewRecord {
  success: boolean;
  format: SubscriptionFormat;
  output: string;
  maskedOutput: string;
  warnings: CompilerDiagnosticRecord[];
  errors: CompilerDiagnosticRecord[];
  metadata: {
    policyId: string;
    revision: number;
    ruleCount: number;
    nodeCount: number;
    poolCount: number;
  };
}

export interface SubscriptionRecord {
  id: string;
  name: string;
  enabled: boolean;
  policyId: string;
  policy: { id: string; name: string; enabled: boolean; revision: number };
  format: SubscriptionFormat;
  tokenPrefix: string;
  expiresAt: string | null;
  lastAccessAt: string | null;
  createdAt: string;
  updatedAt: string;
}
