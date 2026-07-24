import { createServer } from 'node:http';
import type { RequestListener } from 'node:http';
import type { AddressInfo } from 'node:net';
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { fetchRemoteRuleSet } from './fetcher.js';
import { isBlockedAddress, redactRemoteUrl, validateRemoteUrl } from './security.js';

const servers: Array<ReturnType<typeof createServer>> = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
});

async function localServer(
  handler: RequestListener,
): Promise<{ url: string; resolver: () => Promise<Array<{ address: string; family: 4 }>> }> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://public.test:${String(port)}/rules`,
    resolver: async () => [{ address: '127.0.0.1', family: 4 }],
  };
}

describe('remote rule set SSRF security', () => {
  it.each([
    '127.0.0.1',
    '10.0.0.1',
    '172.16.0.1',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '192.0.2.1',
    '198.51.100.1',
    '203.0.113.1',
    '::1',
    'fc00::1',
    'fe80::1',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '2001:db8::1',
  ])('blocks %s', (address) => expect(isBlockedAddress(address)).toBe(true));

  it.each(['file:///etc/passwd', 'ftp://example.com/rules', 'data:text/plain,x'])(
    'rejects forbidden scheme %s',
    async (url) => {
      await expect(validateRemoteUrl(url)).rejects.toMatchObject({
        code: 'RULE_SET_URL_FORBIDDEN',
      });
    },
  );

  it('rejects userinfo and DNS resolving to private space', async () => {
    await expect(validateRemoteUrl('https://user:pass@example.com/rules')).rejects.toMatchObject({
      code: 'RULE_SET_URL_FORBIDDEN',
    });
    await expect(
      validateRemoteUrl('https://public.example/rules', {
        resolver: async () => [{ address: '10.0.0.8', family: 4 }],
      }),
    ).rejects.toMatchObject({ code: 'RULE_SET_SSRF_BLOCKED' });
  });

  it('normalizes encoded numeric hosts before private-IP validation', async () => {
    for (const url of ['https://2130706433/rules', 'https://0x7f000001/rules']) {
      await expect(validateRemoteUrl(url)).rejects.toMatchObject({ code: 'RULE_SET_SSRF_BLOCKED' });
    }
  });

  it('redacts query, fragment and credentials', () => {
    expect(redactRemoteUrl('https://user:pass@example.com/path?token=secret#fragment')).toBe(
      'https://example.com/path',
    );
  });
});

describe('remote rule set fetch limits', () => {
  it('fetches small content and sends conditional headers', async () => {
    const target = await localServer((request, response) => {
      expect(request.headers['if-none-match']).toBe('etag-a');
      expect(request.headers['if-modified-since']).toBe('Wed, 01 Jan 2025 00:00:00 GMT');
      response.setHeader('etag', 'etag-b');
      response.end('DOMAIN,example.com\n');
    });
    const result = await fetchRemoteRuleSet(target.url, {
      allowHttp: true,
      allowPrivateForTests: true,
      resolver: target.resolver,
      etag: 'etag-a',
      lastModified: 'Wed, 01 Jan 2025 00:00:00 GMT',
    });
    expect(result).toMatchObject({ status: 200, content: 'DOMAIN,example.com\n', etag: 'etag-b' });
  });

  it('handles 304 without downloading or rewriting content', async () => {
    const target = await localServer((_request, response) => {
      response.statusCode = 304;
      response.setHeader('etag', 'etag-a');
      response.end();
    });
    await expect(
      fetchRemoteRuleSet(target.url, {
        allowHttp: true,
        allowPrivateForTests: true,
        resolver: target.resolver,
      }),
    ).resolves.toMatchObject({ status: 304, content: null, etag: 'etag-a' });
  });

  it('rejects oversized Content-Length and chunked responses', async () => {
    const declared = await localServer((_request, response) => {
      response.setHeader('content-length', '10000');
      response.end('small');
    });
    await expect(
      fetchRemoteRuleSet(declared.url, {
        allowHttp: true,
        allowPrivateForTests: true,
        resolver: declared.resolver,
        maxBytes: 100,
      }),
    ).rejects.toMatchObject({ code: 'RULE_SET_TOO_LARGE' });

    const chunked = await localServer((_request, response) => {
      response.write('x'.repeat(80));
      response.end('x'.repeat(80));
    });
    await expect(
      fetchRemoteRuleSet(chunked.url, {
        allowHttp: true,
        allowPrivateForTests: true,
        resolver: chunked.resolver,
        maxBytes: 100,
      }),
    ).rejects.toMatchObject({ code: 'RULE_SET_TOO_LARGE' });
  });

  it('limits the decompressed body to prevent compression bombs', async () => {
    const compressed = gzipSync('x'.repeat(10_000));
    const target = await localServer((_request, response) => {
      response.setHeader('content-encoding', 'gzip');
      response.end(compressed);
    });
    await expect(
      fetchRemoteRuleSet(target.url, {
        allowHttp: true,
        allowPrivateForTests: true,
        resolver: target.resolver,
        maxBytes: 100,
      }),
    ).rejects.toMatchObject({ code: 'RULE_SET_TOO_LARGE' });
  });

  it('times out slow responses', async () => {
    const target = await localServer(() => undefined);
    await expect(
      fetchRemoteRuleSet(target.url, {
        allowHttp: true,
        allowPrivateForTests: true,
        resolver: target.resolver,
        timeoutMs: 30,
      }),
    ).rejects.toMatchObject({ code: 'RULE_SET_FETCH_FAILED' });
  });

  it('revalidates redirects and blocks a private redirect target', async () => {
    const target = await localServer((_request, response) => {
      const port = (servers.at(-1)?.address() as AddressInfo).port;
      response.statusCode = 302;
      response.setHeader('location', `http://localhost:${String(port)}/private`);
      response.end();
    });
    await expect(
      fetchRemoteRuleSet(target.url, {
        allowHttp: true,
        allowPrivateForTests: true,
        resolver: target.resolver,
      }),
    ).rejects.toMatchObject({ code: 'RULE_SET_SSRF_BLOCKED' });
  });
});
