import type { SubscriptionReadinessResult } from '@proxyhub/shared';

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
  protocol: string;
  transport: string;
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

export type EffectiveUserStatus = 'ACTIVE' | 'DISABLED' | 'EXPIRED' | 'TRAFFIC_EXHAUSTED';

export interface UserTrafficRecord {
  currentCycleUplinkBytes: string;
  currentCycleDownlinkBytes: string;
  currentCycleTotalBytes: string;
  lifetimeUplinkBytes: string;
  lifetimeDownlinkBytes: string;
  lifetimeTotalBytes: string;
  cycleStartedAt: string | null;
  cycleEndsAt: string | null;
  lastTrafficAt: string | null;
}

export interface UserAccessRecord {
  id: string;
  enabled: boolean;
  statsIdentity: string;
  createdAt: string;
  updatedAt: string;
  node: {
    id: string;
    name: string;
    protocol: string;
    transport: string;
    enabled: boolean;
    status: string;
    server: { id: string; name: string };
  };
  traffic: UserTrafficRecord;
}

export interface UserRecord {
  id: string;
  name: string;
  remark: string;
  groupId: string | null;
  group: UserGroupRecord | null;
  adminEnabled: boolean;
  expiresAt: string | null;
  resetPolicy: 'NEVER' | 'MONTHLY';
  resetDay: number | null;
  status: EffectiveUserStatus;
  trafficLimitBytes: string | null;
  remainingBytes: string | null;
  lastTrafficAt: string | null;
  createdAt: string;
  updatedAt: string;
  credential: { id: string; createdAt: string; rotatedAt: string | null } | null;
  traffic: UserTrafficRecord;
  accesses: UserAccessRecord[];
}

export interface UserGroupRecord {
  id: string;
  name: string;
  description: string;
  createdAt: string;
  updatedAt: string;
  _count?: { users: number };
}

export interface UserListRecord {
  items: UserRecord[];
  page: number;
  limit: number;
  total: number;
}

export interface NodeUserRecord {
  id: string;
  enabled: boolean;
  status: EffectiveUserStatus;
  user: { id: string; name: string; lastTrafficAt: string | null };
  traffic: UserTrafficRecord;
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
export type PolicyMatchSource = 'INLINE' | 'RULE_SET';
export type RuleSetSourceType = 'MANUAL' | 'REMOTE';
export type RuleSetFormat = 'AUTO' | 'PROXYHUB_NATIVE' | 'PLAIN_TEXT' | 'MIHOMO';

export interface PolicyRuleRecord {
  id: string;
  policyId: string;
  name: string;
  description: string;
  enabled: boolean;
  priority: number;
  matchType: PolicyMatchType;
  matchValue: string;
  matchSourceType: PolicyMatchSource;
  ruleSetId: string | null;
  ruleSet: Pick<
    RuleSetRecord,
    'id' | 'name' | 'enabled' | 'status' | 'ruleCount' | 'sourceType'
  > | null;
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
  severity: 'WARNING' | 'ERROR';
  message: string;
  adapter: SubscriptionFormat;
  ruleId?: string;
  ruleName?: string;
  ruleType?: PolicyMatchType;
  ruleSetId?: string;
  ruleSetName?: string;
  sourceType?: RuleSetSourceType;
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
    sourceRuleCount: number;
    expandedRuleCount: number;
    ruleSetCount: number;
    adapter: {
      adapterName: SubscriptionFormat;
      adapterVersion: string;
      validatedAgainst: string;
      capabilities: { routing: boolean; ruleTypes: PolicyMatchType[] };
    };
  };
}

export interface SubscriptionPreviewRecord {
  format: SubscriptionFormat;
  contentType: string;
  output: string;
  sanitized: true;
  truncated: boolean;
  originalBytes: number;
  displayedBytes: number;
  limits: {
    maxBytes: number;
    maxNodes: number;
    maxRules: number;
    timeoutMs: number;
    concurrency: number;
  };
  metadata: CompilerPreviewRecord['metadata'];
  warnings: CompilerDiagnosticRecord[];
  readiness: SubscriptionReadinessResult;
}

export interface SubscriptionResponseTestRecord {
  accessible: boolean;
  statusCode: number;
  errorCode?: string;
  contentType?: string;
  cacheControl?: string;
  etag?: string;
  responseBytes?: number;
  format?: SubscriptionFormat;
  token: '[REDACTED]';
  compileSuccess?: boolean;
  readiness: SubscriptionReadinessResult;
}

export type CapabilityState = 'SUPPORTED' | 'PARTIAL' | 'UNSUPPORTED' | 'NOT_APPLICABLE';
export interface SubscriptionCapabilityRecord {
  format: SubscriptionFormat;
  validatedAgainst: string;
  features: Record<string, CapabilityState>;
  supportedRuleTypes: PolicyMatchType[];
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

export interface RuleSetEntryRecord {
  id: string;
  ruleSetId: string;
  type: PolicyMatchType;
  value: string;
  enabled: boolean;
  order: number;
}

export interface RuleSetRecord {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  sourceType: RuleSetSourceType;
  format: RuleSetFormat;
  sourceUrl: string | null;
  updateIntervalMinutes: number | null;
  lastFetchAt: string | null;
  lastSuccessAt: string | null;
  nextUpdateAt: string | null;
  status: 'READY' | 'UPDATING' | 'STALE' | 'ERROR' | 'DISABLED' | 'EMPTY';
  lastError: string | null;
  contentHash: string | null;
  ruleCount: number;
  revision: number;
  entries?: RuleSetEntryRecord[];
  policyRules?: Array<{ policy: { id: string; name: string } }>;
  _count: { entries: number; policyRules: number };
}

export interface RuleSetPreviewRecord {
  totalRules: number;
  offset: number;
  limit: number;
  rules: Array<{ type: PolicyMatchType; value: string }>;
  distribution: Record<string, number>;
  duplicateCount: number;
  warnings: CompilerDiagnosticRecord[];
  status: RuleSetRecord['status'];
  contentHash: string | null;
}
