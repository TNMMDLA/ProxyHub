import { PROXYHUB_RELEASE, type ProxyHubBuildMetadata } from '@proxyhub/shared';
import { calculateMigrationFingerprint } from './migration-fingerprint.js';

const UNKNOWN = 'unknown';

function validGitSha(value: string | undefined): string {
  return value && /^[0-9a-f]{40}$/i.test(value) ? value.toLowerCase() : UNKNOWN;
}

function validBuildTime(value: string | undefined): string {
  return value && !Number.isNaN(Date.parse(value)) ? new Date(value).toISOString() : UNKNOWN;
}

export async function createBuildMetadata(
  environment: NodeJS.ProcessEnv = process.env,
  migrationFingerprint?: string,
): Promise<ProxyHubBuildMetadata> {
  const gitSha = validGitSha(environment.PROXYHUB_GIT_SHA);
  return {
    version: PROXYHUB_RELEASE.version,
    gitSha,
    gitShortSha: gitSha === UNKNOWN ? UNKNOWN : gitSha.slice(0, 12),
    buildTime: validBuildTime(environment.PROXYHUB_BUILD_TIME),
    buildEnvironment:
      environment.PROXYHUB_BUILD_ENVIRONMENT?.trim() || environment.NODE_ENV || 'development',
    deployMode: environment.PROXYHUB_DEPLOY_MODE?.trim() || 'source',
    xrayVersion: PROXYHUB_RELEASE.xrayVersion,
    database: {
      migrationFingerprint: migrationFingerprint ?? (await calculateMigrationFingerprint()),
    },
  };
}

let metadataPromise: Promise<ProxyHubBuildMetadata> | undefined;

export function getBuildMetadata(): Promise<ProxyHubBuildMetadata> {
  metadataPromise ??= createBuildMetadata();
  return metadataPromise;
}
