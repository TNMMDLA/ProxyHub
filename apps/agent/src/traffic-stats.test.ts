import { describe, expect, it } from 'vitest';
import { fetchXrayUserStats } from './traffic-stats.js';

describe('Xray user stats reader', () => {
  it('returns only normalized user counters as decimal strings', async () => {
    const fetcher = async () =>
      new Response(
        JSON.stringify({
          stats: {
            inbound: { node: { uplink: 99 } },
            user: { 'phu-opaque': { uplink: 12, downlink: 34 } },
          },
          memstats: { secretNoise: true },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    await expect(fetchXrayUserStats('http://localhost/debug/vars', fetcher)).resolves.toEqual([
      { statsIdentity: 'phu-opaque', uplinkBytes: '12', downlinkBytes: '34' },
    ]);
  });

  it('rejects malformed counters', async () => {
    const fetcher = async () =>
      new Response(JSON.stringify({ stats: { user: { invalid: { uplink: -1 } } } }));
    await expect(fetchXrayUserStats('http://localhost/debug/vars', fetcher)).rejects.toThrow(
      'TRAFFIC_COUNTER_INVALID',
    );
  });
});
