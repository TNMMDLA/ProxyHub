import { describe, expect, it } from 'vitest';
import {
  analyzePerformance,
  calculateEfficiency,
  calculateJitter,
  calculatePerformanceScore,
  detectTargetPathOutliers,
  finalRunStatus,
  median,
  parseTargetRegistry,
  percentile,
  type NetworkPerformanceTargetResult,
} from './index.js';

function target(
  id: string,
  directMbps: number | null,
  tunnelMbps: number | null,
  options: { success?: boolean; jitter?: number; latency?: number; failed?: number } = {},
): NetworkPerformanceTargetResult {
  const success = options.success ?? true;
  return {
    targetId: id,
    targetLabel: id,
    success,
    ...(success ? {} : { errorCode: 'NETWORK_PERFORMANCE_TARGET_UNREACHABLE' }),
    direct: {
      downloadMbps: directMbps,
      downloadSamplesMbps: directMbps === null ? [] : [directMbps],
      latencyMedianMs: options.latency ?? 20,
      latencyP95Ms: options.latency ?? 20,
      jitterMs: options.jitter ?? 2,
      successfulRequests: success ? 5 : 0,
      failedRequests: options.failed ?? (success ? 0 : 5),
    },
    tunnel: {
      downloadMbps: tunnelMbps,
      downloadSamplesMbps: tunnelMbps === null ? [] : [tunnelMbps],
      latencyMedianMs: options.latency ?? 25,
      latencyP95Ms: options.latency ?? 25,
      jitterMs: options.jitter ?? 2,
      successfulRequests: success ? 5 : 0,
      failedRequests: options.failed ?? (success ? 0 : 5),
    },
    efficiencyPercent: calculateEfficiency(tunnelMbps, directMbps),
    uploadStatus: 'NOT_AVAILABLE',
    analysisCodes: [],
  };
}

describe('network performance metrics', () => {
  it('calculates medians without allowing NaN or Infinity to contaminate the result', () => {
    expect(median([68, 55, 6, 61])).toBe(58);
    expect(median([Number.NaN, Number.POSITIVE_INFINITY])).toBeNull();
    expect(median([])).toBeNull();
  });

  it('uses nearest-rank percentiles', () => {
    expect(percentile([10, 20, 30, 40, 50], 95)).toBe(50);
    expect(percentile([], 95)).toBeNull();
  });

  it('defines jitter as the mean absolute difference between consecutive RTT samples', () => {
    expect(calculateJitter([10, 14, 11, 17])).toBeCloseTo(13 / 3);
    expect(calculateJitter([10])).toBe(0);
    expect(calculateJitter([])).toBeNull();
  });

  it('calculates bounded efficiency and rejects zero division and non-finite values', () => {
    expect(calculateEfficiency(90, 100)).toBe(90);
    expect(calculateEfficiency(9, 10)).toBe(90);
    expect(calculateEfficiency(1, 0)).toBeNull();
    expect(calculateEfficiency(Number.NaN, 10)).toBeNull();
    expect(calculateEfficiency(Number.POSITIVE_INFINITY, 10)).toBeNull();
  });
});

describe('network performance scoring and analysis', () => {
  it('scores relative tunnel efficiency instead of raw target throughput', () => {
    const score = calculatePerformanceScore([target('fast', 100, 90), target('slow', 10, 9)]);
    expect(score.throughput).toBe(90);
    expect(score.successRate).toBe(100);
    expect(score.overall).toBeGreaterThanOrEqual(85);
  });

  it('marks one strong path deviation without declaring the node failed', () => {
    const results = [
      target('a', 70, 68),
      target('b', 65, 61),
      target('c', 60, 55),
      target('outlier', 10, 6),
    ];
    expect(detectTargetPathOutliers(results)).toEqual(new Set(['outlier']));
    expect(analyzePerformance(results)).toContain('TARGET_PATH_DEGRADED');
    expect(analyzePerformance(results)).not.toContain('ALL_TARGETS_FAILED');
  });

  it('recognizes healthy tunnel efficiency despite different raw target speeds', () => {
    const codes = analyzePerformance([
      target('a', 100, 92),
      target('b', 80, 75),
      target('c', 10, 9),
    ]);
    expect(codes).toContain('TUNNEL_EFFICIENCY_HEALTHY');
    expect(codes).not.toContain('TUNNEL_PERFORMANCE_DEGRADED');
  });

  it('recognizes broad tunnel degradation against healthy direct baselines', () => {
    const codes = analyzePerformance([target('a', 100, 8), target('b', 80, 6), target('c', 90, 7)]);
    expect(codes).toContain('TUNNEL_PERFORMANCE_DEGRADED');
  });

  it('distinguishes a slow direct path from tunnel overhead', () => {
    const codes = analyzePerformance([target('a', 5, 4.5), target('b', 6, 5.5), target('c', 7, 6)]);
    expect(codes).toContain('SERVER_EGRESS_OR_TARGET_PATH_SLOW');
    expect(codes).toContain('TUNNEL_EFFICIENCY_HEALTHY');
  });

  it('preserves partial results instead of failing the entire run', () => {
    expect(
      finalRunStatus([target('ok', 10, 9), target('failed', null, null, { success: false })]),
    ).toBe('PARTIAL');
    expect(finalRunStatus([target('failed', null, null, { success: false })])).toBe('FAILED');
    expect(finalRunStatus([target('ok', 10, 9)])).toBe('COMPLETED');
  });
});

describe('network performance target registry', () => {
  it('accepts one to five configured HTTPS targets and applies safe defaults', () => {
    const parsed = parseTargetRegistry(
      JSON.stringify([
        {
          id: 'fixture',
          label: 'Fixture',
          smallRequestUrl: 'https://fixture.example/small',
          downloadUrl: 'https://fixture.example/download',
          enabled: true,
        },
      ]),
    );
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.maxDownloadBytes).toBe(16 * 1024 * 1024);
  });

  it.each([
    ['empty registry', '[]'],
    [
      'HTTP URL',
      JSON.stringify([
        {
          id: 'bad',
          label: 'Bad',
          smallRequestUrl: 'http://example.com/small',
          downloadUrl: 'https://example.com/download',
          enabled: true,
        },
      ]),
    ],
    [
      'duplicate IDs',
      JSON.stringify([
        {
          id: 'same',
          label: 'One',
          smallRequestUrl: 'https://one.example/small',
          downloadUrl: 'https://one.example/download',
          enabled: true,
        },
        {
          id: 'same',
          label: 'Two',
          smallRequestUrl: 'https://two.example/small',
          downloadUrl: 'https://two.example/download',
          enabled: true,
        },
      ]),
    ],
  ])('rejects %s', (_name, value) => {
    expect(() => parseTargetRegistry(value)).toThrow();
  });

  it('does not invent a public target registry when the environment is absent', () => {
    expect(parseTargetRegistry(undefined)).toEqual([]);
  });
});
