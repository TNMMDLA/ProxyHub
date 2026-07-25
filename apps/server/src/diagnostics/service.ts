import { access, constants, stat, statfs } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { cpus, freemem, loadavg, totalmem } from 'node:os';
import { performance } from 'node:perf_hooks';
import type { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import {
  aggregateStatus,
  containsDiagnosticSecret,
  createDiagnosticItem,
  diagnosticsReportSchema,
  DiagnosticsError,
  ERROR_RECOMMENDATIONS,
  redactDiagnostics,
  type DiagnosticCategory,
  type DiagnosticItem,
  type DiagnosticsReport,
} from '@proxyhub/diagnostics-core';
import type { AgentClient } from '../agent-client.js';
import type { AppConfig } from '../config.js';
import { compileStoredPolicy } from '../policy-service.js';
import { getBuildMetadata } from '../release/build-metadata.js';
import { SafeReaderError, SafeStateReader } from './safe-reader.js';

type Database = Pick<
  PrismaClient,
  'adminUser' | 'auditLog' | 'notification' | 'ruleSet' | 'subscription' | '$queryRawUnsafe'
>;

const nowIso = () => new Date().toISOString();
const backupManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    application: z.object({
      name: z.literal('ProxyHub'),
      version: z.string().min(1).max(100),
      gitSha: z.string().regex(/^[0-9a-f]{40}$/),
      xrayVersion: z.string().min(1).max(100),
    }),
    createdAt: z.string().datetime(),
    database: z.object({
      filename: z.literal('database.sqlite'),
      sizeBytes: z.number().int().nonnegative(),
      sha256: z.string().regex(/^[0-9a-f]{64}$/),
      integrity: z.literal('ok'),
      migrationFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
    }),
    encryptionKeyIncluded: z.literal(false),
  })
  .strip();
const toSafeString = (value: unknown) =>
  typeof value === 'string'
    ? value.slice(0, 500)
    : typeof value === 'number' || typeof value === 'boolean'
      ? String(value)
      : value == null
        ? null
        : '[structured value]';

export class DiagnosticsService {
  private cache: { report: DiagnosticsReport; expires: number } | undefined;
  private activeScan = false;
  private readonly state: SafeStateReader;
  private readonly backups: SafeStateReader;

  constructor(
    private readonly database: Database,
    private readonly agent: AgentClient,
    private readonly config: AppConfig,
  ) {
    this.state = new SafeStateReader(config.PROXYHUB_STATE_DIR);
    this.backups = new SafeStateReader(config.PROXYHUB_BACKUP_DIR);
  }

  async overview(bypass = false): Promise<DiagnosticsReport> {
    if (!bypass && this.cache && this.cache.expires > Date.now()) {
      return diagnosticsReportSchema.parse({ ...this.cache.report, cached: true });
    }
    const report = await this.collect(false);
    this.cache = { report, expires: Date.now() + this.config.PROXYHUB_DIAGNOSTICS_CACHE_TTL_MS };
    return report;
  }

  async section(category: DiagnosticCategory): Promise<DiagnosticsReport> {
    const report = await this.overview();
    const categories =
      category === 'OPERATIONS' ? (['OPERATIONS', 'RELEASE', 'BACKUP'] as const) : [category];
    const items = report.items.filter((item) => categories.includes(item.category as never));
    return diagnosticsReportSchema.parse({
      ...report,
      kind: 'section',
      status: aggregateStatus(items),
      items,
    });
  }

  async deep(signal?: AbortSignal): Promise<DiagnosticsReport> {
    if (this.activeScan) {
      throw new DiagnosticsError(
        'DIAGNOSTICS_SCAN_BUSY',
        'Another deep diagnostics scan is running',
      );
    }
    this.activeScan = true;
    const controller = new AbortController();
    let timedOut = false;
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.config.PROXYHUB_DIAGNOSTICS_DEEP_TIMEOUT_MS);
    const collection = this.collect(true, controller.signal);
    try {
      return await Promise.race([
        collection,
        new Promise<never>((_, reject) =>
          controller.signal.addEventListener(
            'abort',
            () =>
              reject(
                new DiagnosticsError(
                  timedOut ? 'DIAGNOSTICS_SCAN_TIMEOUT' : 'DIAGNOSTICS_SCAN_CANCELLED',
                  timedOut
                    ? 'Deep diagnostics scan timed out'
                    : 'Deep diagnostics scan was cancelled',
                ),
              ),
            { once: true },
          ),
        ),
      ]);
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', onAbort);
      if (controller.signal.aborted) {
        void collection
          .finally(() => {
            this.activeScan = false;
          })
          .catch(() => undefined);
      } else {
        this.activeScan = false;
      }
    }
  }

  async export(): Promise<{ filename: string; report: DiagnosticsReport }> {
    const report = redactDiagnostics({
      ...(await this.overview(true)),
      kind: 'export' as const,
    });
    if (
      containsDiagnosticSecret(report) ||
      Buffer.byteLength(JSON.stringify(report)) > 2 * 1024 * 1024
    ) {
      throw new DiagnosticsError(
        'DIAGNOSTICS_EXPORT_REDACTION_FAILED',
        'Diagnostics export failed the security review',
      );
    }
    diagnosticsReportSchema.parse(report);
    return {
      filename: `proxyhub-diagnostics-${new Date().toISOString().replace(/[:.]/g, '-')}.json`,
      report,
    };
  }

  private item(
    input: Omit<DiagnosticItem, 'severity' | 'freshness' | 'observedAt' | 'durationMs'>,
    started: number,
  ): DiagnosticItem {
    return createDiagnosticItem({
      ...input,
      observedAt: nowIso(),
      durationMs: Math.max(0, Math.round(performance.now() - started)),
    });
  }

  private async collect(deep: boolean, signal?: AbortSignal): Promise<DiagnosticsReport> {
    const started = performance.now();
    if (!this.config.PROXYHUB_DIAGNOSTICS_ENABLED) {
      const item = this.item(
        {
          id: 'system.diagnostics.disabled',
          category: 'SYSTEM',
          status: 'NOT_AVAILABLE',
          title: 'Diagnostics',
          summary: 'Diagnostics are disabled by configuration',
          source: 'server',
          scope: 'application',
          details: {},
          recommendations: ['Enable diagnostics in the Server configuration.'],
          errorCode: 'DIAGNOSTICS_DISABLED',
        },
        started,
      );
      return diagnosticsReportSchema.parse({
        schemaVersion: 1,
        kind: deep ? 'deep' : 'overview',
        status: item.status,
        generatedAt: nowIso(),
        expiresAt: new Date(
          Date.now() + this.config.PROXYHUB_DIAGNOSTICS_CACHE_TTL_MS,
        ).toISOString(),
        durationMs: 0,
        cached: false,
        items: [item],
      });
    }
    const groups = await Promise.all([
      this.runtime(started, deep, signal),
      this.databaseItems(started, deep),
      this.storage(started),
      this.operations(started, deep, signal),
      this.business(started, deep, signal),
      this.security(started),
    ]);
    const items = groups.flat();
    return diagnosticsReportSchema.parse({
      schemaVersion: 1,
      kind: deep ? 'deep' : 'overview',
      status: aggregateStatus(items),
      generatedAt: nowIso(),
      expiresAt: new Date(Date.now() + this.config.PROXYHUB_DIAGNOSTICS_CACHE_TTL_MS).toISOString(),
      durationMs: Math.round(performance.now() - started),
      cached: false,
      items,
    });
  }

  private async runtime(
    started: number,
    deep: boolean,
    signal?: AbortSignal,
  ): Promise<DiagnosticItem[]> {
    const metadata = await getBuildMetadata();
    const items = [
      this.item(
        {
          id: 'runtime.server.health',
          category: 'RUNTIME',
          status: 'HEALTHY',
          title: 'ProxyHub Server',
          summary: 'Server diagnostics API is responsive',
          source: 'server',
          scope: 'process',
          details: {
            version: metadata.version,
            gitSha: metadata.gitShortSha,
            buildTime: metadata.buildTime,
            deployMode: metadata.deployMode,
            uptimeSeconds: Math.round(process.uptime()),
            restartCount: 'unavailable',
          },
          recommendations: [],
          errorCode: null,
        },
        started,
      ),
      this.item(
        {
          id: 'network.api.reachability',
          category: 'NETWORK',
          status: 'HEALTHY',
          title: 'Server API Reachability',
          summary: 'The authenticated diagnostics request reached the Server API',
          source: 'server',
          scope: 'application',
          details: { reachable: true },
          recommendations: [],
          errorCode: null,
        },
        started,
      ),
      this.item(
        {
          id: 'runtime.container.details',
          category: 'RUNTIME',
          status: 'NOT_AVAILABLE',
          title: 'Container Runtime Details',
          summary: 'Restart counts are unavailable because Docker Socket is not mounted',
          source: 'server',
          scope: 'container',
          details: { restartCountAvailable: false },
          recommendations: ['Use Docker Compose on the host to inspect restart counts.'],
          errorCode: 'CONTAINER_RUNTIME_DETAILS_UNAVAILABLE',
        },
        started,
      ),
      this.item(
        {
          id: 'network.web.reachability',
          category: 'NETWORK',
          status: 'NOT_AVAILABLE',
          title: 'Web Reachability',
          summary: 'Server-side Web probing is not configured in this deployment mode',
          source: 'server',
          scope: 'container',
          details: { reachable: 'not measured', arbitraryTargetProbeAllowed: false },
          recommendations: [
            'Use the current browser session and Docker health status to verify Web reachability.',
          ],
          errorCode: 'WEB_REACHABILITY_NOT_CONFIGURED',
        },
        started,
      ),
      this.item(
        {
          id: 'network.caddy.reachability',
          category: 'NETWORK',
          status: 'NOT_AVAILABLE',
          title: 'Caddy Reachability',
          summary: 'Caddy HTTPS reachability requires deployment-boundary verification',
          source: 'server',
          scope: 'container',
          details: { reachable: 'not measured', arbitraryTargetProbeAllowed: false },
          recommendations: ['Verify Caddy health and HTTPS from the VPS smoke-test workflow.'],
          errorCode: 'CADDY_REACHABILITY_NOT_CONFIGURED',
        },
        started,
      ),
    ];
    try {
      const agent = this.agent.diagnostics
        ? await this.agent.diagnostics(deep, signal)
        : await this.agent.status().then((status) => ({
            items: [
              this.item(
                {
                  id: 'runtime.xray.health',
                  category: 'RUNTIME' as const,
                  status:
                    status.xray.status === 'HEALTHY' ? ('HEALTHY' as const) : ('WARNING' as const),
                  title: 'Xray Runtime',
                  summary: `Xray is ${status.xray.status.toLowerCase()}`,
                  source: 'agent',
                  scope: 'container' as const,
                  details: { version: status.xray.version, running: status.xray.running },
                  recommendations: [],
                  errorCode: status.xray.status === 'HEALTHY' ? null : 'XRAY_UNHEALTHY',
                },
                started,
              ),
            ],
          }));
      items.push(...agent.items);
      items.push(
        this.item(
          {
            id: 'network.agent.reachability',
            category: 'NETWORK',
            status: 'HEALTHY',
            title: 'Agent Reachability',
            summary: 'Server can reach the configured Agent service',
            source: 'server',
            scope: 'container',
            details: { reachable: true },
            recommendations: [],
            errorCode: null,
          },
          started,
        ),
      );
    } catch {
      items.push(
        this.item(
          {
            id: 'network.agent.reachability',
            category: 'NETWORK',
            status: 'CRITICAL',
            title: 'Agent Reachability',
            summary: 'Server cannot reach the configured Agent service',
            source: 'server',
            scope: 'container',
            details: { reachable: false },
            recommendations: [ERROR_RECOMMENDATIONS.AGENT_UNAVAILABLE!],
            errorCode: 'AGENT_UNAVAILABLE',
          },
          started,
        ),
      );
    }
    return items;
  }

  private databasePath(): string | null {
    if (!this.config.DATABASE_URL.startsWith('file:')) return null;
    const value = this.config.DATABASE_URL.slice(5);
    return isAbsolute(value) ? value : resolve(import.meta.dirname, '../../prisma', value);
  }

  private async databaseItems(started: number, deep: boolean): Promise<DiagnosticItem[]> {
    const path = this.databasePath();
    const began = performance.now();
    try {
      await this.database.$queryRawUnsafe('SELECT 1');
      const migrationRows = z
        .array(
          z.object({
            migration_name: z.string().optional(),
            finished_at: z.union([z.string(), z.date()]).nullable().optional(),
            rolled_back_at: z.union([z.string(), z.date()]).nullable().optional(),
          }),
        )
        .parse(
          await this.database.$queryRawUnsafe(
            'SELECT migration_name, finished_at, rolled_back_at FROM _prisma_migrations',
          ),
        );
      let quickCheck: string | null = null;
      if (deep) {
        const rows = z
          .array(z.record(z.string(), z.unknown()))
          .parse(await this.database.$queryRawUnsafe('PRAGMA quick_check'));
        quickCheck = toSafeString(Object.values(rows[0] ?? {})[0]);
      }
      const size = path ? await stat(path).catch(() => null) : null;
      const wal = path ? await stat(`${path}-wal`).catch(() => null) : null;
      const shm = path ? await stat(`${path}-shm`).catch(() => null) : null;
      const writable = path
        ? await access(dirname(path), constants.W_OK).then(
            () => true,
            () => false,
          )
        : false;
      const failedMigrations = migrationRows.filter(
        (row) => !row.finished_at && !row.rolled_back_at,
      ).length;
      const healthy = failedMigrations === 0 && (!deep || quickCheck === 'ok');
      return [
        this.item(
          {
            id: 'database.sqlite.health',
            category: 'DATABASE',
            status: healthy ? 'HEALTHY' : 'CRITICAL',
            title: 'SQLite Database',
            summary: healthy
              ? 'SQLite is reachable and migration state is consistent'
              : 'SQLite diagnostics found a failure',
            source: 'server',
            scope: 'database-filesystem',
            details: {
              type: 'SQLite',
              reachable: true,
              readLatencyMs: Math.round(performance.now() - began),
              fileSizeBytes: size?.size ?? null,
              walSizeBytes: wal?.size ?? 0,
              shmSizeBytes: shm?.size ?? 0,
              appliedMigrationCount: migrationRows.length,
              pendingMigrationCount: failedMigrations,
              migrationDrift: 'not reliably available at runtime',
              quickCheck: deep ? quickCheck : 'not requested',
              writeCapability: writable ? 'configured' : 'unavailable',
            },
            recommendations: healthy ? [] : [ERROR_RECOMMENDATIONS.DATABASE_QUICK_CHECK_FAILED!],
            errorCode: healthy ? null : 'DATABASE_QUICK_CHECK_FAILED',
          },
          started,
        ),
      ];
    } catch {
      return [
        this.item(
          {
            id: 'database.sqlite.health',
            category: 'DATABASE',
            status: 'CRITICAL',
            title: 'SQLite Database',
            summary: 'SQLite is not reachable',
            source: 'server',
            scope: 'database-filesystem',
            details: { reachable: false },
            recommendations: [ERROR_RECOMMENDATIONS.DATABASE_UNAVAILABLE!],
            errorCode: 'DATABASE_UNAVAILABLE',
          },
          started,
        ),
      ];
    }
  }

  private async storage(started: number): Promise<DiagnosticItem[]> {
    const databasePath = this.databasePath() ?? process.cwd();
    let disk: Awaited<ReturnType<typeof statfs>> | null = null;
    try {
      disk = await statfs(databasePath);
    } catch {
      disk = null;
    }
    const freeBytes = disk ? disk.bavail * disk.bsize : null;
    const diskStatus =
      freeBytes == null
        ? 'UNKNOWN'
        : freeBytes < 1024 ** 3
          ? 'CRITICAL'
          : freeBytes < 2 * 1024 ** 3
            ? 'WARNING'
            : 'HEALTHY';
    const total = totalmem();
    const available = freemem();
    const memoryStatus =
      available < 512 * 1024 ** 2 ? 'CRITICAL' : available < 1024 ** 3 ? 'WARNING' : 'HEALTHY';
    return [
      this.item(
        {
          id: 'storage.database.filesystem',
          category: 'STORAGE',
          status: diskStatus,
          title: 'Database Filesystem',
          summary:
            freeBytes == null
              ? 'Filesystem capacity is unavailable'
              : `${Math.round(freeBytes / 1024 ** 2)} MiB is available`,
          source: 'server',
          scope: 'database-filesystem',
          details: {
            totalBytes: disk ? disk.blocks * disk.bsize : null,
            availableBytes: freeBytes,
            availableInodes: disk?.ffree ?? null,
            warningThresholdBytes: 2 * 1024 ** 3,
            criticalThresholdBytes: 1024 ** 3,
          },
          recommendations:
            diskStatus === 'HEALTHY'
              ? []
              : ['Review database volume usage and backup retention on the host.'],
          errorCode: diskStatus === 'HEALTHY' ? null : 'STORAGE_CAPACITY_LOW',
        },
        started,
      ),
      this.item(
        {
          id: 'system.server.resources',
          category: 'SYSTEM',
          status: memoryStatus,
          title: 'Server Visible Resources',
          summary: 'Resource values reflect the Server container or process visibility',
          source: 'server',
          scope: 'unknown',
          details: {
            visibleMemoryTotalBytes: total,
            visibleMemoryAvailableBytes: available,
            cpuCount: cpus().length,
            loadAverage1m: loadavg()[0] ?? 0,
            processRssBytes: process.memoryUsage().rss,
            scopeExplanation: 'Node runtime visibility; host scope is not assumed',
          },
          recommendations:
            memoryStatus === 'HEALTHY'
              ? []
              : ['Review container memory pressure and swap on the VPS host.'],
          errorCode: memoryStatus === 'HEALTHY' ? null : 'MEMORY_AVAILABLE_LOW',
        },
        started,
      ),
    ];
  }

  private async operations(
    started: number,
    deep: boolean,
    signal?: AbortSignal,
  ): Promise<DiagnosticItem[]> {
    const items: DiagnosticItem[] = [];
    try {
      const current = redactDiagnostics(await this.state.json('releases/current.json'));
      const histories = await this.state
        .list('releases/history', this.config.PROXYHUB_DIAGNOSTICS_MAX_HISTORY)
        .catch(() => []);
      const manifests = await this.state
        .list('releases/manifests', this.config.PROXYHUB_DIAGNOSTICS_MAX_HISTORY)
        .catch(() => []);
      const transactions = await this.state
        .list('transactions', this.config.PROXYHUB_DIAGNOSTICS_MAX_HISTORY)
        .catch(() => []);
      const diagnosticRuns = await this.state
        .directories('diagnostics', this.config.PROXYHUB_DIAGNOSTICS_MAX_HISTORY)
        .catch(() => []);
      const transactionData = await Promise.all(
        transactions.map((name) => this.state.json(`transactions/${name}`).catch(() => null)),
      );
      const failed = transactionData.filter((value) => value?.currentStage === 'FAILED').length;
      items.push(
        this.item(
          {
            id: 'operations.release.state',
            category: 'RELEASE',
            status: 'HEALTHY',
            title: 'Release State',
            summary: 'Phase 1 release state is available through a read-only reader',
            source: 'operations-state',
            scope: 'application',
            details: {
              version: toSafeString(current.version),
              gitSha: toSafeString(current.gitSha)?.slice(0, 12) ?? null,
              deployMode: toSafeString(current.deployMode),
              deployedAt: toSafeString(current.deployedAt),
              historyCount: histories.length,
              releaseManifestCount: manifests.length,
              transactionCount: transactions.length,
              capturedDiagnosticsCount: diagnosticRuns.length,
              failedTransactionCount: failed,
              lastTransactionStage: toSafeString(transactionData[0]?.currentStage),
            },
            recommendations: failed
              ? ['Review the latest failed transaction in Phase 1 operations state.']
              : [],
            errorCode: failed ? 'OPERATIONS_TRANSACTION_FAILED' : null,
          },
          started,
        ),
      );
    } catch (error) {
      const invalid = error instanceof SafeReaderError && error.code !== 'NOT_AVAILABLE';
      items.push(
        this.item(
          {
            id: 'operations.release.state',
            category: 'RELEASE',
            status: invalid ? 'WARNING' : 'NOT_AVAILABLE',
            title: 'Release State',
            summary: invalid
              ? 'Phase 1 release state is invalid or unsafe'
              : 'Phase 1 release state is not mounted',
            source: 'operations-state',
            scope: 'application',
            details: { available: false },
            recommendations: [ERROR_RECOMMENDATIONS.STATE_NOT_AVAILABLE!],
            errorCode: invalid ? 'OPERATIONS_STATE_INVALID' : 'STATE_NOT_AVAILABLE',
          },
          started,
        ),
      );
    }
    try {
      const files = await this.backups.files(
        this.config.PROXYHUB_DIAGNOSTICS_MAX_BACKUPS,
        /^proxyhub-backup-\d+T\d+Z-[0-9a-f]+\.tar\.gz$/,
      );
      const totalSize = files.reduce((sum, file) => sum + file.sizeBytes, 0);
      let manifest:
        | {
            version: string;
            gitSha: string;
            xrayVersion: string;
            createdAt: string;
            databaseSizeBytes: number;
            migrationFingerprint: string;
          }
        | undefined;
      let verification: 'not-run' | 'passed' | 'failed' = 'not-run';
      if (deep && files[0]) {
        try {
          const parsed = backupManifestSchema.parse(
            await this.backups.archiveJson(files[0].name, 'manifest.json', signal),
          );
          manifest = {
            version: parsed.application.version,
            gitSha: parsed.application.gitSha.slice(0, 12),
            xrayVersion: parsed.application.xrayVersion,
            createdAt: parsed.createdAt,
            databaseSizeBytes: parsed.database.sizeBytes,
            migrationFingerprint: parsed.database.migrationFingerprint.slice(0, 12),
          };
          verification = 'passed';
        } catch {
          verification = 'failed';
        }
      }
      items.push(
        this.item(
          {
            id: 'backup.archive.visibility',
            category: 'BACKUP',
            status: verification === 'failed' ? 'WARNING' : files.length ? 'HEALTHY' : 'WARNING',
            title: 'Backup Archives',
            summary:
              verification === 'failed'
                ? 'The latest backup manifest failed safe validation'
                : files.length
                  ? `${files.length} recognized backup archive(s) are visible`
                  : 'No recognized backup archives are visible',
            source: 'backup-directory',
            scope: 'application',
            details: {
              count: files.length,
              totalSizeBytes: totalSize,
              latestCreatedAt: files[0]?.modifiedAt ?? null,
              largestSizeBytes: files.reduce((max, file) => Math.max(max, file.sizeBytes), 0),
              manifestVerification: verification,
              latestManifestVersion: manifest?.version ?? null,
              latestManifestGitSha: manifest?.gitSha ?? null,
              latestManifestXrayVersion: manifest?.xrayVersion ?? null,
              latestManifestCreatedAt: manifest?.createdAt ?? null,
              latestManifestDatabaseSizeBytes: manifest?.databaseSizeBytes ?? null,
              latestManifestMigrationFingerprint: manifest?.migrationFingerprint ?? null,
              fullArchiveVerification:
                'use the Phase 1 backup verification CLI for database checksum and integrity checks',
              downloadCapability: false,
              deleteCapability: false,
              restoreCapability: false,
            },
            recommendations:
              verification === 'failed'
                ? ['Verify the latest backup with the Phase 1 operations CLI.']
                : files.length
                  ? []
                  : ['Create and verify a backup with the Phase 1 operations CLI.'],
            errorCode:
              verification === 'failed'
                ? 'BACKUP_MANIFEST_INVALID'
                : files.length
                  ? null
                  : 'BACKUP_NOT_FOUND',
          },
          started,
        ),
      );
    } catch {
      items.push(
        this.item(
          {
            id: 'backup.archive.visibility',
            category: 'BACKUP',
            status: 'NOT_AVAILABLE',
            title: 'Backup Archives',
            summary: 'Backup directory is not mounted',
            source: 'backup-directory',
            scope: 'application',
            details: {
              available: false,
              downloadCapability: false,
              deleteCapability: false,
              restoreCapability: false,
            },
            recommendations: [ERROR_RECOMMENDATIONS.BACKUP_NOT_AVAILABLE!],
            errorCode: 'BACKUP_NOT_AVAILABLE',
          },
          started,
        ),
      );
    }
    return items;
  }

  private async business(
    started: number,
    deep: boolean,
    signal?: AbortSignal,
  ): Promise<DiagnosticItem[]> {
    const [ruleSets, subscriptions, realityAudit] = await Promise.all([
      this.database.ruleSet.findMany({
        select: {
          enabled: true,
          status: true,
          lastSuccessAt: true,
          lastFetchAt: true,
          nextUpdateAt: true,
          ruleCount: true,
          sourceType: true,
          format: true,
        },
      }),
      this.database.subscription.findMany({
        select: {
          enabled: true,
          format: true,
          expiresAt: true,
          lastAccessAt: true,
          policyId: true,
        },
      }),
      this.database.auditLog.findMany({
        where: { action: { contains: 'REALITY' } },
        select: { result: true, createdAt: true },
        take: 50,
        orderBy: { createdAt: 'desc' },
      }),
    ]);
    const failedRules = ruleSets.filter((rule) => rule.status === 'ERROR').length;
    const staleRules = ruleSets.filter((rule) => rule.status === 'STALE').length;
    const expired = subscriptions.filter(
      (sub) => sub.expiresAt && sub.expiresAt <= new Date(),
    ).length;
    let compilePassed = 0;
    let compileFailed = 0;
    let compileTimedOut = 0;
    if (deep) {
      const candidates = subscriptions
        .filter(
          (subscription) =>
            subscription.enabled &&
            (!subscription.expiresAt || subscription.expiresAt > new Date()),
        )
        .slice(0, 20);
      for (const subscription of candidates) {
        if (signal?.aborted) break;
        let timeout: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            compileStoredPolicy(
              subscription.policyId,
              subscription.format as 'mihomo' | 'sing-box' | 'raw',
            ),
            new Promise<never>((_, reject) => {
              timeout = setTimeout(() => reject(new Error('compile timeout')), 5_000);
            }),
          ]);
          compilePassed += 1;
        } catch (error) {
          if (error instanceof Error && error.message === 'compile timeout') compileTimedOut += 1;
          else compileFailed += 1;
        } finally {
          if (timeout) clearTimeout(timeout);
        }
      }
    }
    return [
      this.item(
        {
          id: 'rule-set.summary',
          category: 'RULE_SET',
          status: failedRules ? 'WARNING' : 'HEALTHY',
          title: 'Rule Set Summary',
          summary: failedRules
            ? `${failedRules} rule set(s) are in an error state`
            : 'No failed rule sets were found',
          source: 'database',
          scope: 'application',
          details: {
            total: ruleSets.length,
            enabled: ruleSets.filter((rule) => rule.enabled).length,
            healthy: ruleSets.filter((rule) => rule.status === 'READY').length,
            stale: staleRules,
            failed: failedRules,
            neverFetched: ruleSets.filter((rule) => !rule.lastFetchAt).length,
            totalRuleCount: ruleSets.reduce((sum, rule) => sum + rule.ruleCount, 0),
            remoteFetchPerformed: false,
          },
          recommendations: failedRules
            ? [
                'Open Rule Sets to review current error states; diagnostics did not fetch remote sources.',
              ]
            : [],
          errorCode: failedRules ? 'RULE_SET_FAILURES_PRESENT' : null,
        },
        started,
      ),
      this.item(
        {
          id: 'subscription.summary',
          category: 'SUBSCRIPTION',
          status: expired || compileFailed || compileTimedOut ? 'WARNING' : 'HEALTHY',
          title: 'Subscription Summary',
          summary: expired
            ? `${expired} subscription(s) are expired`
            : 'Subscription metadata is available',
          source: 'database',
          scope: 'application',
          details: {
            total: subscriptions.length,
            enabled: subscriptions.filter((sub) => sub.enabled).length,
            disabled: subscriptions.filter((sub) => !sub.enabled).length,
            expired,
            mihomo: subscriptions.filter((sub) => sub.format === 'mihomo').length,
            singBox: subscriptions.filter((sub) => sub.format === 'sing-box').length,
            raw: subscriptions.filter((sub) => sub.format === 'raw').length,
            compileDryRun: deep ? 'completed in memory' : 'not requested in overview',
            compilePassed,
            compileFailed,
            compileTimedOut,
            compileLimit: 20,
            compileConcurrency: 1,
            tokenExposed: false,
          },
          recommendations:
            expired || compileFailed || compileTimedOut
              ? ['Open Subscriptions to review expiration and compile diagnostics.']
              : [],
          errorCode:
            compileFailed || compileTimedOut
              ? 'SUBSCRIPTION_COMPILE_FAILURES'
              : expired
                ? 'SUBSCRIPTIONS_EXPIRED'
                : null,
        },
        started,
      ),
      this.item(
        {
          id: 'reality.compatibility.summary',
          category: 'REALITY',
          status: 'UNKNOWN',
          title: 'Reality Compatibility Results',
          summary: 'No persisted compatibility result is available',
          source: 'audit-log',
          scope: 'application',
          details: {
            recentAuditCount: realityAudit.length,
            successfulAuditCount: realityAudit.filter((entry) => entry.result === 'SUCCESS').length,
            failedAuditCount: realityAudit.filter((entry) => entry.result === 'FAILURE').length,
            automaticTestPerformed: false,
            persistedResultAvailable: false,
          },
          recommendations: [
            'Use the dedicated Reality Compatibility workflow when an explicit target test is required.',
          ],
          errorCode: 'REALITY_RESULT_NOT_PERSISTED',
        },
        started,
      ),
    ];
  }

  private async security(started: number): Promise<DiagnosticItem[]> {
    const [admins, recentFailures] = await Promise.all([
      this.database.adminUser.findMany({ select: { totpEnabled: true, role: true } }),
      this.database.auditLog.count({
        where: { result: 'FAILURE', createdAt: { gte: new Date(Date.now() - 86_400_000) } },
      }),
    ]);
    const secureCookie = this.config.NODE_ENV === 'production';
    return [
      this.item(
        {
          id: 'security.control.summary',
          category: 'SECURITY',
          status: secureCookie ? 'HEALTHY' : 'WARNING',
          title: 'Security Controls',
          summary: 'Non-sensitive security configuration is available',
          source: 'server',
          scope: 'application',
          details: {
            authenticationConfigured: true,
            twoFactorAvailable: true,
            administratorsWithTwoFactor: admins.filter((admin) => admin.totpEnabled).length,
            administratorCount: admins.length,
            secureCookieConfigured: secureCookie,
            trustedProxyConfigured: this.config.TRUST_PROXY,
            rateLimitConfigured: true,
            auditLoggingConfigured: true,
            encryptionConfigured: true,
            recentFailureAuditCount: recentFailures,
          },
          recommendations: secureCookie
            ? []
            : ['Use production mode behind HTTPS for secure session cookies.'],
          errorCode: secureCookie ? null : 'SECURE_COOKIE_NOT_ENABLED',
        },
        started,
      ),
    ];
  }
}
