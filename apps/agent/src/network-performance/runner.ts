import { randomUUID } from 'node:crypto';
import {
  analyzePerformance,
  calculateEfficiency,
  calculateJitter,
  calculatePerformanceScore,
  detectTargetPathOutliers,
  finalRunStatus,
  median,
  percentile,
  type NetworkPerformanceEnvironment,
  type NetworkPerformancePathMetrics,
  type NetworkPerformanceProgress,
  type NetworkPerformanceResult,
  type NetworkPerformanceTarget,
  type NetworkPerformanceTargetResult,
} from '@proxyhub/network-performance-core';
import {
  buildNetworkPerformanceClientConfig,
  getXrayVersion,
  type NetworkPerformanceNodeCredentials,
} from '@proxyhub/xray-manager';
import {
  allocateLoopbackPort,
  cleanupPerformanceDirectory,
  createSecureTempDirectory,
  measureHttps,
  startTemporaryXray,
  waitForLoopbackPort,
  writeSecureXrayConfig,
  type HttpsMeasurement,
  type ManagedTemporaryXray,
  type SafeHttpsRuntimeOptions,
} from './network-runtime.js';

export type NetworkPerformanceErrorCode =
  | 'NETWORK_PERFORMANCE_TEST_BUSY'
  | 'NETWORK_PERFORMANCE_NODE_DISABLED'
  | 'NETWORK_PERFORMANCE_UNSUPPORTED_NODE'
  | 'NETWORK_PERFORMANCE_TARGET_INVALID'
  | 'NETWORK_PERFORMANCE_TARGET_UNREACHABLE'
  | 'NETWORK_PERFORMANCE_TUNNEL_FAILED'
  | 'NETWORK_PERFORMANCE_TIMEOUT'
  | 'NETWORK_PERFORMANCE_CANCELLED'
  | 'NETWORK_PERFORMANCE_INTERNAL_ERROR'
  | 'NETWORK_PERFORMANCE_CLEANUP_FAILED';

export class NetworkPerformanceError extends Error {
  constructor(
    readonly code: NetworkPerformanceErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'NetworkPerformanceError';
  }
}

export interface NetworkPerformanceNodeInput extends NetworkPerformanceNodeCredentials {
  enabled: boolean;
  protocol: string;
  transport: string;
  security: string;
  name: string;
  serverName: string;
  serverRegion: string;
  realityTarget: string;
  proxyhubVersion: string;
  gitSha: string;
  deployMode: string;
}

export interface NetworkPerformanceRunSnapshot {
  id: string;
  status: 'RUNNING' | 'COMPLETED' | 'PARTIAL' | 'FAILED' | 'CANCELLED' | 'INTERRUPTED';
  progress: NetworkPerformanceProgress;
  result?: NetworkPerformanceResult;
  errorCode?: NetworkPerformanceErrorCode;
}

export interface PerformanceRunnerRuntime {
  version(binary: string): Promise<string>;
  allocatePort(signal: AbortSignal): Promise<number>;
  createDirectory(): Promise<string>;
  writeConfig(directory: string, config: Record<string, unknown>): Promise<string>;
  startXray(binary: string, configPath: string): Promise<ManagedTemporaryXray>;
  waitForPort(port: number, process: ManagedTemporaryXray, signal: AbortSignal): Promise<void>;
  measure(
    input: { url: string; signal: AbortSignal; maxBytes: number; proxyPort?: number },
    options: SafeHttpsRuntimeOptions,
  ): Promise<HttpsMeasurement>;
  cleanupDirectory(directory: string | undefined): Promise<void>;
}

const nativeRuntime: PerformanceRunnerRuntime = {
  version: getXrayVersion,
  allocatePort: allocateLoopbackPort,
  createDirectory: createSecureTempDirectory,
  writeConfig: writeSecureXrayConfig,
  startXray: startTemporaryXray,
  waitForPort: waitForLoopbackPort,
  measure: measureHttps,
  cleanupDirectory: cleanupPerformanceDirectory,
};

export interface NetworkPerformanceRunnerOptions {
  binary: string;
  targets: NetworkPerformanceTarget[];
  globalTimeoutMs: number;
  targetTimeoutMs: number;
  smallRequestSamples?: number;
  downloadSamples?: number;
  allowPrivateTargets?: boolean;
  insecureTlsForTesting?: boolean;
  runtime?: Partial<PerformanceRunnerRuntime>;
}

function emptyPathMetrics(): NetworkPerformancePathMetrics {
  return {
    downloadMbps: null,
    downloadSamplesMbps: [] as number[],
    latencyMedianMs: null,
    latencyP95Ms: null,
    jitterMs: null,
    successfulRequests: 0,
    failedRequests: 0,
  };
}

function megabitsPerSecond(measurement: HttpsMeasurement): number {
  if (measurement.bytes <= 0 || measurement.durationMs <= 0) return 0;
  return (measurement.bytes * 8) / (measurement.durationMs * 1_000);
}

function errorCode(error: unknown): NetworkPerformanceErrorCode {
  const message = error instanceof Error ? error.message : '';
  if (message.includes('TARGET_INVALID')) return 'NETWORK_PERFORMANCE_TARGET_INVALID';
  if (message.includes('TIMEOUT')) return 'NETWORK_PERFORMANCE_TIMEOUT';
  if (message.includes('TUNNEL')) return 'NETWORK_PERFORMANCE_TUNNEL_FAILED';
  return 'NETWORK_PERFORMANCE_TARGET_UNREACHABLE';
}

export class NetworkPerformanceRunner {
  private readonly runtime: PerformanceRunnerRuntime;
  private readonly runs = new Map<string, NetworkPerformanceRunSnapshot>();
  private active: { id: string; controller: AbortController } | null = null;

  constructor(private readonly options: NetworkPerformanceRunnerOptions) {
    this.runtime = { ...nativeRuntime, ...options.runtime };
  }

  capability(): {
    available: boolean;
    targetCount: number;
    busy: boolean;
    maxConcurrentRuns: 1;
  } {
    return {
      available: this.options.targets.length > 0,
      targetCount: this.options.targets.length,
      busy: this.active !== null,
      maxConcurrentRuns: 1,
    };
  }

  start(node: NetworkPerformanceNodeInput): NetworkPerformanceRunSnapshot {
    if (this.active) {
      throw new NetworkPerformanceError(
        'NETWORK_PERFORMANCE_TEST_BUSY',
        'Another network performance test is already running',
      );
    }
    if (!node.enabled) {
      throw new NetworkPerformanceError(
        'NETWORK_PERFORMANCE_NODE_DISABLED',
        'Disabled nodes cannot be tested',
      );
    }
    if (
      node.protocol.toUpperCase() !== 'VLESS' ||
      node.transport.toUpperCase() !== 'TCP' ||
      node.security.toUpperCase() !== 'REALITY' ||
      node.flow !== 'xtls-rprx-vision'
    ) {
      throw new NetworkPerformanceError(
        'NETWORK_PERFORMANCE_UNSUPPORTED_NODE',
        'Only VLESS TCP REALITY Vision nodes are supported',
      );
    }
    if (this.options.targets.length === 0) {
      throw new NetworkPerformanceError(
        'NETWORK_PERFORMANCE_TARGET_INVALID',
        'No network performance targets are configured',
      );
    }
    const id = randomUUID();
    const controller = new AbortController();
    const snapshot: NetworkPerformanceRunSnapshot = {
      id,
      status: 'RUNNING',
      progress: {
        stage: 'PREPARING',
        currentTarget: 0,
        totalTargets: this.options.targets.length,
        remainingSteps: this.options.targets.length + 3,
      },
    };
    this.runs.set(id, snapshot);
    this.active = { id, controller };
    void this.execute(id, node, controller).catch(() => undefined);
    return structuredClone(snapshot);
  }

  get(id: string): NetworkPerformanceRunSnapshot | null {
    const snapshot = this.runs.get(id);
    return snapshot ? structuredClone(snapshot) : null;
  }

  cancel(id: string): boolean {
    if (!this.active || this.active.id !== id) return false;
    this.active.controller.abort();
    return true;
  }

  private update(id: string, patch: Partial<NetworkPerformanceRunSnapshot>): void {
    const current = this.runs.get(id);
    if (!current) return;
    this.runs.set(id, { ...current, ...patch });
  }

  private async execute(
    id: string,
    node: NetworkPerformanceNodeInput,
    controller: AbortController,
  ): Promise<void> {
    const startedAt = Date.now();
    let timedOut = false;
    let directory: string | undefined;
    let temporaryXray: ManagedTemporaryXray | undefined;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.options.globalTimeoutMs);
    let cleanupFailed = false;
    try {
      const xrayVersion = await this.runtime.version(this.options.binary);
      const socksPort = await this.runtime.allocatePort(controller.signal);
      this.update(id, {
        progress: {
          stage: 'ESTABLISHING_TUNNEL',
          currentTarget: 0,
          totalTargets: this.options.targets.length,
          remainingSteps: this.options.targets.length + 2,
        },
      });
      const tunnelStartedAt = performance.now();
      directory = await this.runtime.createDirectory();
      const config = buildNetworkPerformanceClientConfig({ socksPort, node });
      const configPath = await this.runtime.writeConfig(directory, config);
      temporaryXray = await this.runtime.startXray(this.options.binary, configPath);
      await this.runtime.waitForPort(socksPort, temporaryXray, controller.signal);
      const tunnelEstablishmentMs = performance.now() - tunnelStartedAt;
      const targets: NetworkPerformanceTargetResult[] = [];
      for (const [index, target] of this.options.targets.entries()) {
        if (controller.signal.aborted) throw new Error('ABORTED');
        this.update(id, {
          progress: {
            stage: 'TESTING_TARGET',
            currentTarget: index + 1,
            totalTargets: this.options.targets.length,
            remainingSteps: this.options.targets.length - index + 1,
          },
        });
        const targetResult = await this.testTarget(target, socksPort, controller.signal);
        if (controller.signal.aborted) throw new Error('ABORTED');
        targets.push(targetResult);
      }
      this.update(id, {
        progress: {
          stage: 'CALCULATING',
          currentTarget: this.options.targets.length,
          totalTargets: this.options.targets.length,
          remainingSteps: 1,
        },
      });
      const outliers = detectTargetPathOutliers(targets);
      for (const target of targets) {
        if (outliers.has(target.targetId)) target.analysisCodes.push('TARGET_PATH_DEGRADED');
      }
      const status = finalRunStatus(targets);
      const successfulRequests = targets.reduce(
        (total, target) => total + target.tunnel.successfulRequests,
        0,
      );
      const attemptedRequests = targets.reduce(
        (total, target) => total + target.tunnel.successfulRequests + target.tunnel.failedRequests,
        0,
      );
      const result: NetworkPerformanceResult = {
        status,
        score: calculatePerformanceScore(targets),
        tunnelEstablishmentMs,
        targets,
        medianDirectMbps: median(
          targets
            .map((target) => target.direct.downloadMbps)
            .filter((value): value is number => value !== null),
        ),
        medianTunnelMbps: median(
          targets
            .map((target) => target.tunnel.downloadMbps)
            .filter((value): value is number => value !== null),
        ),
        successRatePercent:
          attemptedRequests === 0 ? 0 : (successfulRequests / attemptedRequests) * 100,
        analysisCodes: analyzePerformance(targets),
        durationMs: Date.now() - startedAt,
        environment: {
          source: 'PROXYHUB_SERVER',
          serverName: node.serverName,
          serverRegion: node.serverRegion,
          nodeName: node.name,
          nodePort: node.port,
          protocol: node.protocol,
          transport: node.transport,
          security: node.security,
          flow: node.flow,
          realityTarget: node.realityTarget,
          sni: node.sni,
          xrayVersion,
          proxyhubVersion: node.proxyhubVersion,
          gitSha: node.gitSha,
          deployMode: node.deployMode,
          testedAt: new Date().toISOString(),
        } satisfies NetworkPerformanceEnvironment,
      };
      this.update(id, {
        status,
        result,
        progress: {
          stage: 'COMPLETED',
          currentTarget: this.options.targets.length,
          totalTargets: this.options.targets.length,
          remainingSteps: 0,
        },
      });
    } catch {
      const cancelled = controller.signal.aborted && !timedOut;
      this.update(id, {
        status: cancelled ? 'CANCELLED' : 'FAILED',
        errorCode: cancelled
          ? 'NETWORK_PERFORMANCE_CANCELLED'
          : timedOut
            ? 'NETWORK_PERFORMANCE_TIMEOUT'
            : 'NETWORK_PERFORMANCE_INTERNAL_ERROR',
      });
    } finally {
      clearTimeout(timeout);
      const cleanup = await Promise.allSettled([
        ...(temporaryXray ? [temporaryXray.stop()] : []),
        this.runtime.cleanupDirectory(directory),
      ]);
      cleanupFailed = cleanup.some((entry) => entry.status === 'rejected');
      if (cleanupFailed) {
        this.update(id, {
          status: 'FAILED',
          errorCode: 'NETWORK_PERFORMANCE_CLEANUP_FAILED',
        });
      }
      if (this.active?.id === id) this.active = null;
    }
  }

  private async testTarget(
    target: NetworkPerformanceTarget,
    socksPort: number,
    globalSignal: AbortSignal,
  ): Promise<NetworkPerformanceTargetResult> {
    const controller = new AbortController();
    const onGlobalAbort = () => controller.abort();
    globalSignal.addEventListener('abort', onGlobalAbort, { once: true });
    const timeout = setTimeout(() => controller.abort(), this.options.targetTimeoutMs);
    const direct = emptyPathMetrics();
    const tunnel = emptyPathMetrics();
    const runtimeOptions: SafeHttpsRuntimeOptions = {
      allowPrivateTargets: this.options.allowPrivateTargets ?? false,
      insecureTlsForTesting: this.options.insecureTlsForTesting ?? false,
      maxRedirects: 3,
    };
    try {
      for (let sample = 0; sample < (this.options.smallRequestSamples ?? 5); sample += 1) {
        try {
          const measurement = await this.runtime.measure(
            {
              url: target.smallRequestUrl,
              signal: controller.signal,
              maxBytes: 64 * 1024,
            },
            runtimeOptions,
          );
          direct.downloadSamplesMbps.push(measurement.firstByteMs);
          direct.successfulRequests += 1;
        } catch {
          direct.failedRequests += 1;
        }
        try {
          const measurement = await this.runtime.measure(
            {
              url: target.smallRequestUrl,
              signal: controller.signal,
              maxBytes: 64 * 1024,
              proxyPort: socksPort,
            },
            runtimeOptions,
          );
          tunnel.downloadSamplesMbps.push(measurement.firstByteMs);
          tunnel.successfulRequests += 1;
        } catch {
          tunnel.failedRequests += 1;
        }
      }
      const directLatencies = [...direct.downloadSamplesMbps];
      const tunnelLatencies = [...tunnel.downloadSamplesMbps];
      direct.downloadSamplesMbps = [];
      tunnel.downloadSamplesMbps = [];
      direct.latencyMedianMs = median(directLatencies);
      direct.latencyP95Ms = percentile(directLatencies, 95);
      direct.jitterMs = calculateJitter(directLatencies);
      tunnel.latencyMedianMs = median(tunnelLatencies);
      tunnel.latencyP95Ms = percentile(tunnelLatencies, 95);
      tunnel.jitterMs = calculateJitter(tunnelLatencies);

      for (let sample = 0; sample < (this.options.downloadSamples ?? 2); sample += 1) {
        const directMeasurement = await this.runtime.measure(
          {
            url: target.downloadUrl,
            signal: controller.signal,
            maxBytes: target.maxDownloadBytes,
          },
          runtimeOptions,
        );
        direct.downloadSamplesMbps.push(megabitsPerSecond(directMeasurement));
        const tunnelMeasurement = await this.runtime.measure(
          {
            url: target.downloadUrl,
            signal: controller.signal,
            maxBytes: target.maxDownloadBytes,
            proxyPort: socksPort,
          },
          runtimeOptions,
        );
        tunnel.downloadSamplesMbps.push(megabitsPerSecond(tunnelMeasurement));
      }
      direct.downloadMbps = median(direct.downloadSamplesMbps);
      tunnel.downloadMbps = median(tunnel.downloadSamplesMbps);
      const efficiencyPercent = calculateEfficiency(tunnel.downloadMbps, direct.downloadMbps);
      return {
        targetId: target.id,
        targetLabel: target.label,
        success:
          direct.downloadMbps !== null &&
          tunnel.downloadMbps !== null &&
          tunnel.successfulRequests > 0,
        direct,
        tunnel,
        efficiencyPercent,
        uploadStatus: 'NOT_AVAILABLE',
        analysisCodes: [],
      };
    } catch (error) {
      return {
        targetId: target.id,
        targetLabel: target.label,
        success: false,
        errorCode: controller.signal.aborted ? 'NETWORK_PERFORMANCE_TIMEOUT' : errorCode(error),
        direct,
        tunnel,
        efficiencyPercent: calculateEfficiency(tunnel.downloadMbps, direct.downloadMbps),
        uploadStatus: 'NOT_AVAILABLE',
        analysisCodes: [],
      };
    } finally {
      clearTimeout(timeout);
      globalSignal.removeEventListener('abort', onGlobalAbort);
    }
  }
}
