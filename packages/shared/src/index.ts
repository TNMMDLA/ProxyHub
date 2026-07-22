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
