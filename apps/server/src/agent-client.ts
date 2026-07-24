import type {
  AgentStatusData,
  RealityTargetCompatibilityResult,
  XrayHealthStatus,
} from '@proxyhub/shared';
import { config } from './config.js';
import { AppError } from './errors.js';

interface AgentEnvelope<T> {
  success: boolean;
  data?: T;
  error?: { code?: string; message?: string };
}

export interface AgentApplyResult {
  applied: true;
  restarted: true;
  revision: string;
  health: XrayHealthStatus;
}

export interface AgentClient {
  status(): Promise<AgentStatusData>;
  testRealityTarget(
    input: {
      serverName: string;
      target: string;
    },
    signal?: AbortSignal,
  ): Promise<RealityTargetCompatibilityResult>;
  applyConfig(config: Record<string, unknown>): Promise<AgentApplyResult>;
  restart(): Promise<{ restarted: true; health: XrayHealthStatus }>;
  rollback(revision: string): Promise<{ rolledBack: true; health: XrayHealthStatus }>;
  confirm(revision: string): Promise<{ confirmed: true }>;
}

async function agentRequest<T>(
  path: string,
  init: RequestInit = {},
  timeoutMs = 5_000,
): Promise<T> {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  try {
    const signal = init.signal ? AbortSignal.any([init.signal, timeoutSignal]) : timeoutSignal;
    const response = await fetch(new URL(path, config.AGENT_URL), {
      ...init,
      headers: {
        'content-type': 'application/json',
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
      ].includes(code)
        ? 422
        : code === 'REALITY_TARGET_TEST_BUSY'
          ? 409
          : code === 'REALITY_TARGET_TEST_TIMEOUT'
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
  testRealityTarget: (input, signal) =>
    agentRequest<RealityTargetCompatibilityResult>(
      '/xray/reality-compatibility',
      { method: 'POST', body: JSON.stringify(input), ...(signal ? { signal } : {}) },
      30_000,
    ),
  applyConfig: (xrayConfig) =>
    agentRequest<AgentApplyResult>(
      '/xray/apply',
      { method: 'POST', body: JSON.stringify({ config: xrayConfig }) },
      30_000,
    ),
  restart: () => agentRequest('/xray/restart', { method: 'POST' }, 30_000),
  rollback: (revision) =>
    agentRequest('/xray/rollback', { method: 'POST', body: JSON.stringify({ revision }) }, 30_000),
  confirm: (revision) =>
    agentRequest('/xray/confirm', {
      method: 'POST',
      body: JSON.stringify({ revision }),
    }),
};
