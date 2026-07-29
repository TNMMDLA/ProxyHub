import type {
  AgentStatusData,
  RealityTargetCompatibilityResult,
  XrayHealthStatus,
} from '@proxyhub/shared';
import type { DiagnosticsReport } from '@proxyhub/diagnostics-core';
import type {
  NetworkPerformanceProgress,
  NetworkPerformanceResult,
} from '@proxyhub/network-performance-core';
import { config } from './config.js';
import { AppError } from './errors.js';

interface AgentEnvelope<T> {
  success: boolean;
  data?: T;
  error?: { code?: string; message?: string };
}

type AgentRequestInit = Omit<RequestInit, 'body'> & {
  body?: unknown;
};

export interface AgentApplyResult {
  applied: true;
  restarted: true;
  revision: string;
  health: XrayHealthStatus;
}

export interface AgentClient {
  status(): Promise<AgentStatusData>;
  diagnostics?(deep?: boolean, signal?: AbortSignal): Promise<DiagnosticsReport>;
  userStats?(): Promise<
    Array<{ statsIdentity: string; uplinkBytes: string; downlinkBytes: string }>
  >;
  testRealityTarget(
    input: {
      serverName: string;
      target: string;
    },
    signal?: AbortSignal,
  ): Promise<RealityTargetCompatibilityResult>;
  networkPerformanceCapability?(): Promise<{
    available: boolean;
    targetCount: number;
    busy: boolean;
    maxConcurrentRuns: 1;
  }>;
  startNetworkPerformance?(input: {
    address: string;
    port: number;
    uuid: string;
    flow: 'xtls-rprx-vision';
    sni: string;
    publicKey: string;
    shortId: string;
    fingerprint: string;
    enabled: boolean;
    protocol: string;
    transport: string;
    security: 'REALITY';
    name: string;
    serverName: string;
    serverRegion: string;
    realityTarget: string;
    proxyhubVersion: string;
    gitSha: string;
    deployMode: string;
  }): Promise<{
    id: string;
    status: string;
    progress: NetworkPerformanceProgress;
  }>;
  getNetworkPerformance?(id: string): Promise<{
    id: string;
    status: string;
    progress: NetworkPerformanceProgress;
    result?: NetworkPerformanceResult;
    errorCode?: string;
  }>;
  cancelNetworkPerformance?(id: string): Promise<{ cancelled: true }>;
  applyConfig(config: Record<string, unknown>): Promise<AgentApplyResult>;
  restart(): Promise<{ restarted: true; health: XrayHealthStatus }>;
  rollback(revision: string): Promise<{ rolledBack: true; health: XrayHealthStatus }>;
  confirm(revision: string): Promise<{ confirmed: true }>;
}

export async function agentRequest<T>(
  path: string,
  init: AgentRequestInit = {},
  timeoutMs = 5_000,
): Promise<T> {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  try {
    const signal = init.signal ? AbortSignal.any([init.signal, timeoutSignal]) : timeoutSignal;
    const { body: requestBody, ...requestInit } = init;
    const hasBody = requestBody !== undefined;
    const response = await fetch(new URL(path, config.AGENT_URL), {
      ...requestInit,
      ...(hasBody ? { body: JSON.stringify(requestBody) } : {}),
      headers: {
        ...(hasBody ? { 'content-type': 'application/json' } : {}),
        authorization: `Bearer ${config.AGENT_TOKEN}`,
        ...init.headers,
      },
      signal,
    });
    const body = (await response.json()) as AgentEnvelope<T>;
    if (!response.ok || !body.success || body.data === undefined) {
      const code = body.error?.code ?? 'AGENT_OPERATION_FAILED';
      const clientStatus = [
        'REALITY_TARGET_INVALID',
        'REALITY_TARGET_DNS_FAILED',
        'REALITY_TARGET_BLOCKED_ADDRESS',
        'NETWORK_PERFORMANCE_NODE_DISABLED',
        'NETWORK_PERFORMANCE_UNSUPPORTED_NODE',
        'NETWORK_PERFORMANCE_TARGET_INVALID',
      ].includes(code)
        ? 422
        : code === 'REALITY_TARGET_TEST_BUSY' || code === 'NETWORK_PERFORMANCE_TEST_BUSY'
          ? 409
          : code === 'REALITY_TARGET_TEST_TIMEOUT' || code === 'NETWORK_PERFORMANCE_TIMEOUT'
            ? 504
            : 503;
      throw new AppError(
        code,
        body.error?.message ?? `Agent returned ${String(response.status)}`,
        clientStatus,
      );
    }
    return body.data;
  } catch (error) {
    if (error instanceof AppError) throw error;
    if (init.signal?.aborted) {
      throw new AppError(
        'REALITY_TARGET_TEST_CANCELLED',
        'Reality compatibility test cancelled',
        499,
      );
    }
    if (timeoutSignal.aborted) {
      throw new AppError('AGENT_REQUEST_TIMEOUT', 'Agent request timed out', 504);
    }
    throw new AppError('AGENT_UNAVAILABLE', `Agent unavailable: ${(error as Error).message}`, 503);
  }
}

export const defaultAgentClient: AgentClient = {
  status: () => agentRequest<AgentStatusData>('/status'),
  diagnostics: (deep = false, signal) =>
    agentRequest<DiagnosticsReport>(
      `/diagnostics?deep=${deep ? 'true' : 'false'}`,
      signal ? { signal } : {},
      deep ? 20_000 : 5_000,
    ),
  userStats: () => agentRequest('/xray/user-stats', {}, 10_000),
  testRealityTarget: (input, signal) =>
    agentRequest<RealityTargetCompatibilityResult>(
      '/xray/reality-compatibility',
      { method: 'POST', body: input, ...(signal ? { signal } : {}) },
      30_000,
    ),
  networkPerformanceCapability: () => agentRequest('/network-performance/capability'),
  startNetworkPerformance: (input) =>
    agentRequest('/network-performance/runs', { method: 'POST', body: input }, 10_000),
  getNetworkPerformance: (id) =>
    agentRequest(`/network-performance/runs/${encodeURIComponent(id)}`),
  cancelNetworkPerformance: (id) =>
    agentRequest(
      `/network-performance/runs/${encodeURIComponent(id)}/cancel`,
      { method: 'POST' },
      10_000,
    ),
  applyConfig: (xrayConfig) =>
    agentRequest<AgentApplyResult>(
      '/xray/apply',
      { method: 'POST', body: { config: xrayConfig } },
      30_000,
    ),
  restart: () => agentRequest('/xray/restart', { method: 'POST' }, 30_000),
  rollback: (revision) =>
    agentRequest('/xray/rollback', { method: 'POST', body: { revision } }, 30_000),
  confirm: (revision) =>
    agentRequest('/xray/confirm', {
      method: 'POST',
      body: { revision },
    }),
};
