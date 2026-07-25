import { createWriteStream } from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import { pack } from 'tar-stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createDiagnosticItem,
  DiagnosticsError,
  diagnosticsReportSchema,
  type DiagnosticsReport,
} from '@proxyhub/diagnostics-core';
import type { AgentClient } from '../agent-client.js';
import { parseConfig } from '../config.js';
import { DiagnosticsService } from './service.js';

let root: string;
let state: string;
let backups: string;

async function createBackup(path: string, manifest: Record<string, unknown>): Promise<void> {
  const archive = pack();
  archive.entry({ name: 'database.sqlite' }, 'fixture');
  archive.entry({ name: 'manifest.json' }, JSON.stringify(manifest));
  archive.finalize();
  await pipeline(archive, createGzip(), createWriteStream(path));
}

const agentReport = (): DiagnosticsReport =>
  diagnosticsReportSchema.parse({
    schemaVersion: 1,
    kind: 'section',
    status: 'HEALTHY',
    generatedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 10_000).toISOString(),
    durationMs: 1,
    cached: false,
    items: [
      createDiagnosticItem({
        id: 'runtime.agent.test',
        category: 'RUNTIME',
        status: 'HEALTHY',
        title: 'Agent',
        summary: 'Agent is healthy',
        observedAt: new Date().toISOString(),
        source: 'agent',
        scope: 'process',
        durationMs: 1,
        details: {},
        recommendations: [],
        errorCode: null,
      }),
    ],
  });

function fakeDatabase() {
  return {
    $queryRawUnsafe: vi.fn(async (query: string) => {
      if (query === 'SELECT 1') return [{ value: 1 }];
      if (query.includes('_prisma_migrations'))
        return [
          {
            migration_name: 'fixture',
            finished_at: new Date().toISOString(),
            rolled_back_at: null,
          },
        ];
      if (query.includes('quick_check')) return [{ quick_check: 'ok' }];
      return [];
    }),
    ruleSet: { findMany: vi.fn(async () => []) },
    subscription: { findMany: vi.fn(async () => []) },
    auditLog: {
      findMany: vi.fn(async () => []),
      count: vi.fn(async () => 0),
    },
    adminUser: { findMany: vi.fn(async () => [{ totpEnabled: true, role: 'ADMIN' }]) },
    notification: {},
  };
}

function service(
  options: { agent?: Partial<AgentClient>; database?: ReturnType<typeof fakeDatabase> } = {},
) {
  const database = options.database ?? fakeDatabase();
  const agent = {
    diagnostics: vi.fn(async () => agentReport()),
    status: vi.fn(),
    ...options.agent,
  } as unknown as AgentClient;
  const config = parseConfig({
    NODE_ENV: 'test',
    DATABASE_URL: `file:${join(root, 'database.db')}`,
    ENCRYPTION_KEY: 'test-encryption-key-at-least-32-bytes',
    AGENT_TOKEN: 'test-agent-token-at-least-16',
    PROXYHUB_STATE_DIR: state,
    PROXYHUB_BACKUP_DIR: backups,
    PROXYHUB_DIAGNOSTICS_CACHE_TTL_MS: '5000',
    PROXYHUB_DIAGNOSTICS_DEEP_TIMEOUT_MS: '5000',
  });
  return { instance: new DiagnosticsService(database as never, agent, config), database, agent };
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'proxyhub-diagnostics-service-'));
  state = join(root, 'state');
  backups = join(root, 'backups');
  await mkdir(join(state, 'releases', 'history'), { recursive: true });
  await mkdir(join(state, 'releases', 'manifests'), { recursive: true });
  await mkdir(join(state, 'transactions'), { recursive: true });
  await mkdir(join(state, 'diagnostics'), { recursive: true });
  await mkdir(backups);
  await writeFile(join(root, 'database.db'), 'fixture');
  await writeFile(
    join(state, 'releases', 'current.json'),
    JSON.stringify({
      version: '0.3.1-dev',
      gitSha: '0'.repeat(40),
      deployMode: 'source',
      deployedAt: '2026-01-01T00:00:00Z',
    }),
  );
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('DiagnosticsService', () => {
  it('returns one aggregated overview', async () => {
    const report = await service().instance.overview();
    expect(report.kind).toBe('overview');
    expect(report.items.length).toBeGreaterThan(8);
  });
  it('uses a cache hit for a repeated overview', async () => {
    const { instance, agent } = service();
    await instance.overview();
    const second = await instance.overview();
    expect(second.cached).toBe(true);
    expect((agent.diagnostics as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
  });
  it('supports a manual cache bypass', async () => {
    const { instance, agent } = service();
    await instance.overview();
    await instance.overview(true);
    expect((agent.diagnostics as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(2);
  });
  it('keeps partial results when Agent is unavailable', async () => {
    const { instance } = service({
      agent: { diagnostics: vi.fn(async () => Promise.reject(new Error('unavailable'))) },
    });
    const report = await instance.overview();
    expect(report.items.find((item) => item.id === 'network.agent.reachability')?.status).toBe(
      'CRITICAL',
    );
    expect(report.items.find((item) => item.id === 'database.sqlite.health')).toBeDefined();
  });
  it('reports database unavailability without leaking an error', async () => {
    const database = fakeDatabase();
    database.$queryRawUnsafe.mockRejectedValue(new Error('file:/private/database.db'));
    const report = await service({ database }).instance.overview();
    const item = report.items.find((entry) => entry.id === 'database.sqlite.health');
    expect(item?.status).toBe('CRITICAL');
    expect(JSON.stringify(item)).not.toContain('/private/');
  });
  it('runs quick_check only during deep diagnostics', async () => {
    const { instance, database } = service();
    await instance.overview();
    expect(database.$queryRawUnsafe).not.toHaveBeenCalledWith('PRAGMA quick_check');
    await instance.deep();
    expect(database.$queryRawUnsafe).toHaveBeenCalledWith('PRAGMA quick_check');
  });
  it('rejects a concurrent deep scan', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { instance } = service({
      agent: { diagnostics: vi.fn(async () => gate.then(agentReport)) },
    });
    const first = instance.deep();
    await expect(instance.deep()).rejects.toMatchObject({ code: 'DIAGNOSTICS_SCAN_BUSY' });
    release();
    await first;
  });
  it('times out a bounded deep scan and keeps the semaphore until child cleanup', async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { instance } = service({
      agent: { diagnostics: vi.fn(async () => gate.then(agentReport)) },
    });
    try {
      const scan = instance.deep();
      const timeoutExpectation = expect(scan).rejects.toMatchObject({
        code: 'DIAGNOSTICS_SCAN_TIMEOUT',
      });
      await vi.advanceTimersByTimeAsync(5_001);
      await timeoutExpectation;
      await expect(instance.deep()).rejects.toMatchObject({ code: 'DIAGNOSTICS_SCAN_BUSY' });
      release();
      await vi.runAllTimersAsync();
    } finally {
      vi.useRealTimers();
    }
  });
  it('cancels a deep scan when the client disconnects', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { instance } = service({
      agent: { diagnostics: vi.fn(async () => gate.then(agentReport)) },
    });
    const controller = new AbortController();
    const scan = instance.deep(controller.signal);
    controller.abort();
    await expect(scan).rejects.toMatchObject({ code: 'DIAGNOSTICS_SCAN_CANCELLED' });
    release();
  });
  it('clears the deep-scan semaphore after failure', async () => {
    const diagnostics = vi
      .fn()
      .mockRejectedValueOnce(new Error('failure'))
      .mockResolvedValueOnce(agentReport());
    const { instance } = service({ agent: { diagnostics } });
    await instance.deep();
    await expect(instance.deep()).resolves.toMatchObject({ kind: 'deep' });
  });
  it('exports a schema-valid bounded report', async () => {
    const exported = await service().instance.export();
    expect(exported.filename).toMatch(/^proxyhub-diagnostics-.+\.json$/);
    expect(exported.report.kind).toBe('export');
    expect(JSON.stringify(exported.report).length).toBeLessThan(2 * 1024 * 1024);
  });
  it('does not expose absolute paths in export', async () => {
    const exported = await service().instance.export();
    expect(JSON.stringify(exported.report)).not.toContain(root);
  });
  it('does not expose backup download, delete, or restore capabilities', async () => {
    const report = await service().instance.overview();
    const item = report.items.find((entry) => entry.id === 'backup.archive.visibility');
    expect(item?.details).toMatchObject({
      downloadCapability: false,
      deleteCapability: false,
      restoreCapability: false,
    });
  });
  it('validates the latest embedded backup manifest only during a deep scan', async () => {
    await createBackup(join(backups, 'proxyhub-backup-20260101T000000Z-abcdef.tar.gz'), {
      schemaVersion: 1,
      application: {
        name: 'ProxyHub',
        version: '0.3.1-dev',
        gitSha: '0'.repeat(40),
        xrayVersion: '26.5.9',
      },
      createdAt: '2026-01-01T00:00:00.000Z',
      database: {
        filename: 'database.sqlite',
        sizeBytes: 7,
        sha256: '1'.repeat(64),
        integrity: 'ok',
        migrationFingerprint: '2'.repeat(64),
      },
      encryptionKeyIncluded: false,
    });
    const overview = await service().instance.overview();
    expect(
      overview.items.find((entry) => entry.id === 'backup.archive.visibility')?.details,
    ).toMatchObject({ manifestVerification: 'not-run' });
    const deep = await service().instance.deep();
    expect(
      deep.items.find((entry) => entry.id === 'backup.archive.visibility')?.details,
    ).toMatchObject({
      manifestVerification: 'passed',
      latestManifestVersion: '0.3.1-dev',
      latestManifestGitSha: '000000000000',
      latestManifestXrayVersion: '26.5.9',
    });
  });
  it('does not perform a remote Rule Set fetch', async () => {
    const report = await service().instance.overview();
    expect(report.items.find((entry) => entry.id === 'rule-set.summary')?.details).toMatchObject({
      remoteFetchPerformed: false,
    });
  });
  it('does not run automatic Reality compatibility tests', async () => {
    const report = await service().instance.overview();
    expect(
      report.items.find((entry) => entry.id === 'reality.compatibility.summary')?.details,
    ).toMatchObject({ automaticTestPerformed: false, persistedResultAvailable: false });
  });
  it('filters database sections', async () => {
    const report = await service().instance.section('DATABASE');
    expect(report.kind).toBe('section');
    expect(report.items.every((item) => item.category === 'DATABASE')).toBe(true);
  });
  it('combines release and backup data in the operations section', async () => {
    const report = await service().instance.section('OPERATIONS');
    expect(report.items.some((item) => item.category === 'RELEASE')).toBe(true);
    expect(report.items.some((item) => item.category === 'BACKUP')).toBe(true);
  });
  it('uses a stable busy error code', () =>
    expect(new DiagnosticsError('DIAGNOSTICS_SCAN_BUSY', 'busy').code).toBe(
      'DIAGNOSTICS_SCAN_BUSY',
    ));
});
