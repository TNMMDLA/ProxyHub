import { describe, expect, it } from 'vitest';
import {
  aggregateStatus,
  classifyFreshness,
  containsDiagnosticSecret,
  createDiagnosticItem,
  diagnosticItemSchema,
  ERROR_RECOMMENDATIONS,
  redactDiagnostics,
} from './index.js';

const item = (status: 'HEALTHY' | 'WARNING' | 'CRITICAL' | 'UNKNOWN' | 'NOT_AVAILABLE') =>
  createDiagnosticItem({
    id: `runtime.test-${status.toLowerCase().replaceAll('_', '-')}`,
    category: 'RUNTIME',
    status,
    title: 'Test',
    summary: 'Test diagnostic',
    observedAt: new Date().toISOString(),
    source: 'test',
    scope: 'application',
    durationMs: 1,
    details: {},
    recommendations: [],
    errorCode: null,
  });

describe('diagnostics core', () => {
  it.each(['HEALTHY', 'WARNING', 'CRITICAL', 'UNKNOWN', 'NOT_AVAILABLE'] as const)(
    'validates %s',
    (status) => expect(diagnosticItemSchema.parse(item(status)).status).toBe(status),
  );
  it('uses stable ids', () => expect(item('HEALTHY').id).toBe('runtime.test-healthy'));
  it('rejects display labels as ids', () =>
    expect(() =>
      diagnosticItemSchema.parse({ ...item('HEALTHY'), id: 'Runtime Health' }),
    ).toThrow());
  it('aggregates the worst status', () =>
    expect(aggregateStatus([item('HEALTHY'), item('WARNING'), item('UNKNOWN')])).toBe('WARNING'));
  it('classifies fresh data', () =>
    expect(classifyFreshness(new Date(99_000), new Date(100_000), 5_000, 10_000)).toBe('FRESH'));
  it('classifies stale data', () =>
    expect(classifyFreshness(new Date(94_000), new Date(100_000), 5_000, 10_000)).toBe('STALE'));
  it('classifies expired data', () =>
    expect(classifyFreshness(new Date(80_000), new Date(100_000), 5_000, 10_000)).toBe('EXPIRED'));
  it('classifies missing timestamps as unknown', () =>
    expect(classifyFreshness(null)).toBe('UNKNOWN'));
  it('maps recommendations', () =>
    expect(ERROR_RECOMMENDATIONS.AGENT_UNAVAILABLE).toContain('Agent'));
  it('redacts secret keys', () =>
    expect(redactDiagnostics({ token: 'unsafe', nested: { password: 'unsafe' } })).toEqual({
      token: '[REDACTED]',
      nested: { password: '[REDACTED]' },
    }));
  it('redacts absolute paths', () =>
    expect(redactDiagnostics({ location: '/var/lib/proxyhub/data' })).toEqual({
      location: '[PATH REDACTED]',
    }));
  it('detects bearer tokens', () =>
    expect(containsDiagnosticSecret({ value: 'Bearer abcdefghijklmnop' })).toBe(true));
  it.each([
    ['authorization', 'value'],
    ['cookie', 'value'],
    ['token', 'value'],
    ['secret', 'value'],
    ['password', 'value'],
    ['privateKey', 'value'],
    ['uuid', 'value'],
    ['shortId', 'value'],
    ['DATABASE_URL', 'value'],
  ])('redacts sensitive key %s', (key, value) =>
    expect(redactDiagnostics({ [key]: value })).toEqual({ [key]: '[REDACTED]' }),
  );
  it.each([
    '/app/data/proxyhub.db',
    '/opt/proxyhub/state',
    '/home/operator/config',
    '/root/private',
    '/run/proxyhub/xray.pid',
    '/etc/xray/config.json',
    '/var/lib/proxyhub',
    '/tmp/diagnostics',
    'C:\\Users\\operator\\state.json',
  ])('redacts absolute path %s', (path) =>
    expect(redactDiagnostics({ path })).toEqual({ path: '[PATH REDACTED]' }),
  );
  it.each([
    ['HEALTHY', 'INFO'],
    ['WARNING', 'WARNING'],
    ['CRITICAL', 'CRITICAL'],
    ['UNKNOWN', 'INFO'],
    ['NOT_AVAILABLE', 'INFO'],
  ] as const)('maps %s to %s severity', (status, severity) =>
    expect(item(status).severity).toBe(severity),
  );
});
