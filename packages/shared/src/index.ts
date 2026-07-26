import { z } from 'zod';
export { PROXYHUB_RELEASE } from './generated/release-version.js';

export const roleSchema = z.enum(['ADMIN', 'OPERATOR', 'VIEWER']);
export const nodeStatusSchema = z.enum(['HEALTHY', 'WARNING', 'OFFLINE', 'UNKNOWN']);
export const serverStatusSchema = z.enum(['ONLINE', 'OFFLINE', 'UNKNOWN']);
export const poolStrategySchema = z.enum([
  'MANUAL',
  'AUTO',
  'FALLBACK',
  'LOAD_BALANCE',
  'LATENCY_BASED',
]);

export const createNodeSchema = z.object({
  name: z.string().trim().min(2).max(80),
  serverId: z.string().trim().min(1).max(80),
  host: z.string().trim().min(1).max(253),
  port: z.number().int().min(1).max(65535),
  sni: z.string().trim().min(1).max(253),
  dest: z.string().trim().min(1).max(300).default('dl.google.com:443'),
  fingerprint: z.string().trim().default('chrome'),
});

export const updateNodeSchema = createNodeSchema.omit({ serverId: true }).partial().extend({
  enabled: z.boolean().optional(),
});

export const realityTargetCompatibilityRequestSchema = z.object({
  serverName: z.string().trim().min(1).max(253),
  target: z.string().trim().min(3).max(300),
});

export type RealityCompatibilityStageStatus = 'PASSED' | 'FAILED' | 'NOT_RUN';

export interface RealityTargetCompatibilityResult {
  status: 'COMPATIBLE' | 'INCOMPATIBLE';
  target: string;
  serverName: string;
  xrayVersion: string;
  durationMs: number;
  tlsPrecheck: { status: RealityCompatibilityStageStatus };
  realityHandshake: { status: RealityCompatibilityStageStatus };
  endToEndTraffic: { status: RealityCompatibilityStageStatus };
  diagnostics: string[];
}

export const createPoolSchema = z.object({
  name: z.string().trim().min(2).max(80),
  description: z.string().trim().max(300).default(''),
  region: z.string().trim().max(80).default('Global'),
  strategy: poolStrategySchema.default('MANUAL'),
  enabled: z.boolean().default(true),
  nodeIds: z.array(z.string().trim().min(1).max(80)).default([]),
});

export const policyActionSchema = z.enum(['DIRECT', 'REJECT', 'NODE_POOL']);
export const policyMatchTypeSchema = z.enum([
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
export const subscriptionFormatSchema = z.enum(['mihomo', 'sing-box', 'raw']);
export const resourceTypeSchema = z.enum([
  'SERVER',
  'NODE',
  'NODE_POOL',
  'POLICY',
  'RULE_SET',
  'SUBSCRIPTION',
]);
export const policyMatchSourceSchema = z.enum(['INLINE', 'RULE_SET']);
export const ruleSetSourceTypeSchema = z.enum(['MANUAL', 'REMOTE']);
export const ruleSetFormatSchema = z.enum(['AUTO', 'PROXYHUB_NATIVE', 'PLAIN_TEXT', 'MIHOMO']);
export const ruleSetStatusSchema = z.enum([
  'READY',
  'UPDATING',
  'STALE',
  'ERROR',
  'DISABLED',
  'EMPTY',
]);

const policyBaseSchema = z.object({
  name: z.string().trim().min(2).max(100),
  description: z.string().trim().max(500),
  enabled: z.boolean(),
  defaultAction: policyActionSchema,
  defaultNodePoolId: z.string().trim().min(1).max(80).nullable(),
});

export const createPolicySchema = policyBaseSchema
  .partial({ description: true, enabled: true, defaultNodePoolId: true })
  .extend({
    description: z.string().trim().max(500).default(''),
    enabled: z.boolean().default(true),
    defaultAction: policyActionSchema.default('DIRECT'),
    defaultNodePoolId: z.string().trim().min(1).max(80).nullable().default(null),
  });
export const updatePolicySchema = policyBaseSchema.partial();

export const policyRuleInputSchema = z
  .object({
    name: z.string().trim().min(2).max(100),
    description: z.string().trim().max(500).default(''),
    enabled: z.boolean().default(true),
    matchSourceType: policyMatchSourceSchema.default('INLINE'),
    matchType: policyMatchTypeSchema.default('DOMAIN'),
    matchValue: z.string().trim().max(1000).default(''),
    ruleSetId: z.string().trim().min(1).max(80).nullable().default(null),
    actionType: policyActionSchema,
    nodePoolId: z.string().trim().min(1).max(80).nullable().default(null),
  })
  .superRefine((rule, context) => {
    if (rule.matchSourceType === 'INLINE' && !rule.matchValue) {
      context.addIssue({
        code: 'custom',
        path: ['matchValue'],
        message: 'Match value is required',
      });
    }
    if (rule.matchSourceType === 'RULE_SET' && !rule.ruleSetId) {
      context.addIssue({ code: 'custom', path: ['ruleSetId'], message: 'Rule set is required' });
    }
  });
export const updatePolicyRuleSchema = z.object({
  name: z.string().trim().min(2).max(100).optional(),
  description: z.string().trim().max(500).optional(),
  enabled: z.boolean().optional(),
  matchSourceType: policyMatchSourceSchema.optional(),
  matchType: policyMatchTypeSchema.optional(),
  matchValue: z.string().trim().max(1000).optional(),
  ruleSetId: z.string().trim().min(1).max(80).nullable().optional(),
  actionType: policyActionSchema.optional(),
  nodePoolId: z.string().trim().min(1).max(80).nullable().optional(),
});
export const reorderPolicyRulesSchema = z.object({
  ruleIds: z.array(z.string().trim().min(1).max(80)).max(1000),
});
export const compilePolicySchema = z.object({ format: subscriptionFormatSchema });

export const createRuleSetSchema = z
  .object({
    name: z.string().trim().min(2).max(100),
    description: z.string().trim().max(500).default(''),
    enabled: z.boolean().default(true),
    sourceType: ruleSetSourceTypeSchema,
    format: ruleSetFormatSchema.default('AUTO'),
    sourceUrl: z.string().trim().url().max(2048).nullable().default(null),
    updateIntervalMinutes: z.number().int().min(5).max(43_200).nullable().default(null),
  })
  .superRefine((value, context) => {
    if (value.sourceType === 'REMOTE' && !value.sourceUrl) {
      context.addIssue({ code: 'custom', path: ['sourceUrl'], message: 'Remote URL is required' });
    }
    if (value.sourceType === 'MANUAL' && value.sourceUrl) {
      context.addIssue({
        code: 'custom',
        path: ['sourceUrl'],
        message: 'Manual rule sets cannot have a URL',
      });
    }
  });
export const updateRuleSetSchema = z.object({
  name: z.string().trim().min(2).max(100).optional(),
  description: z.string().trim().max(500).optional(),
  enabled: z.boolean().optional(),
  format: ruleSetFormatSchema.optional(),
  sourceUrl: z.string().trim().url().max(2048).nullable().optional(),
  updateIntervalMinutes: z.number().int().min(5).max(43_200).nullable().optional(),
});
export const ruleSetEntrySchema = z.object({
  type: policyMatchTypeSchema,
  value: z.string().trim().min(1).max(1000),
  enabled: z.boolean().default(true),
});
export const updateRuleSetEntrySchema = ruleSetEntrySchema.partial();
export const bulkRuleSetEntriesSchema = z.object({
  entries: z.array(ruleSetEntrySchema).min(1).max(50_000),
});
export const bulkDeleteRuleSetEntriesSchema = z.object({
  entryIds: z.array(z.string().trim().min(1).max(80)).min(1).max(50_000),
});
export const parseRuleSetPreviewSchema = z.object({
  content: z
    .string()
    .min(1)
    .max(5 * 1024 * 1024),
  format: ruleSetFormatSchema.optional(),
});
export const testRuleSetSourceSchema = z.object({
  url: z.string().trim().url().max(2048),
  format: ruleSetFormatSchema.default('AUTO'),
});

const subscriptionBaseSchema = z.object({
  name: z.string().trim().min(2).max(100),
  policyId: z.string().trim().min(1).max(80),
  format: subscriptionFormatSchema,
  enabled: z.boolean(),
  expiresAt: z.string().datetime({ offset: true }).nullable(),
});
export const createSubscriptionSchema = subscriptionBaseSchema
  .partial({ enabled: true, expiresAt: true })
  .extend({
    enabled: z.boolean().default(true),
    expiresAt: z.string().datetime({ offset: true }).nullable().default(null),
  });
export const updateSubscriptionSchema = subscriptionBaseSchema.partial();
export const subscriptionReadinessInputSchema = subscriptionBaseSchema.partial({
  name: true,
  enabled: true,
  expiresAt: true,
});
export const subscriptionPreviewSchema = z.object({
  format: subscriptionFormatSchema.optional(),
});

export type ResourceType = z.infer<typeof resourceTypeSchema>;
export type DependencyRelationCode =
  | 'SERVER_HAS_NODE'
  | 'NODE_IN_NODE_POOL'
  | 'NODE_POOL_USED_BY_POLICY'
  | 'RULE_SET_USED_BY_POLICY'
  | 'POLICY_USED_BY_SUBSCRIPTION';

export interface ResourceReference {
  resourceType: ResourceType;
  resourceId: string;
  name: string;
  relation: DependencyRelationCode;
  direct: boolean;
}

export interface ResourceDependencyResult {
  resourceType: ResourceType;
  resourceId: string;
  usedBy: ResourceReference[];
  truncated: boolean;
}

export type DeleteImpactStatus = 'SAFE' | 'WARNING' | 'BLOCKED';

export interface DeleteImpactResult extends ResourceDependencyResult {
  status: DeleteImpactStatus;
  codes: string[];
  impacts: Array<{
    code: string;
    severity: 'WARNING' | 'BLOCKING';
    resourceType: ResourceType;
    resourceId: string;
    name: string;
  }>;
}

export type SetupStepStatus =
  'NOT_STARTED' | 'IN_PROGRESS' | 'COMPLETED' | 'BLOCKED' | 'WARNING' | 'NOT_APPLICABLE';

export interface SetupProgressStep {
  id:
    | 'add-server'
    | 'create-node'
    | 'validate-reality'
    | 'create-node-pool'
    | 'create-policy'
    | 'add-rule-set'
    | 'create-subscription'
    | 'check-readiness'
    | 'import-client';
  status: SetupStepStatus;
  targetRoute: string;
  blockingCodes: string[];
}

export interface SetupProgressResult {
  overallStatus: 'NOT_STARTED' | 'IN_PROGRESS' | 'COMPLETED' | 'BLOCKED' | 'WARNING';
  completedSteps: number;
  totalSteps: number;
  steps: SetupProgressStep[];
  generatedAt: string;
}

export type SubscriptionReadinessStatus = 'READY' | 'READY_WITH_WARNINGS' | 'BLOCKED' | 'UNKNOWN';
export type ReadinessCheckStatus = 'PASSED' | 'WARNING' | 'FAILED' | 'UNKNOWN';
export type CompileStage =
  | 'DEPENDENCY_RESOLUTION'
  | 'CAPABILITY_CHECK'
  | 'RULE_SET_RESOLUTION'
  | 'NODE_RESOLUTION'
  | 'POLICY_VALIDATION'
  | 'COMPILER'
  | 'SERIALIZATION'
  | 'OUTPUT_VALIDATION';

export interface SubscriptionReadinessCheck {
  id: string;
  status: ReadinessCheckStatus;
  titleCode: string;
  summaryCode: string;
  resourceType?: ResourceType | 'POLICY_RULE' | undefined;
  resourceId?: string | undefined;
  resourceName?: string | undefined;
  field?: string | undefined;
  errorCode?: string | undefined;
  recommendations: string[];
  blocking: boolean;
  stage: CompileStage;
}

export interface SubscriptionReadinessResult {
  status: SubscriptionReadinessStatus;
  subscriptionId?: string;
  format?: z.infer<typeof subscriptionFormatSchema>;
  checks: SubscriptionReadinessCheck[];
  blockingCount: number;
  warningCount: number;
  checkedAt: string;
  durationMs: number;
}

export const bootstrapSchema = z.object({
  username: z
    .string()
    .trim()
    .min(3)
    .max(40)
    .regex(/^[a-zA-Z0-9_.-]+$/),
  password: z.string().min(12).max(128),
});

export const loginSchema = z.object({
  username: z.string().trim().min(1),
  password: z.string().min(1),
  totp: z
    .string()
    .regex(/^\d{6}$/)
    .optional(),
  recoveryCode: z.string().min(8).optional(),
});

export interface ApiErrorBody {
  success: false;
  error: { code: string; message: string; details?: unknown };
}

export interface ApiSuccess<T> {
  success: true;
  data: T;
}

export type ApiResponse<T> = ApiSuccess<T> | ApiErrorBody;

export type XrayHealthState = 'HEALTHY' | 'DEGRADED' | 'OFFLINE' | 'UNKNOWN';

export interface XrayHealthStatus {
  status: XrayHealthState;
  running: boolean;
  version: string | null;
  checkedAt: string;
  checks: {
    process: { healthy: boolean; pid: number | null };
    container: { healthy: boolean; heartbeatAt: string | null };
    ports: { healthy: boolean; known: boolean; configured: number[]; listening: number[] };
    config: { healthy: boolean; message: string | null };
  };
}

export interface AgentStatusData {
  agent: { version: string; hostname: string; uptime: number };
  system: { cpuCount: number; load: number; memoryUsage: number };
  xray: XrayHealthStatus;
}

export interface ProxyHubBuildMetadata {
  version: string;
  gitSha: string;
  gitShortSha: string;
  buildTime: string;
  buildEnvironment: string;
  deployMode: string;
  xrayVersion: string;
  database: {
    migrationFingerprint: string;
  };
}

export interface ProxyHubHealthData extends ProxyHubBuildMetadata {
  status: 'ok';
}

export const EVENT_TYPES = [
  'NODE_CREATED',
  'NODE_UPDATED',
  'NODE_OFFLINE',
  'NODE_ONLINE',
  'XRAY_CRASHED',
  'XRAY_RESTARTED',
  'SERVER_OFFLINE',
  'SERVER_ONLINE',
  'LOGIN_NEW_IP',
  'LOGIN_FAILED',
  'TOTP_FAILED',
] as const;
