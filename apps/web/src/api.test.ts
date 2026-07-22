import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from './api.js';

function successResponse() {
  return new Response(JSON.stringify({ success: true, data: { ok: true } }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function mockFetch() {
  return vi.fn((...args: Parameters<typeof fetch>) => {
    void args;
    return Promise.resolve(successResponse());
  });
}

describe('web API client', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('does not set a JSON content type for bodyless POST requests', async () => {
    const fetchMock = mockFetch();
    vi.stubGlobal('fetch', fetchMock);

    await api('/subscriptions/id/preview', { method: 'POST' });

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(new Headers(init.headers).has('content-type')).toBe(false);
  });

  it('sets a JSON content type when a request has a body', async () => {
    const fetchMock = mockFetch();
    vi.stubGlobal('fetch', fetchMock);

    await api('/policies', { method: 'POST', body: JSON.stringify({ name: 'Default' }) });

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(new Headers(init.headers).get('content-type')).toBe('application/json');
  });
});
