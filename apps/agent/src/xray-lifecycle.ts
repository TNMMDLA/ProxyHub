import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import {
  applyValidatedConfig,
  restoreValidatedConfig,
  testXrayConfig,
  xrayConfigLifecyclePath,
} from '@proxyhub/xray-manager';

export class XrayLifecycleError extends Error {
  constructor(
    readonly code: 'XRAY_CONFIG_ROLLED_BACK' | 'XRAY_ROLLBACK_FAILED',
    message: string,
  ) {
    super(message);
    this.name = 'XrayLifecycleError';
  }
}

export function xrayRollbackPath(configPath: string, revision: string): string {
  return xrayConfigLifecyclePath(configPath, 'rollback', revision);
}

export async function applyXrayConfigLifecycle<T>(options: {
  binary: string;
  configPath: string;
  config: Record<string, unknown>;
  restartAndWait: () => Promise<T>;
  revision?: string;
  validate?: (binary: string, configPath: string) => Promise<string>;
}): Promise<{ revision: string; health: T }> {
  const revision = options.revision ?? randomUUID();
  const backupPath = xrayRollbackPath(options.configPath, revision);
  const validate = options.validate ?? testXrayConfig;

  await applyValidatedConfig(options.binary, options.configPath, options.config, {
    backupPath,
    requireExisting: true,
    validate,
  });

  try {
    return { revision, health: await options.restartAndWait() };
  } catch (error) {
    try {
      await restoreValidatedConfig(options.binary, options.configPath, backupPath, validate);
      await options.restartAndWait();
      await rm(backupPath, { force: true });
    } catch (rollbackError) {
      throw new XrayLifecycleError(
        'XRAY_ROLLBACK_FAILED',
        `The new configuration was unhealthy and automatic rollback failed: ${(rollbackError as Error).message}`,
      );
    }
    throw new XrayLifecycleError(
      'XRAY_CONFIG_ROLLED_BACK',
      `The new configuration was unhealthy and the previous configuration was restored: ${(error as Error).message}`,
    );
  }
}
