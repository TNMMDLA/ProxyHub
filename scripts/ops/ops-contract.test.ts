import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { createReleaseManifest } from '../release/manifest-lib.mjs';

const exec = promisify(execFile);
const root = resolve(import.meta.dirname, '../..');

async function source(path: string): Promise<string> {
  return readFile(resolve(root, path), 'utf8');
}

describe('preflight contract', () => {
  const cases = [
    ['Linux requirement', 'Production operations require Linux'],
    ['architecture gate', 'Unsupported architecture'],
    ['Docker daemon', 'Docker daemon is not reachable'],
    ['Compose plugin', 'Docker Compose plugin is required'],
    ['disk hard stop', 'At least 1 GiB free is required'],
    ['memory hard stop', 'At least 512 MiB RAM is required'],
    ['swap warning', 'No swap is configured'],
    ['environment placeholders', 'still placeholders'],
    ['Compose validation', 'Merged release Compose configuration'],
    ['image access', 'One or more release images are not accessible'],
    ['domain syntax', 'PANEL_DOMAIN has invalid syntax'],
    ['JSON summary', 'summary:{failures:$failures,warnings:$warnings}'],
  ] as const;
  it.each(cases)('covers %s', async (_name, pattern) => {
    expect(await source('scripts/ops/preflight.sh')).toContain(pattern);
  });
});

describe('global lock contract', () => {
  const cases = [
    ['non-blocking flock', 'flock -n 9'],
    ['stable busy code', 'PROXYHUB_OPERATION_BUSY'],
    ['owner metadata', '{operation:$operation,pid:$pid,startedAt:$startedAt}'],
    ['automatic release', 'ops_lock_release'],
  ] as const;
  it.each(cases)('covers %s', async (_name, pattern) => {
    expect(await source('scripts/ops/lib/common.sh')).toContain(pattern);
  });
});

describe('Compose project contract', () => {
  it('inherits the conventional Compose project name for isolated runtimes', async () => {
    expect(await source('scripts/ops/lib/common.sh')).toContain(
      '${PROXYHUB_COMPOSE_PROJECT:=${COMPOSE_PROJECT_NAME:-proxyhub}}',
    );
  });
});

describe('health contract', () => {
  const cases = [
    ['five services', 'proxyhub-web proxyhub-server proxyhub-agent xray caddy'],
    ['restart detection', 'RestartCount'],
    ['Server API', 'Server health endpoint returned ok'],
    ['release identity', 'release-sha'],
    ['Xray config', 'xray run -test'],
    ['database migration', 'prisma migrate status'],
  ] as const;
  it.each(cases)('covers %s', async (_name, pattern) => {
    expect(await source('scripts/ops/health.sh')).toContain(pattern);
  });
});

describe('update state machine contract', () => {
  const stages = [
    'INITIALIZED',
    'LOCKED',
    'PREFLIGHT_PASSED',
    'BACKUP_CREATED',
    'RELEASE_VALIDATED',
    'IMAGES_PULLED',
    'MIGRATION_VALIDATED',
    'MIGRATION_APPLIED',
    'SERVICES_STARTED',
    'HEALTH_VERIFIED',
    'RELEASE_COMMITTED',
    'FAILED',
    'ROLLBACK_STARTED',
    'ROLLED_BACK',
    'ROLLBACK_FAILED',
  ] as const;
  it.each(stages)('contains update stage %s', async (stage) => {
    const contents = `${await source('scripts/ops/update.sh')}\n${await source(
      'scripts/ops/lib/state.sh',
    )}`;
    expect(contents).toContain(stage);
  });
});

describe('rollback contract', () => {
  const cases = [
    ['previous target', 'TARGET=previous'],
    ['explicit target', '--to RELEASE_ID'],
    ['immutable history', 'ops_release_history_target'],
    ['manifest validation', 'ops_manifest_validate "$target_manifest" true'],
    ['schema incompatibility', 'OPS_ROLLBACK_SCHEMA_INCOMPATIBLE'],
    ['pre-rollback backup', 'backup.sh" create'],
    ['health verification', 'health.sh'],
    ['failed rollback recovery', 'restore_current_on_failure'],
    ['release commit', 'ops_release_state_commit'],
  ] as const;
  it.each(cases)('covers %s', async (_name, pattern) => {
    expect(await source('scripts/ops/rollback.sh')).toContain(pattern);
  });
});

describe('backup contract', () => {
  const cases = [
    ['online backup', '.backup'],
    ['WAL-safe SQLite CLI', 'sqlite3'],
    ['integrity check', 'PRAGMA integrity_check;'],
    ['SQLite header', 'SQLite format 3'],
    ['archive naming', 'proxyhub-backup-$stamp-$short.tar.gz'],
    ['database member', 'database.sqlite'],
    ['manifest member', 'manifest.json'],
    ['checksums member', 'SHA256SUMS'],
    ['README member', 'README.txt'],
    ['no encryption key', 'encryptionKeyIncluded:false'],
    ['hash verification', 'sha256sum -c SHA256SUMS'],
    ['gzip validation', 'gzip -t'],
    ['path traversal rejection', 'OPS_BACKUP_PATH_UNSAFE'],
    ['symlink rejection', 'OPS_BACKUP_LINK_FORBIDDEN'],
    ['duplicate rejection', 'OPS_BACKUP_ENTRY_INVALID'],
    ['unknown entry rejection', 'OPS_BACKUP_UNKNOWN_ENTRY'],
    ['fingerprint check', 'OPS_BACKUP_FINGERPRINT_MISMATCH'],
    ['atomic publish', 'mv -f -- "$temporary_archive" "$final_archive"'],
    ['0600 permissions', 'chmod 0600'],
    ['count retention', 'index > COUNT'],
    ['age retention', 'mtime < cutoff'],
  ] as const;
  it.each(cases)('covers %s', async (_name, pattern) => {
    expect(await source('scripts/ops/backup.sh')).toContain(pattern);
  });
});

describe('safety contract', () => {
  const cases = [
    ['strict shell mode', 'set -Eeuo pipefail'],
    ['no system prune', 'system prune'],
    ['redaction', '[REDACTED]'],
    ['no database reset', 'prisma migrate reset'],
    ['dry-run mutation list', 'mutations:[]'],
    ['digest pinning', 'OPS_MANIFEST_DIGEST_REQUIRED'],
    ['state atomic write', 'ops_atomic_write'],
    ['non-interactive confirmation', 'OPS_CONFIRMATION_REQUIRED'],
  ] as const;
  it.each(cases)('covers %s', async (name, pattern) => {
    const contents = await Promise.all([
      source('scripts/ops/lib/common.sh'),
      source('scripts/ops/deploy.sh'),
      source('scripts/ops/update.sh'),
      source('scripts/ops/rollback.sh'),
      source('scripts/ops/backup.sh'),
    ]);
    if (name === 'no system prune' || name === 'no database reset') {
      expect(contents.join('\n')).not.toContain(pattern);
    } else {
      expect(contents.join('\n')).toContain(pattern);
    }
  });
});

describe('release regression contract', () => {
  const cases = [
    ['source Compose keeps build', 'build:'],
    ['release Compose disables build', 'build: null'],
    ['fixed Xray version', 'XRAY_CORE_VERSION=26.5.9'],
    ['correct Xray binary', '/usr/local/bin/xray'],
    ['server SQLite CLI', 'apk add --no-cache sqlite'],
    ['log rotation', 'max-size: 10m'],
    ['health metadata', 'databaseMigrationFingerprint'],
    ['no latest tag', ':latest'],
  ] as const;
  it.each(cases)('protects %s', async (name, pattern) => {
    const contents = await Promise.all([
      source('docker-compose.yml'),
      source('docker-compose.release.yml'),
      source('docker/server.Dockerfile'),
      source('docker/agent.Dockerfile'),
      source('docker/xray.Dockerfile'),
      source('scripts/release/manifest-lib.mjs'),
    ]);
    if (name === 'no latest tag') {
      expect(contents.join('\n')).not.toContain(pattern);
    } else {
      expect(contents.join('\n')).toContain(pattern);
    }
  });
});

const linux = process.platform === 'linux';

describe.skipIf(!linux)('Linux ops behavior with isolated fixtures', () => {
  it('preflight uses fake Docker/Git/curl tools without mutating state', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'proxyhub-preflight-'));
    const bin = join(directory, 'bin');
    const state = join(directory, 'state');
    const backups = join(directory, 'backups');
    await mkdir(bin);
    const fake = '#!/usr/bin/env bash\nexit 0\n';
    for (const command of ['docker', 'git', 'curl', 'sqlite3']) {
      const path = join(bin, command);
      await writeFile(path, fake);
      await chmod(path, 0o755);
    }
    const environment = join(directory, '.env');
    await writeFile(
      environment,
      [
        'PANEL_DOMAIN=localhost',
        'WEB_ORIGIN=https://localhost',
        'ENCRYPTION_KEY=fixture-encryption-key-with-32-characters',
        'AGENT_TOKEN=fixture-agent-token',
      ].join('\n'),
    );
    const manifest = await createReleaseManifest({
      gitSha: '1'.repeat(40),
      mode: 'release',
      digests: {
        web: `sha256:${'a'.repeat(64)}`,
        server: `sha256:${'b'.repeat(64)}`,
        agent: `sha256:${'c'.repeat(64)}`,
        xray: `sha256:${'d'.repeat(64)}`,
      },
    });
    const manifestPath = join(directory, 'manifest.json');
    await writeFile(manifestPath, JSON.stringify(manifest));
    const { stdout } = await exec(
      'bash',
      [
        resolve(root, 'scripts/ops/preflight.sh'),
        '--manifest',
        manifestPath,
        '--env-file',
        environment,
        '--json',
      ],
      {
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          PROXYHUB_STATE_DIR: state,
          PROXYHUB_BACKUP_DIR: backups,
          PROXYHUB_SKIP_REMOTE_IMAGE_CHECK: 'true',
        },
      },
    );
    expect(JSON.parse(stdout)).toMatchObject({ success: true });
    await expect(readFile(join(state, 'releases/current.json'))).rejects.toThrow();
  });

  it('rejects a concurrent global lock with the stable error code', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'proxyhub-lock-'));
    const holder = execFile(
      'bash',
      [
        '-c',
        `source "$1"; PROXYHUB_STATE_DIR="$2"; ops_refresh_paths; ops_lock_acquire test; sleep 2`,
        'bash',
        resolve(root, 'scripts/ops/lib/common.sh'),
        directory,
      ],
      { env: process.env },
    );
    await new Promise((resolve_) => setTimeout(resolve_, 300));
    await expect(
      exec('bash', [
        '-c',
        `source "$1"; PROXYHUB_STATE_DIR="$2"; ops_refresh_paths; ops_lock_acquire second`,
        'bash',
        resolve(root, 'scripts/ops/lib/common.sh'),
        directory,
      ]),
    ).rejects.toMatchObject({ stderr: expect.stringContaining('PROXYHUB_OPERATION_BUSY') });
    await new Promise<void>((resolve_, reject) => {
      holder.once('exit', (code) =>
        code === 0 ? resolve_() : reject(new Error(`holder ${code}`)),
      );
    });
  });

  it('creates and verifies a consistent fixture backup', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'proxyhub-backup-'));
    const state = join(directory, 'state');
    const backups = join(directory, 'backups');
    const database = join(directory, 'proxyhub.db');
    const manifestPath = join(directory, 'manifest.json');
    await mkdir(join(state, 'releases'), { recursive: true });
    await exec('sqlite3', [
      database,
      'CREATE TABLE fixture(id INTEGER PRIMARY KEY, value TEXT); INSERT INTO fixture(value) VALUES ("ok");',
    ]);
    const manifest = await createReleaseManifest({
      gitSha: '2'.repeat(40),
      mode: 'dry-run',
    });
    await writeFile(manifestPath, JSON.stringify(manifest));
    await writeFile(
      join(state, 'releases/current.json'),
      JSON.stringify({
        releaseId: manifest.releaseId,
        version: manifest.version,
        gitSha: manifest.gitSha,
        manifestPath,
        deployMode: 'image',
        imageDigests: {},
        databaseMigrationFingerprint: manifest.databaseMigrationFingerprint,
        deployedAt: manifest.buildTime,
        transactionId: 'fixture',
      }),
    );
    const { stdout } = await exec(
      'bash',
      [
        resolve(root, 'scripts/ops/backup.sh'),
        'create',
        '--state-dir',
        state,
        '--backup-dir',
        backups,
      ],
      {
        env: {
          ...process.env,
          PROXYHUB_DATABASE_PATH: database,
          PROXYHUB_STATE_DIR: state,
          PROXYHUB_BACKUP_DIR: backups,
        },
      },
    );
    const archive = stdout.trim().split('\n').at(-1);
    expect(archive).toBeTruthy();
    const verified = await exec('bash', [
      resolve(root, 'scripts/ops/backup.sh'),
      'verify',
      '--archive',
      archive!,
      '--json',
    ]);
    expect(JSON.parse(verified.stdout)).toMatchObject({ success: true });
  });

  it('backup prune dry-run does not delete recognized files', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'proxyhub-prune-'));
    const sentinel = join(directory, 'manual-file.tar.gz');
    await writeFile(sentinel, 'do not delete');
    await exec(
      'bash',
      [
        resolve(root, 'scripts/ops/backup.sh'),
        'prune',
        '--backup-dir',
        directory,
        '--count',
        '0',
        '--days',
        '0',
        '--dry-run',
      ],
      { env: { ...process.env, PROXYHUB_BACKUP_DIR: directory } },
    );
    expect(await readFile(sentinel, 'utf8')).toBe('do not delete');
  });
});
