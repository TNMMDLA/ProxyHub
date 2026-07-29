import { afterEach, describe, expect, it, vi } from 'vitest';
import { agentRequest, defaultAgentClient } from './agent-client.js';

function stubSuccessfulFetch(data: unknown) {
  const fetchMock = vi.fn(async () => Response.json({ success: true, data }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function capturedInit(fetchMock: ReturnType<typeof vi.fn>): RequestInit {
  expect(fetchMock).toHaveBeenCalledOnce();
  return fetchMock.mock.calls[0]?.[1] as RequestInit;
}

describe('Agent request construction', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('serializes a POST JSON body and adds the JSON content type', async () => {
    const fetchMock = stubSuccessfulFetch({ confirmed: true });

    await defaultAgentClient.confirm('revision-1');

    const init = capturedInit(fetchMock);
    expect(init.method).toBe('POST');
    expect(init.body).toBe(JSON.stringify({ revision: 'revision-1' }));
    expect(new Headers(init.headers).get('content-type')).toBe('application/json');
  });

  it('does not add a body or content type to a POST without a body', async () => {
    const fetchMock = stubSuccessfulFetch({ restarted: true, health: {} });

    await defaultAgentClient.restart();

    const init = capturedInit(fetchMock);
    expect(init.method).toBe('POST');
    expect(init.body).toBeUndefined();
    expect(new Headers(init.headers).has('content-type')).toBe(false);
  });

  it('does not add a body or content type to a GET request', async () => {
    const fetchMock = stubSuccessfulFetch({ status: 'ok' });

    await defaultAgentClient.status();

    const init = capturedInit(fetchMock);
    expect(init.method).toBeUndefined();
    expect(init.body).toBeUndefined();
    expect(new Headers(init.headers).has('content-type')).toBe(false);
  });

  it('preserves custom headers alongside authorization', async () => {
    const fetchMock = stubSuccessfulFetch({ ok: true });

    await agentRequest('/custom', { headers: { 'x-proxyhub-test': 'present' } });

    const headers = new Headers(capturedInit(fetchMock).headers);
    expect(headers.get('x-proxyhub-test')).toBe('present');
    expect(headers.get('authorization')).toMatch(/^Bearer /u);
  });

  it('does not overwrite an explicit content type for a request body', async () => {
    const fetchMock = stubSuccessfulFetch({ ok: true });

    await agentRequest('/custom', {
      method: 'POST',
      body: { value: true },
      headers: { 'content-type': 'application/problem+json' },
    });

    const init = capturedInit(fetchMock);
    expect(init.body).toBe(JSON.stringify({ value: true }));
    expect(new Headers(init.headers).get('content-type')).toBe('application/problem+json');
  });

  it('sends the Network Performance cancel POST without a body or content type', async () => {
    const fetchMock = stubSuccessfulFetch({ cancelled: true });

    await defaultAgentClient.cancelNetworkPerformance?.('run/1');

    const [url] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
    const init = capturedInit(fetchMock);
    expect(url.pathname).toBe('/network-performance/runs/run%2F1/cancel');
    expect(init.method).toBe('POST');
    expect(init.body).toBeUndefined();
    expect(new Headers(init.headers).has('content-type')).toBe(false);
  });
});

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
