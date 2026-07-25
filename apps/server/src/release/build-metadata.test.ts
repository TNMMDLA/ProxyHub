import { describe, expect, it } from 'vitest';
import { PROXYHUB_RELEASE } from '@proxyhub/shared';
import { createBuildMetadata } from './build-metadata.js';
import { calculateMigrationFingerprint } from './migration-fingerprint.js';

describe('release build metadata', () => {
  it('uses the generated canonical release version', async () => {
    const metadata = await createBuildMetadata({}, 'a'.repeat(64));
    expect(metadata.version).toBe(PROXYHUB_RELEASE.version);
    expect(metadata.xrayVersion).toBe('26.5.9');
  });

  it('normalizes immutable build identity', async () => {
    const gitSha = 'ABCDEF1234567890ABCDEF1234567890ABCDEF12';
    const metadata = await createBuildMetadata(
      {
        PROXYHUB_GIT_SHA: gitSha,
        PROXYHUB_BUILD_TIME: '2026-07-25T01:02:03+08:00',
        PROXYHUB_BUILD_ENVIRONMENT: 'ci',
        PROXYHUB_DEPLOY_MODE: 'image',
      },
      'b'.repeat(64),
    );
    expect(metadata).toMatchObject({
      gitSha: gitSha.toLowerCase(),
      gitShortSha: 'abcdef123456',
      buildTime: '2026-07-24T17:02:03.000Z',
      buildEnvironment: 'ci',
      deployMode: 'image',
    });
  });

  it('does not expose untrusted build values', async () => {
    const metadata = await createBuildMetadata(
      { PROXYHUB_GIT_SHA: 'not-a-sha', PROXYHUB_BUILD_TIME: 'not-a-date' },
      'c'.repeat(64),
    );
    expect(metadata.gitSha).toBe('unknown');
    expect(metadata.gitShortSha).toBe('unknown');
    expect(metadata.buildTime).toBe('unknown');
  });

  it('calculates the checked-in migration fingerprint', async () => {
    await expect(calculateMigrationFingerprint()).resolves.toMatch(/^[0-9a-f]{64}$/);
  });
});
