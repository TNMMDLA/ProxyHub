// @ts-nocheck -- This standalone release CLI is validated through JSON Schema and regression tests.
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import semver from 'semver';

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const versionPath = resolve(root, 'release/version.json');
const schemaPath = resolve(root, 'release/manifest.schema.json');
const migrationsPath = resolve(root, 'apps/server/prisma/migrations');

export async function readReleaseVersion() {
  return JSON.parse(await readFile(versionPath, 'utf8'));
}

function parseReleaseSemver(version) {
  if (
    typeof version !== 'string' ||
    !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:[-+]|$)/u.test(version)
  ) {
    throw new Error(`Invalid release semantic version: ${String(version)}`);
  }
  const parsed = semver.parse(version);
  if (!parsed) throw new Error(`Invalid release semantic version: ${version}`);
  return parsed;
}

export function compareReleaseVersions(left, right) {
  return semver.compare(parseReleaseSemver(left), parseReleaseSemver(right));
}

export function nextPatchDevelopmentVersion(version) {
  const parsed = parseReleaseSemver(version);
  if (parsed.patch >= Number.MAX_SAFE_INTEGER)
    throw new Error(`Release patch version cannot be incremented safely: ${version}`);
  return `${parsed.major}.${parsed.minor}.${parsed.patch + 1}-dev`;
}

export function previousCoreVersion(version) {
  const parsed = parseReleaseSemver(version);
  if (parsed.patch > 0) return `${parsed.major}.${parsed.minor}.${parsed.patch - 1}`;
  if (parsed.minor > 0) return `${parsed.major}.${parsed.minor - 1}.0`;
  if (parsed.major > 0) return `${parsed.major - 1}.0.0`;
  throw new Error(`Release version has no lower core version for a downgrade fixture: ${version}`);
}

export async function migrationFingerprint(directory = migrationsPath) {
  const entries = await readdir(directory, { withFileTypes: true });
  const names = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  const hash = createHash('sha256');
  for (const name of names) {
    const relativePath = `${name}/migration.sql`;
    hash.update(relativePath);
    hash.update('\0');
    hash.update(await readFile(resolve(directory, name, 'migration.sql')));
    hash.update('\0');
  }
  return hash.digest('hex');
}

function ensureNoSecretFields(value, path = '$') {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (/(secret|password|token|encryption.?key|private.?key)/i.test(key)) {
      throw new Error(`Release manifest contains a forbidden secret-like field at ${path}.${key}`);
    }
    ensureNoSecretFields(child, `${path}.${key}`);
  }
}

export async function validateReleaseManifest(manifest, options = {}) {
  const schema = JSON.parse(await readFile(schemaPath, 'utf8'));
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  const validate = ajv.compile(schema);
  if (!validate(manifest)) {
    const details = ajv.errorsText(validate.errors, { separator: '; ' });
    throw new Error(`Release manifest schema validation failed: ${details}`);
  }
  ensureNoSecretFields(manifest);
  if (manifest.gitShortSha !== manifest.gitSha.slice(0, 12)) {
    throw new Error('Release manifest gitShortSha does not match gitSha');
  }
  if (options.requireDigests) {
    for (const [name, image] of Object.entries(manifest.images)) {
      if (!image.digest) throw new Error(`Release image ${name} is missing an immutable digest`);
    }
  }
  return manifest;
}

export async function createReleaseManifest(options) {
  const release = await readReleaseVersion();
  const gitSha = options.gitSha.toLowerCase();
  const tag = options.tag ?? `${release.version}-${gitSha.slice(0, 12)}`;
  const buildTime = new Date(options.buildTime ?? Date.now()).toISOString();
  const repository = process.env.GITHUB_REPOSITORY?.toLowerCase();
  const defaultImagePrefix = repository ? `ghcr.io/${repository}` : 'ghcr.io/example/proxyhub';
  const imagePrefix = (
    options.imagePrefix ??
    process.env.PROXYHUB_IMAGE_PREFIX ??
    defaultImagePrefix
  ).toLowerCase();
  const image = (name) => ({
    repository: `${imagePrefix}-${name}`,
    tag,
    digest: options.digests?.[name] ?? null,
  });
  const manifest = {
    schemaVersion: release.manifestSchemaVersion,
    releaseId: `${release.version}-${gitSha.slice(0, 12)}-${buildTime.replaceAll(/[-:.TZ]/g, '')}`,
    version: release.version,
    gitSha,
    gitShortSha: gitSha.slice(0, 12),
    buildTime,
    buildEnvironment: options.buildEnvironment ?? 'ci',
    deployMode: options.deployMode ?? 'image',
    xrayVersion: release.xrayVersion,
    databaseMigrationFingerprint: await migrationFingerprint(options.migrationsPath),
    images: {
      web: image('web'),
      server: image('server'),
      agent: image('agent'),
      xray: image('xray'),
    },
  };
  return validateReleaseManifest(manifest, {
    requireDigests: options.mode === 'release',
  });
}

export function parseArguments(arguments_) {
  const result = {};
  const firstArgument = arguments_[0] === '--' ? 1 : 0;
  for (let index = firstArgument; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (!argument?.startsWith('--')) throw new Error(`Unexpected argument: ${argument}`);
    const key = argument.slice(2);
    const value = arguments_[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for --${key}`);
    result[key] = value;
    index += 1;
  }
  return result;
}
