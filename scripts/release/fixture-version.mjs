import {
  nextPatchDevelopmentVersion,
  previousCoreVersion,
  readReleaseVersion,
} from './manifest-lib.mjs';

try {
  const mode = process.argv[2];
  if (mode !== 'upgrade' && mode !== 'downgrade') {
    throw new Error('Usage: node scripts/release/fixture-version.mjs <upgrade|downgrade>');
  }
  const release = await readReleaseVersion();
  const fixtureVersion =
    mode === 'upgrade'
      ? nextPatchDevelopmentVersion(release.version)
      : previousCoreVersion(release.version);
  process.stdout.write(`${fixtureVersion}\n`);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Release fixture version error: ${message}`);
  process.exitCode = 1;
}
