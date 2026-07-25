import { readFile, stat } from 'node:fs/promises';
import { cpus, freemem, loadavg, totalmem, uptime } from 'node:os';
import { performance, monitorEventLoopDelay } from 'node:perf_hooks';
import {
  aggregateStatus,
  createDiagnosticItem,
  diagnosticsReportSchema,
  type DiagnosticItem,
  type DiagnosticsReport,
} from '@proxyhub/diagnostics-core';
import { PROXYHUB_RELEASE } from '@proxyhub/shared';
import { testXrayConfig } from '@proxyhub/xray-manager';
import type { AgentConfig } from './config.js';
import type { RealityTargetCompatibilityService } from './reality-target-compatibility.js';
import { inspectXrayHealth } from './xray-health.js';

async function readCgroupNumber(path: string): Promise<number | null> {
  try {
    const value = (await readFile(path, 'utf8')).trim();
    if (value === 'max') return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
  } catch {
    return null;
  }
}

async function eventLoopLag(): Promise<number> {
  const histogram = monitorEventLoopDelay({ resolution: 10 });
  histogram.enable();
  await new Promise((resolve) => setTimeout(resolve, 25));
  histogram.disable();
  return Math.round(histogram.mean / 1_000_000);
}

export async function collectAgentDiagnostics(
  config: AgentConfig,
  compatibility: RealityTargetCompatibilityService,
  options: { deep?: boolean } = {},
): Promise<DiagnosticsReport> {
  const started = performance.now();
  const observedAt = new Date().toISOString();
  const [xray, lagMs, cgroupCurrent, cgroupMax, configInfo, restartInfo] = await Promise.all([
    inspectXrayHealth(config),
    eventLoopLag(),
    readCgroupNumber('/sys/fs/cgroup/memory.current'),
    readCgroupNumber('/sys/fs/cgroup/memory.max'),
    stat(config.XRAY_CONFIG_PATH).catch(() => null),
    stat(config.XRAY_APPLIED_PATH).catch(() => null),
  ]);
  const items: DiagnosticItem[] = [];
  const add = (
    value: Omit<DiagnosticItem, 'severity' | 'freshness' | 'observedAt' | 'durationMs'>,
  ) =>
    items.push(
      createDiagnosticItem({
        ...value,
        observedAt,
        durationMs: Math.round(performance.now() - started),
      }),
    );

  const processMemory = process.memoryUsage();
  add({
    id: 'runtime.agent.health',
    category: 'RUNTIME',
    status: lagMs > 250 ? 'WARNING' : 'HEALTHY',
    title: 'Agent Runtime',
    summary: lagMs > 250 ? 'Agent event loop is delayed' : 'Agent is responsive',
    source: 'agent',
    scope: 'process',
    details: {
      version: PROXYHUB_RELEASE.version,
      uptimeSeconds: Math.round(process.uptime()),
      eventLoopLagMs: lagMs,
      rssBytes: processMemory.rss,
      heapUsedBytes: processMemory.heapUsed,
    },
    recommendations: lagMs > 250 ? ['Inspect container CPU pressure and Agent logs.'] : [],
    errorCode: lagMs > 250 ? 'AGENT_EVENT_LOOP_LAG' : null,
  });
  add({
    id: 'system.agent.resources',
    category: 'SYSTEM',
    status: 'HEALTHY',
    title: 'Agent Resource Scope',
    summary: cgroupMax
      ? 'Container cgroup resource data is available'
      : 'Process resource data is available',
    source: 'agent',
    scope: cgroupMax ? 'cgroup' : 'process',
    details: {
      cpuCount: cpus().length,
      loadAverage1m: loadavg()[0] ?? 0,
      processMemoryBytes: processMemory.rss,
      cgroupMemoryCurrentBytes: cgroupCurrent,
      cgroupMemoryLimitBytes: cgroupMax,
      visibleMemoryTotalBytes: totalmem(),
      visibleMemoryFreeBytes: freemem(),
      visibleUptimeSeconds: Math.round(uptime()),
    },
    recommendations: [],
    errorCode: null,
  });
  add({
    id: 'runtime.xray.health',
    category: 'RUNTIME',
    status:
      xray.status === 'HEALTHY'
        ? 'HEALTHY'
        : xray.status === 'OFFLINE'
          ? 'CRITICAL'
          : xray.status === 'DEGRADED'
            ? 'WARNING'
            : 'UNKNOWN',
    title: 'Xray Runtime',
    summary: `Xray is ${xray.status.toLowerCase()}`,
    source: 'agent',
    scope: 'container',
    details: {
      version: xray.version,
      running: xray.running,
      pid: xray.checks.process.pid,
      configValid: xray.checks.config.healthy,
      configuredPortCount: xray.checks.ports.configured.length,
      listeningPortCount: xray.checks.ports.listening.length,
      heartbeatAt: xray.checks.container.heartbeatAt,
      configModifiedAt: configInfo?.mtime.toISOString() ?? null,
      lastRestartAcknowledgedAt: restartInfo?.mtime.toISOString() ?? null,
      lastRollbackAt: 'unavailable',
    },
    recommendations:
      xray.status === 'HEALTHY' ? [] : ['Inspect Xray process, config, and listening state.'],
    errorCode: xray.status === 'HEALTHY' ? null : 'XRAY_UNHEALTHY',
  });

  const compatibilityState = compatibility.diagnosticsState();
  add({
    id: 'reality.compatibility.capability',
    category: 'REALITY',
    status: compatibilityState.busy ? 'WARNING' : 'HEALTHY',
    title: 'Reality Compatibility Runner',
    summary: compatibilityState.busy
      ? 'Compatibility runner is busy'
      : 'Compatibility runner is available',
    source: 'agent',
    scope: 'process',
    details: compatibilityState,
    recommendations: compatibilityState.busy
      ? ['Wait for the current compatibility test to finish.']
      : [],
    errorCode: compatibilityState.busy ? 'REALITY_COMPATIBILITY_BUSY' : null,
  });
  add({
    id: 'runtime.xray.lifecycle-history',
    category: 'RUNTIME',
    status: configInfo || restartInfo ? 'UNKNOWN' : 'NOT_AVAILABLE',
    title: 'Xray Lifecycle History',
    summary:
      configInfo || restartInfo
        ? 'Filesystem timestamps are available, but a reliable rollback timestamp is not persisted'
        : 'Xray lifecycle timestamps are not available',
    source: 'agent',
    scope: 'container',
    details: {
      configModifiedAt: configInfo?.mtime.toISOString() ?? null,
      lastRestartAcknowledgedAt: restartInfo?.mtime.toISOString() ?? null,
      lastRollbackAt: 'unavailable',
    },
    recommendations: [
      'Use Audit Logs and Phase 1 operation state for authoritative lifecycle history.',
    ],
    errorCode: 'XRAY_LIFECYCLE_HISTORY_PARTIAL',
  });

  let configStatus: 'HEALTHY' | 'WARNING' | 'NOT_APPLICABLE' = 'NOT_APPLICABLE';
  let configSummary = 'Deep Xray config validation was not requested';
  let configCode: string | null = null;
  if (options.deep) {
    try {
      await stat(config.XRAY_CONFIG_PATH);
      await testXrayConfig(config.XRAY_BINARY, config.XRAY_CONFIG_PATH);
      configStatus = 'HEALTHY';
      configSummary = 'Current Xray configuration passed validation';
    } catch {
      configStatus = 'WARNING';
      configSummary = 'Current Xray configuration failed validation';
      configCode = 'XRAY_CONFIG_INVALID';
    }
  }
  add({
    id: 'runtime.xray.config-validation',
    category: 'RUNTIME',
    status: configStatus,
    title: 'Xray Config Validation',
    summary: configSummary,
    source: 'agent',
    scope: 'container',
    details: { requested: Boolean(options.deep), valid: configStatus === 'HEALTHY' },
    recommendations: configCode
      ? ['Inspect the active configuration using the existing validation workflow.']
      : [],
    errorCode: configCode,
  });

  const durationMs = Math.round(performance.now() - started);
  return diagnosticsReportSchema.parse({
    schemaVersion: 1,
    kind: options.deep ? 'deep' : 'section',
    status: aggregateStatus(items),
    generatedAt: observedAt,
    expiresAt: new Date(Date.now() + 15_000).toISOString(),
    durationMs,
    cached: false,
    items,
  });
}
