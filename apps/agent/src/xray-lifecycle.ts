import { randomUUID } from 'node:crypto';
import { unlink } from 'node:fs/promises';
import { dirname, parse, resolve } from 'node:path';
import {
  applyValidatedConfig,
  restoreValidatedConfig,
  testXrayConfig,
  xrayConfigLifecyclePath,
} from '@proxyhub/xray-manager';

export class XrayLifecycleError extends Error {
  constructor(
    readonly code:
      'XRAY_CONFIG_ROLLED_BACK' | 'XRAY_ROLLBACK_FAILED' | 'XRAY_LIFECYCLE_CLEANUP_FAILED',
    message: string,
  ) {
    super(message);
    this.name = 'XrayLifecycleError';
  }
}

const REVISION_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export function xrayRollbackPath(configPath: string, revision: string): string {
  if (!configPath.trim() || configPath.includes('\0'))
    throw new Error('The Xray configuration path is invalid');
  if (!REVISION_PATTERN.test(revision)) throw new Error('The Xray revision is invalid');

  const resolvedConfigPath = resolve(configPath);
  const configDirectory = dirname(resolvedConfigPath);
  if (configDirectory === parse(resolvedConfigPath).root)
    throw new Error('The Xray configuration cannot be stored in the filesystem root');

  const rollbackPath = resolve(xrayConfigLifecyclePath(resolvedConfigPath, 'rollback', revision));
  if (dirname(rollbackPath) !== configDirectory)
    throw new Error('The Xray rollback path escaped the configuration directory');
  return rollbackPath;
}

export async function cleanupXrayRollbackArtifact(
  configPath: string,
  revision: string,
): Promise<void> {
  const rollbackPath = xrayRollbackPath(configPath, revision);
  try {
    await unlink(rollbackPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw new XrayLifecycleError(
      'XRAY_LIFECYCLE_CLEANUP_FAILED',
      `The Xray rollback artifact could not be removed: ${(error as Error).message}`,
    );
  }
}

export async function applyXrayConfigLifecycle<T>(options: {
  binary: string;
  configPath: string;
  config: Record<string, unknown>;
  restartAndWait: () => Promise<T>;
  revision?: string;
  validate?: (binary: string, configPath: string) => Promise<string>;
  apply?: typeof applyValidatedConfig;
}): Promise<{ revision: string; health: T }> {
  const revision = options.revision ?? randomUUID();
  const backupPath = xrayRollbackPath(options.configPath, revision);
  const validate = options.validate ?? testXrayConfig;
  const apply = options.apply ?? applyValidatedConfig;

  try {
    await apply(options.binary, options.configPath, options.config, {
      backupPath,
      requireExisting: true,
      validate,
    });
  } catch (error) {
    await cleanupXrayRollbackArtifact(options.configPath, revision);
    throw error;
  }

  try {
    return { revision, health: await options.restartAndWait() };
  } catch (error) {
    try {
      await restoreValidatedConfig(options.binary, options.configPath, backupPath, validate);
      await options.restartAndWait();
    } catch (rollbackError) {
      throw new XrayLifecycleError(
        'XRAY_ROLLBACK_FAILED',
        `The new configuration was unhealthy and automatic rollback failed: ${(rollbackError as Error).message}`,
      );
    }
    await cleanupXrayRollbackArtifact(options.configPath, revision);
    throw new XrayLifecycleError(
      'XRAY_CONFIG_ROLLED_BACK',
      `The new configuration was unhealthy and the previous configuration was restored: ${(error as Error).message}`,
    );
  }
}
