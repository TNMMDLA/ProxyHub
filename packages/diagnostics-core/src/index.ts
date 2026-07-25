import { z } from 'zod';

export const diagnosticStatusSchema = z.enum([
  'HEALTHY',
  'WARNING',
  'CRITICAL',
  'UNKNOWN',
  'NOT_AVAILABLE',
  'NOT_APPLICABLE',
]);
export const diagnosticSeveritySchema = z.enum(['INFO', 'WARNING', 'ERROR', 'CRITICAL']);
export const diagnosticCategorySchema = z.enum([
  'SYSTEM',
  'RUNTIME',
  'NETWORK',
  'DATABASE',
  'STORAGE',
  'OPERATIONS',
  'BACKUP',
  'RELEASE',
  'RULE_SET',
  'SUBSCRIPTION',
  'REALITY',
  'SECURITY',
]);
export const diagnosticFreshnessSchema = z.enum(['FRESH', 'STALE', 'EXPIRED', 'UNKNOWN']);
export const diagnosticScopeSchema = z.enum([
  'host',
  'container',
  'cgroup',
  'process',
  'database-filesystem',
  'application',
  'unknown',
]);

const safeDetailSchema = z.union([
  z.string().max(2_000),
  z.number().finite(),
  z.boolean(),
  z.null(),
  z.array(z.union([z.string().max(2_000), z.number().finite(), z.boolean(), z.null()])).max(100),
]);

export const diagnosticItemSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9.-]{2,120}$/),
  category: diagnosticCategorySchema,
  status: diagnosticStatusSchema,
  severity: diagnosticSeveritySchema,
  title: z.string().min(1).max(160),
  summary: z.string().min(1).max(1_000),
  observedAt: z.iso.datetime(),
  source: z.string().min(1).max(80),
  scope: diagnosticScopeSchema,
  durationMs: z.number().int().nonnegative().max(300_000),
  freshness: diagnosticFreshnessSchema,
  details: z.record(z.string().max(80), safeDetailSchema),
  recommendations: z.array(z.string().min(1).max(500)).max(20),
  errorCode: z
    .string()
    .regex(/^[A-Z][A-Z0-9_]{2,100}$/)
    .nullable(),
});

export const diagnosticsReportSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.enum(['overview', 'deep', 'section', 'export']),
  status: diagnosticStatusSchema,
  generatedAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  durationMs: z.number().int().nonnegative().max(300_000),
  cached: z.boolean(),
  items: z.array(diagnosticItemSchema).max(500),
});

export type DiagnosticStatus = z.infer<typeof diagnosticStatusSchema>;
export type DiagnosticSeverity = z.infer<typeof diagnosticSeveritySchema>;
export type DiagnosticCategory = z.infer<typeof diagnosticCategorySchema>;
export type DiagnosticFreshness = z.infer<typeof diagnosticFreshnessSchema>;
export type DiagnosticScope = z.infer<typeof diagnosticScopeSchema>;
export type DiagnosticItem = z.infer<typeof diagnosticItemSchema>;
export type DiagnosticsReport = z.infer<typeof diagnosticsReportSchema>;

const STATUS_WEIGHT: Record<DiagnosticStatus, number> = {
  HEALTHY: 0,
  NOT_APPLICABLE: 0,
  UNKNOWN: 1,
  NOT_AVAILABLE: 1,
  WARNING: 2,
  CRITICAL: 3,
};

export function aggregateStatus(items: readonly DiagnosticItem[]): DiagnosticStatus {
  if (items.length === 0) return 'UNKNOWN';
  return items.reduce<DiagnosticStatus>(
    (worst, item) => (STATUS_WEIGHT[item.status] > STATUS_WEIGHT[worst] ? item.status : worst),
    'HEALTHY',
  );
}

export function statusSeverity(status: DiagnosticStatus): DiagnosticSeverity {
  if (status === 'CRITICAL') return 'CRITICAL';
  if (status === 'WARNING') return 'WARNING';
  return 'INFO';
}

export function classifyFreshness(
  observedAt: string | Date | null,
  now = new Date(),
  staleAfterMs = 30_000,
  expiredAfterMs = 300_000,
): DiagnosticFreshness {
  if (!observedAt) return 'UNKNOWN';
  const timestamp = new Date(observedAt).getTime();
  if (!Number.isFinite(timestamp)) return 'UNKNOWN';
  const age = Math.max(0, now.getTime() - timestamp);
  return age >= expiredAfterMs ? 'EXPIRED' : age >= staleAfterMs ? 'STALE' : 'FRESH';
}

export function createDiagnosticItem(
  input: Omit<DiagnosticItem, 'severity' | 'freshness'> & {
    severity?: DiagnosticSeverity;
    freshness?: DiagnosticFreshness;
  },
): DiagnosticItem {
  return diagnosticItemSchema.parse({
    ...input,
    severity: input.severity ?? statusSeverity(input.status),
    freshness: input.freshness ?? classifyFreshness(input.observedAt),
  });
}

export const ERROR_RECOMMENDATIONS: Record<string, string> = {
  AGENT_UNAVAILABLE: 'Check the Agent container health and the internal Agent URL.',
  XRAY_UNHEALTHY: 'Inspect Xray process, configuration validation, and listening ports.',
  DATABASE_UNAVAILABLE: 'Check the SQLite volume, file permissions, and Server logs.',
  DATABASE_QUICK_CHECK_FAILED: 'Stop writes and verify the latest known-good database backup.',
  STATE_NOT_AVAILABLE: 'Mount the Phase 1 state directory read-only into the Server container.',
  BACKUP_NOT_AVAILABLE: 'Mount the Phase 1 backup directory read-only into the Server container.',
  DIAGNOSTICS_TIMEOUT: 'Retry the manual scan after current load decreases.',
  OPERATIONS_STATE_INVALID: 'Inspect the Phase 1 operations state files on the host.',
};

const SECRET_KEY =
  /(authorization|cookie|token|secret|password|private.?key|uuid|short.?id|database_url)/i;
const SECRET_VALUE =
  /(bearer\s+[a-z0-9._~+/-]{8,}|(?:https?|file):\/\/[^/\s:@]+:[^@\s/]+@|[a-f0-9]{32,}|[a-z0-9_-]{40,})/i;
const ABSOLUTE_PATH = /(?:[a-z]:\\|\/(?:app|opt|home|root|run|etc|var|tmp)\/)/i;

export function redactDiagnostics<T>(value: T): T {
  const seen = new WeakSet<object>();
  const visit = (current: unknown, key = ''): unknown => {
    if (SECRET_KEY.test(key)) return '[REDACTED]';
    if (typeof current === 'string') {
      if (SECRET_VALUE.test(current)) return '[REDACTED]';
      if (ABSOLUTE_PATH.test(current)) return '[PATH REDACTED]';
      return current.slice(0, 2_000);
    }
    if (Array.isArray(current)) return current.slice(0, 100).map((item) => visit(item));
    if (current && typeof current === 'object') {
      if (seen.has(current)) return '[CIRCULAR]';
      seen.add(current);
      return Object.fromEntries(
        Object.entries(current)
          .slice(0, 100)
          .map(([childKey, child]) => [childKey, visit(child, childKey)]),
      );
    }
    return current;
  };
  return visit(value) as T;
}

export function containsDiagnosticSecret(value: unknown): boolean {
  const serialized = JSON.stringify(value);
  return SECRET_VALUE.test(serialized) || ABSOLUTE_PATH.test(serialized);
}

export class DiagnosticsError extends Error {
  constructor(
    readonly code:
      | 'DIAGNOSTICS_SCAN_BUSY'
      | 'DIAGNOSTICS_SCAN_TIMEOUT'
      | 'DIAGNOSTICS_SCAN_CANCELLED'
      | 'DIAGNOSTICS_EXPORT_REDACTION_FAILED',
    message: string,
  ) {
    super(message);
    this.name = 'DiagnosticsError';
  }
}
