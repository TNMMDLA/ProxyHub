import type { AgentStatusData, XrayHealthStatus } from '@proxyhub/shared';
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
  try {
    const response = await fetch(new URL(path, config.AGENT_URL), {
      ...init,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${config.AGENT_TOKEN}`,
        ...init.headers,
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = (await response.json()) as AgentEnvelope<T>;
    if (!response.ok || !body.success || body.data === undefined) {
      throw new AppError(
        body.error?.code ?? 'AGENT_OPERATION_FAILED',
        body.error?.message ?? `Agent returned ${String(response.status)}`,
        503,
      );
    }
    return body.data;
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError('AGENT_UNAVAILABLE', `Agent unavailable: ${(error as Error).message}`, 503);
  }
}

export const defaultAgentClient: AgentClient = {
  status: () => agentRequest<AgentStatusData>('/status'),
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
