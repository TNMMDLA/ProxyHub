import { readFile, stat } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  cleanupPerformanceDirectory,
  createSecureTempDirectory,
  validateNetworkPerformanceUrl,
  writeSecureXrayConfig,
} from './network-runtime.js';

describe('network performance network safety', () => {
  it.each([
    'http://public.example/download',
    'file:///etc/passwd',
    'ftp://public.example/file',
    'https://localhost/download',
    'https://user:password@public.example/download',
  ])('rejects unsafe target URL %s', async (url) => {
    await expect(
      validateNetworkPerformanceUrl(url, async () => [{ address: '1.1.1.1', family: 4 }], false),
    ).rejects.toThrow('NETWORK_PERFORMANCE_TARGET_INVALID');
  });

  it.each([
    '127.0.0.1',
    '10.0.0.1',
    '169.254.169.254',
    '100.64.0.1',
    '192.0.2.1',
    '198.18.0.1',
    '::1',
    '::ffff:127.0.0.1',
  ])('rejects blocked resolved address %s', async (address) => {
    await expect(
      validateNetworkPerformanceUrl(
        'https://target.example/download',
        async () => [{ address, family: address.includes(':') ? 6 : 4 }],
        false,
      ),
    ).rejects.toThrow('NETWORK_PERFORMANCE_TARGET_INVALID');
  });

  it('rejects a DNS rebinding candidate when any resolved address is private', async () => {
    await expect(
      validateNetworkPerformanceUrl(
        'https://target.example/download',
        async () => [
          { address: '1.1.1.1', family: 4 },
          { address: '127.0.0.1', family: 4 },
        ],
        false,
      ),
    ).rejects.toThrow('NETWORK_PERFORMANCE_TARGET_INVALID');
  });

  it('accepts all-public DNS answers and exposes no URL credentials', async () => {
    await expect(
      validateNetworkPerformanceUrl(
        'https://target.example/download',
        async () => [
          { address: '1.1.1.1', family: 4 },
          { address: '2606:4700:4700::1111', family: 6 },
        ],
        false,
      ),
    ).resolves.toMatchObject({
      url: { protocol: 'https:', hostname: 'target.example' },
    });
  });
});

describe('network performance temporary resource safety', () => {
  it('uses a 0700 directory and a 0600 Xray configuration and removes both', async () => {
    const directory = await createSecureTempDirectory();
    try {
      const path = await writeSecureXrayConfig(directory, { inbounds: [], outbounds: [] });
      if (process.platform !== 'win32') {
        expect((await stat(directory)).mode & 0o777).toBe(0o700);
        expect((await stat(path)).mode & 0o777).toBe(0o600);
      }
      expect(await readFile(path, 'utf8')).toContain('"inbounds"');
    } finally {
      await cleanupPerformanceDirectory(directory);
    }
    await expect(stat(directory)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses to recursively delete an unrecognized path', async () => {
    await expect(
      cleanupPerformanceDirectory('/tmp/not-a-proxyhub-performance-run'),
    ).rejects.toThrow('Refusing to remove');
  });
});
