import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { applyXrayConfigLifecycle, xrayRollbackPath } from './xray-lifecycle.js';

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
  it('atomically applies a validated config and retains a readable JSON rollback revision', async () => {
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
    let validations = 0;
    await expect(
      applyXrayConfigLifecycle({
        binary: 'test-xray',
        configPath: context.configPath,
        config: { version: 'new' },
        restartAndWait: async () => {
          throw new Error('health check failed');
        },
        revision: '33333333-3333-4333-8333-333333333333',
        validate: async (...args) => {
          validations += 1;
          if (validations > 1) throw new Error('rollback validation failed');
          return context.validate(...args);
        },
      }),
    ).rejects.toMatchObject({ code: 'XRAY_ROLLBACK_FAILED' });
  });
});
