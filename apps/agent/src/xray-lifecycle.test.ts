import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, parse, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  applyXrayConfigLifecycle,
  cleanupXrayRollbackArtifact,
  xrayRollbackPath,
} from './xray-lifecycle.js';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'proxyhub-agent-lifecycle-'));
  directories.push(directory);
  const configPath = join(directory, 'config.json');
  await writeFile(configPath, JSON.stringify({ version: 'old' }));
  const validatedPaths: string[] = [];
  const validate = async (_binary: string, path: string) => {
    validatedPaths.push(path);
    JSON.parse(await readFile(path, 'utf8'));
    return 'valid';
  };
  return { directory, configPath, validatedPaths, validate };
}

describe('Agent Xray apply lifecycle', () => {
  it('atomically applies a validated config and cleans its rollback after confirmation', async () => {
    const context = await fixture();
    const revision = '11111111-1111-4111-8111-111111111111';
    const result = await applyXrayConfigLifecycle({
      binary: 'test-xray',
      configPath: context.configPath,
      config: { version: 'new' },
      restartAndWait: async () => ({ status: 'HEALTHY' }),
      revision,
      validate: context.validate,
    });

    expect(result).toEqual({ revision, health: { status: 'HEALTHY' } });
    expect(JSON.parse(await readFile(context.configPath, 'utf8'))).toEqual({ version: 'new' });
    const rollbackPath = xrayRollbackPath(context.configPath, revision);
    expect(rollbackPath).toMatch(/config\.rollback-[0-9a-f-]+\.json$/);
    expect(JSON.parse(await readFile(rollbackPath, 'utf8'))).toEqual({ version: 'old' });
    expect(context.validatedPaths[0]).toMatch(/config\.next-[0-9a-f-]+\.json$/);

    await cleanupXrayRollbackArtifact(context.configPath, revision);
    expect(await readdir(context.directory)).toEqual(['config.json']);
  });

  it('does not leave a rollback artifact when validation fails before apply', async () => {
    const context = await fixture();
    await expect(
      applyXrayConfigLifecycle({
        binary: 'test-xray',
        configPath: context.configPath,
        config: { version: 'invalid' },
        restartAndWait: async () => ({ status: 'HEALTHY' }),
        revision: '12121212-1212-4121-8121-121212121212',
        validate: async () => {
          throw new Error('validation failed');
        },
      }),
    ).rejects.toThrow('validation failed');

    expect(await readdir(context.directory)).toEqual(['config.json']);
  });

  it('removes a rollback artifact when apply fails after creating it', async () => {
    const context = await fixture();
    await expect(
      applyXrayConfigLifecycle({
        binary: 'test-xray',
        configPath: context.configPath,
        config: { version: 'new' },
        restartAndWait: async () => ({ status: 'HEALTHY' }),
        revision: '13131313-1313-4131-8131-131313131313',
        validate: context.validate,
        apply: async (_binary, _targetPath, _config, options) => {
          if (!options?.backupPath) throw new Error('test backup path was not provided');
          await writeFile(options.backupPath, JSON.stringify({ version: 'old' }));
          throw new Error('atomic apply failed');
        },
      }),
    ).rejects.toThrow('atomic apply failed');

    expect(await readdir(context.directory)).toEqual(['config.json']);
  });

  it.each(['restart failed', 'health check failed'])(
    'restores the active config when %s after apply',
    async (failure) => {
      const context = await fixture();
      let attempts = 0;
      await expect(
        applyXrayConfigLifecycle({
          binary: 'test-xray',
          configPath: context.configPath,
          config: { version: 'new' },
          restartAndWait: async () => {
            attempts += 1;
            if (attempts === 1) throw new Error(failure);
            return { status: 'HEALTHY' };
          },
          revision: '22222222-2222-4222-8222-222222222222',
          validate: context.validate,
        }),
      ).rejects.toMatchObject({ code: 'XRAY_CONFIG_ROLLED_BACK' });

      expect(attempts).toBe(2);
      expect(JSON.parse(await readFile(context.configPath, 'utf8'))).toEqual({ version: 'old' });
      expect(await readdir(context.directory)).toEqual(['config.json']);
      expect(context.validatedPaths.at(-1)).toMatch(/config\.restore-[0-9a-f-]+\.json$/);
    },
  );

  it('reports XRAY_ROLLBACK_FAILED when the previous config cannot be restored', async () => {
    const context = await fixture();
    const revision = '33333333-3333-4333-8333-333333333333';
    let validations = 0;
    await expect(
      applyXrayConfigLifecycle({
        binary: 'test-xray',
        configPath: context.configPath,
        config: { version: 'new' },
        restartAndWait: async () => {
          throw new Error('health check failed');
        },
        revision,
        validate: async (...args) => {
          validations += 1;
          if (validations > 1) throw new Error('rollback validation failed');
          return context.validate(...args);
        },
      }),
    ).rejects.toMatchObject({ code: 'XRAY_ROLLBACK_FAILED' });

    expect(
      JSON.parse(await readFile(xrayRollbackPath(context.configPath, revision), 'utf8')),
    ).toEqual({ version: 'old' });
  });

  it('allows the same rollback cleanup to be called twice', async () => {
    const context = await fixture();
    const revision = '44444444-4444-4444-8444-444444444444';
    await writeFile(xrayRollbackPath(context.configPath, revision), '{}');

    await cleanupXrayRollbackArtifact(context.configPath, revision);
    await cleanupXrayRollbackArtifact(context.configPath, revision);

    expect(await readdir(context.directory)).toEqual(['config.json']);
  });

  it('treats a missing rollback artifact as already clean', async () => {
    const context = await fixture();

    await expect(
      cleanupXrayRollbackArtifact(context.configPath, '55555555-5555-4555-8555-555555555555'),
    ).resolves.toBeUndefined();
  });

  it('returns a stable error and retains recovery material when cleanup fails', async () => {
    const context = await fixture();
    const revision = '66666666-6666-4666-8666-666666666666';
    const rollbackPath = xrayRollbackPath(context.configPath, revision);
    await mkdir(rollbackPath);

    await expect(cleanupXrayRollbackArtifact(context.configPath, revision)).rejects.toMatchObject({
      code: 'XRAY_LIFECYCLE_CLEANUP_FAILED',
    });
    expect(await readdir(context.directory)).toEqual([
      'config.json',
      `config.rollback-${revision}.json`,
    ]);
  });

  it('deletes only the recorded rollback path and preserves formal backups', async () => {
    const context = await fixture();
    const revision = '77777777-7777-4777-8777-777777777777';
    const formalBackupPath = join(context.directory, 'config.backup-previous.json');
    await writeFile(formalBackupPath, JSON.stringify({ version: 'formal-backup' }));
    await writeFile(xrayRollbackPath(context.configPath, revision), '{}');

    await cleanupXrayRollbackArtifact(context.configPath, revision);

    expect(JSON.parse(await readFile(formalBackupPath, 'utf8'))).toEqual({
      version: 'formal-backup',
    });
    expect((await readdir(context.directory)).sort()).toEqual([
      'config.backup-previous.json',
      'config.json',
    ]);
  });

  it('rejects traversal revisions and filesystem-root configuration paths', () => {
    expect(() => xrayRollbackPath(join('etc', 'xray', 'config.json'), '../escape')).toThrow(
      'revision is invalid',
    );
    expect(() =>
      xrayRollbackPath(
        join(parse(resolve('config.json')).root, 'config.json'),
        '88888888-8888-4888-8888-888888888888',
      ),
    ).toThrow('filesystem root');
  });
});
