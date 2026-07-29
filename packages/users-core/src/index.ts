export type EffectiveUserStatus = 'ACTIVE' | 'DISABLED' | 'EXPIRED' | 'TRAFFIC_EXHAUSTED';
export type TrafficResetPolicy = 'NEVER' | 'MONTHLY';

export interface UserStatusInput {
  adminEnabled: boolean;
  expiresAt: Date | string | null;
  trafficLimitBytes: bigint | null;
  currentCycleUplinkBytes: bigint;
  currentCycleDownlinkBytes: bigint;
}

export interface TrafficCounter {
  uplinkBytes: bigint;
  downlinkBytes: bigint;
}

export interface XrayUserMetric {
  statsIdentity: string;
  uplinkBytes: bigint;
  downlinkBytes: bigint;
}

export function currentCycleTotal(input: {
  currentCycleUplinkBytes: bigint;
  currentCycleDownlinkBytes: bigint;
}): bigint {
  return input.currentCycleUplinkBytes + input.currentCycleDownlinkBytes;
}

export function effectiveUserStatus(input: UserStatusInput, now = new Date()): EffectiveUserStatus {
  if (!input.adminEnabled) return 'DISABLED';
  if (input.expiresAt !== null && new Date(input.expiresAt).getTime() <= now.getTime())
    return 'EXPIRED';
  if (input.trafficLimitBytes !== null && currentCycleTotal(input) >= input.trafficLimitBytes)
    return 'TRAFFIC_EXHAUSTED';
  return 'ACTIVE';
}

export function counterDelta(previous: bigint, current: bigint): bigint {
  if (previous < 0n || current < 0n) throw new Error('TRAFFIC_COUNTER_INVALID');
  return current >= previous ? current - previous : current;
}

export function trafficDelta(previous: TrafficCounter, current: TrafficCounter): TrafficCounter {
  return {
    uplinkBytes: counterDelta(previous.uplinkBytes, current.uplinkBytes),
    downlinkBytes: counterDelta(previous.downlinkBytes, current.downlinkBytes),
  };
}

export function assertTrafficLimit(value: bigint | null): bigint | null {
  if (value !== null && value <= 0n) throw new Error('TRAFFIC_LIMIT_INVALID');
  return value;
}

export function assertResetDay(policy: TrafficResetPolicy, resetDay: number | null): number | null {
  if (policy === 'NEVER') return null;
  if (resetDay === null || !Number.isInteger(resetDay) || resetDay < 1 || resetDay > 28)
    throw new Error('TRAFFIC_RESET_DAY_INVALID');
  return resetDay;
}

export function monthlyCycle(now: Date, resetDay: number): { startedAt: Date; endsAt: Date } {
  assertResetDay('MONTHLY', resetDay);
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const currentReset = new Date(Date.UTC(year, month, resetDay));
  const startedAt =
    now.getTime() >= currentReset.getTime()
      ? currentReset
      : new Date(Date.UTC(year, month - 1, resetDay));
  return {
    startedAt,
    endsAt: new Date(Date.UTC(startedAt.getUTCFullYear(), startedAt.getUTCMonth() + 1, resetDay)),
  };
}

export function cycleWindow(
  policy: TrafficResetPolicy,
  resetDay: number | null,
  now = new Date(),
): { startedAt: Date; endsAt: Date | null } {
  if (policy === 'NEVER') return { startedAt: now, endsAt: null };
  return monthlyCycle(now, assertResetDay(policy, resetDay)!);
}

export function shouldResetMonthlyCycle(
  policy: TrafficResetPolicy,
  cycleEndsAt: Date | string | null,
  now = new Date(),
): boolean {
  return (
    policy === 'MONTHLY' && cycleEndsAt !== null && new Date(cycleEndsAt).getTime() <= now.getTime()
  );
}

export function statsIdentity(userId: string, accessId: string): string {
  const opaque = `${userId}-${accessId}`.replace(/[^A-Za-z0-9_-]/gu, '');
  if (!opaque) throw new Error('USER_ACCESS_IDENTITY_INVALID');
  return `phu-${opaque}`;
}

function parseCounter(value: unknown): bigint {
  if (typeof value === 'bigint' && value >= 0n) return value;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  if (typeof value === 'string' && /^\d+$/u.test(value)) return BigInt(value);
  throw new Error('TRAFFIC_COUNTER_INVALID');
}

export function parseXrayUserMetrics(value: unknown): XrayUserMetric[] {
  if (typeof value !== 'object' || value === null) throw new Error('TRAFFIC_COUNTER_INVALID');
  const stats = (value as { stats?: unknown }).stats;
  if (typeof stats !== 'object' || stats === null) return [];
  const users = (stats as { user?: unknown }).user;
  if (users === undefined) return [];
  if (typeof users !== 'object' || users === null || Array.isArray(users))
    throw new Error('TRAFFIC_COUNTER_INVALID');
  return Object.entries(users).map(([identity, counters]) => {
    if (typeof counters !== 'object' || counters === null)
      throw new Error('TRAFFIC_COUNTER_INVALID');
    const record = counters as { uplink?: unknown; downlink?: unknown };
    return {
      statsIdentity: identity,
      uplinkBytes: parseCounter(record.uplink ?? 0),
      downlinkBytes: parseCounter(record.downlink ?? 0),
    };
  });
}

export function serializeBytes(value: bigint): string {
  if (value < 0n) throw new Error('TRAFFIC_COUNTER_INVALID');
  return value.toString(10);
}
