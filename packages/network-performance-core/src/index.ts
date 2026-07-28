import { z } from 'zod';

export const NETWORK_PERFORMANCE_MAX_TARGETS = 5;
export const NETWORK_PERFORMANCE_HISTORY_LIMIT = 10;

export const networkPerformanceRunStatusSchema = z.enum([
  'QUEUED',
  'RUNNING',
  'COMPLETED',
  'PARTIAL',
  'FAILED',
  'CANCELLED',
  'INTERRUPTED',
]);
export type NetworkPerformanceRunStatus = z.infer<typeof networkPerformanceRunStatusSchema>;

export const networkPerformanceRatingSchema = z.enum([
  'EXCELLENT',
  'GOOD',
  'FAIR',
  'POOR',
  'CRITICAL',
  'UNKNOWN',
]);
export type NetworkPerformanceRating = z.infer<typeof networkPerformanceRatingSchema>;

const httpsUrl = z
  .string()
  .url()
  .max(2_048)
  .refine((value) => new URL(value).protocol === 'https:', 'Only HTTPS targets are allowed');

export const networkPerformanceTargetSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/i),
    label: z.string().trim().min(1).max(80),
    smallRequestUrl: httpsUrl,
    downloadUrl: httpsUrl,
    enabled: z.boolean().default(true),
    maxDownloadBytes: z
      .number()
      .int()
      .min(64 * 1024)
      .max(100 * 1024 * 1024)
      .default(16 * 1024 * 1024),
    upload: z
      .object({
        url: httpsUrl,
        maxUploadBytes: z
          .number()
          .int()
          .min(64 * 1024)
          .max(16 * 1024 * 1024),
      })
      .optional(),
  })
  .strict();
export type NetworkPerformanceTarget = z.infer<typeof networkPerformanceTargetSchema>;

export const networkPerformanceTargetRegistrySchema = z
  .array(networkPerformanceTargetSchema)
  .min(1)
  .max(NETWORK_PERFORMANCE_MAX_TARGETS)
  .superRefine((targets, context) => {
    const ids = new Set<string>();
    for (const [index, target] of targets.entries()) {
      if (ids.has(target.id)) {
        context.addIssue({
          code: 'custom',
          path: [index, 'id'],
          message: 'Target IDs must be unique',
        });
      }
      ids.add(target.id);
    }
    if (!targets.some((target) => target.enabled)) {
      context.addIssue({ code: 'custom', message: 'At least one target must be enabled' });
    }
  });

export function parseTargetRegistry(value: string | undefined): NetworkPerformanceTarget[] {
  if (!value?.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error('PROXYHUB_NETWORK_PERF_TARGETS_JSON must contain valid JSON');
  }
  return networkPerformanceTargetRegistrySchema.parse(parsed).filter((target) => target.enabled);
}

export interface NetworkPerformancePathMetrics {
  downloadMbps: number | null;
  downloadSamplesMbps: number[];
  latencyMedianMs: number | null;
  latencyP95Ms: number | null;
  jitterMs: number | null;
  successfulRequests: number;
  failedRequests: number;
}

export interface NetworkPerformanceTargetResult {
  targetId: string;
  targetLabel: string;
  success: boolean;
  errorCode?: string;
  direct: NetworkPerformancePathMetrics;
  tunnel: NetworkPerformancePathMetrics;
  efficiencyPercent: number | null;
  uploadStatus: 'NOT_AVAILABLE';
  analysisCodes: string[];
}

export interface NetworkPerformanceScore {
  overall: number | null;
  throughput: number | null;
  successRate: number;
  stability: number | null;
  connectionRating: NetworkPerformanceRating;
  throughputRating: NetworkPerformanceRating;
  stabilityRating: NetworkPerformanceRating;
  overallRating: NetworkPerformanceRating;
}

export interface NetworkPerformanceProgress {
  stage: 'PREPARING' | 'ESTABLISHING_TUNNEL' | 'TESTING_TARGET' | 'CALCULATING' | 'COMPLETED';
  currentTarget: number;
  totalTargets: number;
  remainingSteps: number;
}

export interface NetworkPerformanceEnvironment {
  source: 'PROXYHUB_SERVER';
  serverName: string;
  serverRegion: string;
  nodeName: string;
  nodePort: number;
  protocol: string;
  transport: string;
  security: string;
  flow: string;
  realityTarget: string;
  sni: string;
  xrayVersion: string;
  proxyhubVersion: string;
  gitSha: string;
  deployMode: string;
  testedAt: string;
}

export interface NetworkPerformanceResult {
  status: Exclude<NetworkPerformanceRunStatus, 'QUEUED' | 'RUNNING'>;
  score: NetworkPerformanceScore;
  tunnelEstablishmentMs: number | null;
  targets: NetworkPerformanceTargetResult[];
  medianDirectMbps: number | null;
  medianTunnelMbps: number | null;
  successRatePercent: number;
  analysisCodes: string[];
  durationMs: number;
  environment: NetworkPerformanceEnvironment;
}

function finite(values: readonly number[]): number[] {
  return values.filter((value) => Number.isFinite(value));
}

export function median(values: readonly number[]): number | null {
  const sorted = finite(values).sort((left, right) => left - right);
  if (sorted.length === 0) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
}

export function percentile(values: readonly number[], percentileValue: number): number | null {
  const sorted = finite(values).sort((left, right) => left - right);
  if (sorted.length === 0) return null;
  const bounded = Math.min(100, Math.max(0, percentileValue));
  const index = Math.max(0, Math.ceil((bounded / 100) * sorted.length) - 1);
  return sorted[index]!;
}

export function calculateJitter(latencies: readonly number[]): number | null {
  const samples = finite(latencies);
  if (samples.length < 2) return samples.length === 1 ? 0 : null;
  const differences = samples.slice(1).map((value, index) => Math.abs(value - samples[index]!));
  return differences.reduce((total, value) => total + value, 0) / differences.length;
}

export function calculateEfficiency(
  tunnelMbps: number | null,
  directMbps: number | null,
): number | null {
  if (
    tunnelMbps === null ||
    directMbps === null ||
    !Number.isFinite(tunnelMbps) ||
    !Number.isFinite(directMbps) ||
    tunnelMbps < 0 ||
    directMbps <= 0
  ) {
    return null;
  }
  return Math.max(0, Math.min(200, (tunnelMbps / directMbps) * 100));
}

export function ratingForScore(score: number | null): NetworkPerformanceRating {
  if (score === null || !Number.isFinite(score)) return 'UNKNOWN';
  if (score >= 85) return 'EXCELLENT';
  if (score >= 70) return 'GOOD';
  if (score >= 50) return 'FAIR';
  if (score >= 30) return 'POOR';
  return 'CRITICAL';
}

export function detectTargetPathOutliers(
  results: readonly NetworkPerformanceTargetResult[],
): Set<string> {
  const successful = results.filter(
    (result) =>
      result.success &&
      result.tunnel.downloadMbps !== null &&
      Number.isFinite(result.tunnel.downloadMbps),
  );
  if (successful.length < 3) return new Set();
  const baseline = median(successful.map((result) => result.tunnel.downloadMbps!));
  if (baseline === null || baseline <= 0) return new Set();
  return new Set(
    successful
      .filter((result) => result.tunnel.downloadMbps! < baseline * 0.35)
      .map((result) => result.targetId),
  );
}

export function calculatePerformanceScore(
  results: readonly NetworkPerformanceTargetResult[],
): NetworkPerformanceScore {
  const efficiencies = results
    .map((result) => result.efficiencyPercent)
    .filter((value): value is number => value !== null && Number.isFinite(value));
  const requestSuccesses = results.reduce(
    (total, result) => total + result.tunnel.successfulRequests,
    0,
  );
  const requestAttempts = results.reduce(
    (total, result) => total + result.tunnel.successfulRequests + result.tunnel.failedRequests,
    0,
  );
  const throughput = median(efficiencies);
  const successRate = requestAttempts === 0 ? 0 : (requestSuccesses / requestAttempts) * 100;
  const stabilityValues = results
    .filter(
      (result) =>
        result.tunnel.latencyMedianMs !== null &&
        result.tunnel.latencyMedianMs > 0 &&
        result.tunnel.jitterMs !== null,
    )
    .map((result) =>
      Math.max(0, 100 - (result.tunnel.jitterMs! / result.tunnel.latencyMedianMs!) * 100),
    );
  const stability = median(stabilityValues);
  const overall =
    throughput === null || stability === null
      ? null
      : Math.round(
          Math.min(100, throughput) * 0.5 +
            Math.min(100, successRate) * 0.3 +
            Math.min(100, stability) * 0.2,
        );
  return {
    overall,
    throughput,
    successRate,
    stability,
    connectionRating: ratingForScore(successRate),
    throughputRating: ratingForScore(throughput),
    stabilityRating: ratingForScore(stability),
    overallRating: ratingForScore(overall),
  };
}

export function analyzePerformance(results: readonly NetworkPerformanceTargetResult[]): string[] {
  if (results.length === 0) return ['NO_TARGET_RESULTS'];
  const codes = new Set<string>();
  const outliers = detectTargetPathOutliers(results);
  if (outliers.size > 0) codes.add('TARGET_PATH_DEGRADED');
  const directMedian = median(
    results
      .map((result) => result.direct.downloadMbps)
      .filter((value): value is number => value !== null),
  );
  const efficiencyMedian = median(
    results
      .map((result) => result.efficiencyPercent)
      .filter((value): value is number => value !== null),
  );
  if (directMedian !== null && directMedian < 10 && (efficiencyMedian ?? 0) >= 70) {
    codes.add('SERVER_EGRESS_OR_TARGET_PATH_SLOW');
  }
  if (efficiencyMedian !== null && efficiencyMedian < 30) {
    codes.add('TUNNEL_PERFORMANCE_DEGRADED');
  } else if (efficiencyMedian !== null && efficiencyMedian >= 80) {
    codes.add('TUNNEL_EFFICIENCY_HEALTHY');
  }
  if (results.every((result) => !result.success)) codes.add('ALL_TARGETS_FAILED');
  return [...codes];
}

export function finalRunStatus(
  results: readonly NetworkPerformanceTargetResult[],
): 'COMPLETED' | 'PARTIAL' | 'FAILED' {
  const successes = results.filter((result) => result.success).length;
  if (successes === 0) return 'FAILED';
  return successes === results.length ? 'COMPLETED' : 'PARTIAL';
}
