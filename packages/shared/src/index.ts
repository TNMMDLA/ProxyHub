import { z } from 'zod';

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
  dest: z.string().trim().min(1).max(300).default('www.microsoft.com:443'),
  fingerprint: z.string().trim().default('chrome'),
});

export const updateNodeSchema = createNodeSchema.omit({ serverId: true }).partial().extend({
  enabled: z.boolean().optional(),
});

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

export const policyRuleInputSchema = z.object({
  name: z.string().trim().min(2).max(100),
  description: z.string().trim().max(500).default(''),
  enabled: z.boolean().default(true),
  matchType: policyMatchTypeSchema,
  matchValue: z.string().trim().min(1).max(1000),
  actionType: policyActionSchema,
  nodePoolId: z.string().trim().min(1).max(80).nullable().default(null),
});
export const updatePolicyRuleSchema = z.object({
  name: z.string().trim().min(2).max(100).optional(),
  description: z.string().trim().max(500).optional(),
  enabled: z.boolean().optional(),
  matchType: policyMatchTypeSchema.optional(),
  matchValue: z.string().trim().min(1).max(1000).optional(),
  actionType: policyActionSchema.optional(),
  nodePoolId: z.string().trim().min(1).max(80).nullable().optional(),
});
export const reorderPolicyRulesSchema = z.object({
  ruleIds: z.array(z.string().trim().min(1).max(80)).max(1000),
});
export const compilePolicySchema = z.object({ format: subscriptionFormatSchema });

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
