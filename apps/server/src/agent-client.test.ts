import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultAgentClient } from './agent-client.js';

describe('Agent client cancellation', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('preserves an explicit Reality preflight cancellation instead of reporting Agent unavailable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: URL, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
              once: true,
            });
          }),
      ),
    );
    const controller = new AbortController();
    const request = defaultAgentClient.testRealityTarget(
      { serverName: 'dl.google.com', target: 'dl.google.com:443' },
      controller.signal,
    );

    controller.abort();

    await expect(request).rejects.toMatchObject({
      code: 'REALITY_TARGET_TEST_CANCELLED',
      statusCode: 499,
    });
  });
});
