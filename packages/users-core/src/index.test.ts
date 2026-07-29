import { describe, expect, it } from 'vitest';
import {
  counterDelta,
  cycleWindow,
  effectiveUserStatus,
  parseXrayUserMetrics,
  shouldResetMonthlyCycle,
  statsIdentity,
  trafficDelta,
} from './index.js';

const active = {
  adminEnabled: true,
  expiresAt: null,
  trafficLimitBytes: null,
  currentCycleUplinkBytes: 0n,
  currentCycleDownlinkBytes: 0n,
};

describe('user status', () => {
  it('applies disabled, expired, exhausted, active priority', () => {
    const now = new Date('2026-07-29T00:00:00Z');
    expect(
      effectiveUserStatus(
        {
          ...active,
          adminEnabled: false,
          expiresAt: new Date('2020-01-01T00:00:00Z'),
          trafficLimitBytes: 1n,
          currentCycleUplinkBytes: 1n,
        },
        now,
      ),
    ).toBe('DISABLED');
    expect(
      effectiveUserStatus({ ...active, expiresAt: new Date('2020-01-01T00:00:00Z') }, now),
    ).toBe('EXPIRED');
    expect(
      effectiveUserStatus({
        ...active,
        trafficLimitBytes: 10n,
        currentCycleUplinkBytes: 4n,
        currentCycleDownlinkBytes: 6n,
      }),
    ).toBe('TRAFFIC_EXHAUSTED');
    expect(effectiveUserStatus(active)).toBe('ACTIVE');
  });
});

describe('traffic accounting primitives', () => {
  it('calculates increases, identical snapshots, and runtime resets', () => {
    expect(counterDelta(1000n, 1500n)).toBe(500n);
    expect(counterDelta(1500n, 1500n)).toBe(0n);
    expect(counterDelta(1500n, 25n)).toBe(25n);
    expect(
      trafficDelta(
        { uplinkBytes: 10n, downlinkBytes: 20n },
        { uplinkBytes: 15n, downlinkBytes: 2n },
      ),
    ).toEqual({ uplinkBytes: 5n, downlinkBytes: 2n });
  });

  it('preserves huge integer precision and rejects malformed metrics', () => {
    const huge = '9223372036854775000';
    expect(
      parseXrayUserMetrics({
        stats: { user: { opaque: { uplink: huge, downlink: 7 } } },
      }),
    ).toEqual([{ statsIdentity: 'opaque', uplinkBytes: BigInt(huge), downlinkBytes: 7n }]);
    expect(() => parseXrayUserMetrics({ stats: { user: { opaque: { uplink: -1 } } } })).toThrow(
      'TRAFFIC_COUNTER_INVALID',
    );
  });
});

describe('traffic cycles', () => {
  it('calculates UTC monthly windows across a month boundary', () => {
    expect(cycleWindow('MONTHLY', 5, new Date('2026-07-03T12:00:00Z'))).toEqual({
      startedAt: new Date('2026-06-05T00:00:00Z'),
      endsAt: new Date('2026-07-05T00:00:00Z'),
    });
    expect(
      shouldResetMonthlyCycle(
        'MONTHLY',
        new Date('2026-07-05T00:00:00Z'),
        new Date('2026-07-05T00:00:00Z'),
      ),
    ).toBe(true);
  });

  it('creates stable non-PII access identities', () => {
    expect(statsIdentity('user_opaque', 'access_opaque')).toBe('phu-user_opaque-access_opaque');
  });
});
