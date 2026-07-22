import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  applyValidatedConfig,
  buildXrayConfig,
  createVlessUri,
  generateRealityCredentials,
  restoreValidatedConfig,
} from './index.js';

describe('xray-manager', () => {
  it('generates usable Reality credentials', () => {
    const credentials = generateRealityCredentials();
    expect(credentials.uuid).toMatch(/^[0-9a-f-]{36}$/);
    expect(credentials.privateKey.length).toBeGreaterThan(30);
    expect(credentials.publicKey.length).toBeGreaterThan(30);
    expect(credentials.shortId).toMatch(/^[0-9a-f]{16}$/);
  });

  it('builds a VLESS Reality inbound', () => {
    const config = buildXrayConfig([
      {
        name: 'Tokyo Edge',
        port: 443,
        uuid: 'id',
        privateKey: 'key',
        shortId: '12',
        sni: 'example.com',
        dest: 'example.com:443',
        fingerprint: 'chrome',
      },
    ]);
    expect(config.inbounds).toHaveLength(1);
  });

  it('creates a VLESS URI without leaking the private key', () => {
    const uri = createVlessUri({
      uuid: 'abc',
      host: 'host.example',
      port: 443,
      flow: 'xtls-rprx-vision',
      sni: 'www.microsoft.com',
      fingerprint: 'chrome',
      realityPublicKey: 'public',
      shortId: 'deadbeef',
      name: 'Edge',
    });
    expect(uri).toContain('vless://abc@host.example:443');
    expect(uri).not.toContain('private');
  });

  it('percent-encodes special characters in VLESS query values and fragments', () => {
    const uri = createVlessUri({
      uuid: '11111111-1111-4111-8111-111111111111',
      host: 'host.example',
      port: 443,
      flow: 'xtls-rprx-vision',
      sni: 'server name.example',
      fingerprint: 'chrome#beta',
      realityPublicKey: 'public+key/value=',
      shortId: 'deadbeef',
      name: 'Edge: # " \'\nUnicode 😀',
    });
    expect(uri.match(/#/g)).toHaveLength(1);
    expect(uri).toContain('sni=server+name.example');
    expect(uri).toContain('fp=chrome%23beta');
    expect(uri).toContain('pbk=public%2Bkey%2Fvalue%3D');
    expect(uri).toContain('#Edge%3A%20%23%20%22%20%27%0AUnicode%20%F0%9F%98%80');
  });

  it('brackets IPv6 hosts in VLESS authority components', () => {
    const uri = createVlessUri({
      uuid: '11111111-1111-4111-8111-111111111111',
      host: '2001:db8::1',
      port: 443,
      flow: 'xtls-rprx-vision',
      sni: 'www.microsoft.com',
      fingerprint: 'chrome',
      realityPublicKey: 'public',
      shortId: 'deadbeef',
      name: 'IPv6 Edge',
    });
    expect(uri).toContain('@[2001:db8::1]:443');
  });

  it('removes the temporary config when Xray validation fails', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'proxyhub-xray-'));
    const targetPath = join(directory, 'config.json');
    try {
      await expect(
        applyValidatedConfig(process.execPath, targetPath, { inbounds: [], outbounds: [] }),
      ).rejects.toThrow(/validation failed/i);
      const remainingFiles = await import('node:fs/promises').then(({ readdir }) =>
        readdir(directory),
      );
      expect(remainingFiles).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('atomically retains and restores a revision backup', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'proxyhub-xray-'));
    const targetPath = join(directory, 'config.json');
    const backupPath = join(directory, 'config.rollback');
    const validate = async () => 'valid';
    try {
      await writeFile(targetPath, JSON.stringify({ version: 'old' }));
      await applyValidatedConfig(
        'test-xray',
        targetPath,
        { version: 'new' },
        {
          backupPath,
          requireExisting: true,
          validate,
        },
      );
      expect(JSON.parse(await readFile(targetPath, 'utf8'))).toEqual({ version: 'new' });
      expect(JSON.parse(await readFile(backupPath, 'utf8'))).toEqual({ version: 'old' });

      await restoreValidatedConfig('test-xray', targetPath, backupPath, validate);
      expect(JSON.parse(await readFile(targetPath, 'utf8'))).toEqual({ version: 'old' });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
