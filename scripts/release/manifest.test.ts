import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createReleaseManifest,
  migrationFingerprint,
  readReleaseVersion,
  validateReleaseManifest,
} from './manifest-lib.mjs';

const gitSha = '1234567890abcdef1234567890abcdef12345678';

describe('release version and manifest', () => {
  it('loads the canonical development version', async () => {
    await expect(readReleaseVersion()).resolves.toMatchObject({
      version: '0.3.1-dev',
      xrayVersion: '26.5.9',
    });
  });

  it('creates a schema-valid dry-run manifest', async () => {
    const manifest = await createReleaseManifest({
      gitSha,
      buildTime: '2026-07-25T00:00:00Z',
      mode: 'dry-run',
    });
    expect(manifest.gitShortSha).toBe(gitSha.slice(0, 12));
    expect(manifest.images.server.digest).toBeNull();
  });

  it('uses deterministic migration fingerprints', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'proxyhub-migrations-'));
    await writeFile(join(directory, 'ignored'), 'not a directory');
    await expect(migrationFingerprint()).resolves.toMatch(/^[0-9a-f]{64}$/);
  });

  it('rejects release manifests without digests', async () => {
    await expect(createReleaseManifest({ gitSha, mode: 'release' })).rejects.toThrow(
      /missing an immutable digest/,
    );
  });

  it('accepts release manifests with all immutable digests', async () => {
    const digest = `sha256:${'a'.repeat(64)}`;
    const manifest = await createReleaseManifest({
      gitSha,
      mode: 'release',
      digests: { web: digest, server: digest, agent: digest, xray: digest },
    });
    expect(manifest.images.web.digest).toBe(digest);
  });

  it('rejects unknown fields and secret-like fields', async () => {
    const manifest = await createReleaseManifest({ gitSha, mode: 'dry-run' });
    await expect(validateReleaseManifest({ ...manifest, token: 'forbidden' })).rejects.toThrow(
      /schema validation failed|secret-like/,
    );
  });

  it('keeps schema and canonical version files parseable', async () => {
    const [schema, version] = await Promise.all([
      readFile('release/manifest.schema.json', 'utf8'),
      readFile('release/version.json', 'utf8'),
    ]);
    expect(() => {
      JSON.parse(schema);
    }).not.toThrow();
    expect(() => {
      JSON.parse(version);
    }).not.toThrow();
  });
});
