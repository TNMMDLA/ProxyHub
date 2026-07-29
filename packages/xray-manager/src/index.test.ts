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
  xrayConfigLifecyclePath,
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
    expect(config).not.toHaveProperty('stats');
  });

  it('preserves the legacy client and enables user stats for multiple clients', () => {
    const config = buildXrayConfig([
      {
        name: 'Hong Kong',
        port: 443,
        uuid: '11111111-1111-4111-8111-111111111111',
        privateKey: 'key',
        shortId: '12',
        sni: 'example.com',
        dest: 'example.com:443',
        fingerprint: 'chrome',
        clients: [
          {
            uuid: '22222222-2222-4222-8222-222222222222',
            statsIdentity: 'phu-user-a-access-hk',
          },
          {
            uuid: '33333333-3333-4333-8333-333333333333',
            statsIdentity: 'phu-user-b-access-hk',
          },
        ],
      },
    ]);
    const inbound = (config.inbounds as Array<{ settings: { clients: unknown[] } }>)[0]!;
    expect(inbound.settings.clients).toEqual([
      { id: '11111111-1111-4111-8111-111111111111', flow: 'xtls-rprx-vision' },
      {
        id: '22222222-2222-4222-8222-222222222222',
        flow: 'xtls-rprx-vision',
        email: 'phu-user-a-access-hk',
        level: 0,
      },
      {
        id: '33333333-3333-4333-8333-333333333333',
        flow: 'xtls-rprx-vision',
        email: 'phu-user-b-access-hk',
        level: 0,
      },
    ]);
    expect(config).toMatchObject({
      stats: {},
      policy: { levels: { '0': { statsUserUplink: true, statsUserDownlink: true } } },
      metrics: { listen: 'host.docker.internal:11111' },
    });
  });

  it('rejects duplicate legacy and managed client UUIDs', () => {
    expect(() =>
      buildXrayConfig([
        {
          name: 'Duplicate',
          port: 443,
          uuid: '11111111-1111-4111-8111-111111111111',
          privateKey: 'key',
          shortId: '12',
          sni: 'example.com',
          dest: 'example.com:443',
          fingerprint: 'chrome',
          clients: [
            {
              uuid: '11111111-1111-4111-8111-111111111111',
              statsIdentity: 'phu-duplicate',
            },
          ],
        },
      ]),
    ).toThrow('Duplicate VLESS client UUID');
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
    let validationPath = '';
    try {
      await expect(
        applyValidatedConfig(
          'test-xray',
          targetPath,
          { inbounds: [], outbounds: [] },
          {
            validate: async (_binary, configPath) => {
              validationPath = configPath;
              throw new Error('invalid config');
            },
          },
        ),
      ).rejects.toThrow(/validation failed/i);
      expect(validationPath).toMatch(/config\.next-[0-9a-f-]+\.json$/);
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
    const backupPath = join(directory, 'config.rollback-revision.json');
    const validatedPaths: string[] = [];
    const validate = async (_binary: string, configPath: string) => {
      validatedPaths.push(configPath);
      JSON.parse(await readFile(configPath, 'utf8'));
      return 'valid';
    };
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
      expect(validatedPaths).toHaveLength(2);
      expect(validatedPaths[0]).toMatch(/config\.next-[0-9a-f-]+\.json$/);
      expect(validatedPaths[1]).toMatch(/config\.restore-[0-9a-f-]+\.json$/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('keeps JSON as the final extension for every lifecycle stage', () => {
    const configPath = join('etc', 'xray', 'config.json');
    for (const stage of ['backup', 'next', 'restore', 'rollback', 'validation'] as const) {
      expect(xrayConfigLifecyclePath(configPath, stage, 'revision')).toBe(
        join('etc', 'xray', `config.${stage}-revision.json`),
      );
    }
    expect(xrayConfigLifecyclePath(join('etc', 'xray', 'config'), 'next', 'revision')).toBe(
      join('etc', 'xray', 'config.next-revision.json'),
    );
  });
});
