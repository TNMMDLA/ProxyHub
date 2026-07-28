import type { Prisma, PrismaClient } from '@prisma/client';
import {
  NETWORK_PERFORMANCE_HISTORY_LIMIT,
  type NetworkPerformanceResult,
} from '@proxyhub/network-performance-core';
import type { AgentClient } from '../agent-client.js';
import { AppError } from '../errors.js';
import { getBuildMetadata } from '../release/build-metadata.js';
import { redactSensitive } from '../security/redact.js';

interface AuditContext {
  actorId: string | null;
  actorName: string;
  ip: string;
}

const terminalStatuses = new Set(['COMPLETED', 'PARTIAL', 'FAILED', 'CANCELLED', 'INTERRUPTED']);

function safeJson(value: unknown): string {
  return JSON.stringify(redactSensitive(value));
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

export class NetworkPerformanceService {
  private active:
    | {
        databaseRunId: string;
        agentRunId: string;
      }
    | undefined;
  private readonly progress = new Map<string, unknown>();

  constructor(
    private readonly database: PrismaClient,
    private readonly agent: AgentClient,
    private readonly monitorTimeoutMs: number,
  ) {}

  async initialize(): Promise<void> {
    await this.database.networkPerformanceRun.updateMany({
      where: { status: { in: ['QUEUED', 'RUNNING'] } },
      data: {
        status: 'INTERRUPTED',
        completedAt: new Date(),
      },
    });
  }

  async capability(): Promise<{
    available: boolean;
    targetCount: number;
    busy: boolean;
    maxConcurrentRuns: 1;
    recentStatus: string | null;
    lastTestAt: Date | null;
  }> {
    const recent = await this.database.networkPerformanceRun.findFirst({
      orderBy: { startedAt: 'desc' },
      select: { status: true, startedAt: true },
    });
    const agentCapability = this.agent.networkPerformanceCapability
      ? await this.agent.networkPerformanceCapability().catch(() => null)
      : null;
    return {
      available: agentCapability?.available ?? false,
      targetCount: agentCapability?.targetCount ?? 0,
      busy: this.active !== undefined || (agentCapability?.busy ?? false),
      maxConcurrentRuns: 1,
      recentStatus: recent?.status ?? null,
      lastTestAt: recent?.startedAt ?? null,
    };
  }

  async start(
    nodeId: string,
    actor: AuditContext,
  ): Promise<Awaited<ReturnType<NetworkPerformanceService['get']>>> {
    if (this.active) {
      throw new AppError(
        'NETWORK_PERFORMANCE_TEST_BUSY',
        'Another network performance test is already running',
        409,
      );
    }
    if (!this.agent.startNetworkPerformance || !this.agent.getNetworkPerformance) {
      throw new AppError(
        'NETWORK_PERFORMANCE_INTERNAL_ERROR',
        'The connected Agent does not support network performance tests',
        503,
      );
    }
    const node = await this.database.node.findUnique({
      where: { id: nodeId },
      include: { server: { select: { name: true, region: true } } },
    });
    if (!node) {
      throw new AppError(
        'NETWORK_PERFORMANCE_NODE_NOT_FOUND',
        'The requested node was not found',
        404,
      );
    }
    if (!node.enabled) {
      throw new AppError(
        'NETWORK_PERFORMANCE_NODE_DISABLED',
        'Disabled nodes cannot be tested',
        422,
      );
    }
    if (
      node.protocol.toUpperCase() !== 'VLESS' ||
      node.transport.toUpperCase() !== 'TCP' ||
      node.flow !== 'xtls-rprx-vision'
    ) {
      throw new AppError(
        'NETWORK_PERFORMANCE_UNSUPPORTED_NODE',
        'Only VLESS TCP REALITY Vision nodes are supported',
        422,
      );
    }
    const metadata = await getBuildMetadata();
    const run = await this.database.networkPerformanceRun.create({
      data: {
        nodeId,
        status: 'QUEUED',
        proxyhubVersion: metadata.version,
        buildSha: metadata.gitSha,
      },
    });
    try {
      const agentRun = await this.agent.startNetworkPerformance({
        address: node.host,
        port: node.port,
        uuid: node.uuid,
        flow: 'xtls-rprx-vision',
        sni: node.sni,
        publicKey: node.realityPublicKey,
        shortId: node.shortId,
        fingerprint: node.fingerprint,
        enabled: node.enabled,
        protocol: node.protocol,
        transport: node.transport,
        security: 'REALITY',
        name: node.name,
        serverName: node.server.name,
        serverRegion: node.server.region,
        realityTarget: node.dest,
        proxyhubVersion: metadata.version,
        gitSha: metadata.gitShortSha,
        deployMode: metadata.deployMode,
      });
      await this.database.networkPerformanceRun.update({
        where: { id: run.id },
        data: { status: 'RUNNING' },
      });
      this.active = { databaseRunId: run.id, agentRunId: agentRun.id };
      this.progress.set(run.id, agentRun.progress);
      void this.monitor(run.id, agentRun.id, node.id, node.name, actor).catch(() => undefined);
      return this.get(nodeId, run.id);
    } catch (error) {
      await this.database.networkPerformanceRun.update({
        where: { id: run.id },
        data: {
          status: 'FAILED',
          completedAt: new Date(),
          summaryJson: safeJson({
            errorCode:
              error instanceof AppError ? error.code : 'NETWORK_PERFORMANCE_INTERNAL_ERROR',
          }),
        },
      });
      throw error;
    }
  }

  async get(nodeId: string, runId: string) {
    const run = await this.database.networkPerformanceRun.findFirst({
      where: { id: runId, nodeId },
      include: { targetResults: { orderBy: { targetId: 'asc' } } },
    });
    if (!run) {
      throw new AppError(
        'NETWORK_PERFORMANCE_RUN_NOT_FOUND',
        'Network performance run was not found',
        404,
      );
    }
    return {
      id: run.id,
      nodeId: run.nodeId,
      status: run.status,
      score: run.score,
      summary: parseJson(run.summaryJson),
      environment: parseJson(run.environmentJson),
      startedAt: run.startedAt,
      completedAt: run.completedAt,
      durationMs: run.durationMs,
      xrayVersion: run.xrayVersion,
      proxyhubVersion: run.proxyhubVersion,
      buildSha: run.buildSha,
      targetResults: run.targetResults.map((target) => ({
        id: target.id,
        targetId: target.targetId,
        targetLabel: target.targetLabel,
        success: target.success,
        errorCode: target.errorCode,
        directMbps: target.directMbps,
        tunnelMbps: target.tunnelMbps,
        efficiencyPercent: target.efficiencyPercent,
        latencyMedianMs: target.latencyMedianMs,
        latencyP95Ms: target.latencyP95Ms,
        jitterMs: target.jitterMs,
        successfulRequests: target.successfulRequests,
        failedRequests: target.failedRequests,
        directSamples: parseJson(target.directSamplesJson),
        tunnelSamples: parseJson(target.tunnelSamplesJson),
        uploadStatus: target.uploadStatus,
        analysisCodes: parseJson(target.analysisCodesJson),
      })),
      progress: this.progress.get(run.id) ?? null,
    };
  }

  async history(nodeId: string) {
    const node = await this.database.node.findUnique({
      where: { id: nodeId },
      select: { id: true },
    });
    if (!node) {
      throw new AppError(
        'NETWORK_PERFORMANCE_NODE_NOT_FOUND',
        'The requested node was not found',
        404,
      );
    }
    const runs = await this.database.networkPerformanceRun.findMany({
      where: { nodeId },
      orderBy: { startedAt: 'desc' },
      take: NETWORK_PERFORMANCE_HISTORY_LIMIT,
      select: {
        id: true,
        status: true,
        score: true,
        summaryJson: true,
        startedAt: true,
        completedAt: true,
        durationMs: true,
      },
    });
    return runs.map((run) => ({
      ...run,
      summary: parseJson(run.summaryJson),
      summaryJson: undefined,
    }));
  }

  async cancel(nodeId: string, runId: string): Promise<void> {
    const run = await this.database.networkPerformanceRun.findFirst({
      where: { id: runId, nodeId },
      select: { status: true },
    });
    if (!run) {
      throw new AppError(
        'NETWORK_PERFORMANCE_RUN_NOT_FOUND',
        'Network performance run was not found',
        404,
      );
    }
    if (terminalStatuses.has(run.status) || this.active?.databaseRunId !== runId) {
      throw new AppError(
        'NETWORK_PERFORMANCE_NOT_RUNNING',
        'Network performance run is not active',
        409,
      );
    }
    if (!this.agent.cancelNetworkPerformance) {
      throw new AppError(
        'NETWORK_PERFORMANCE_INTERNAL_ERROR',
        'The connected Agent cannot cancel network performance tests',
        503,
      );
    }
    await this.agent.cancelNetworkPerformance(this.active.agentRunId);
  }

  private async monitor(
    databaseRunId: string,
    agentRunId: string,
    nodeId: string,
    nodeName: string,
    actor: AuditContext,
  ): Promise<void> {
    const deadline = Date.now() + this.monitorTimeoutMs;
    try {
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 300));
        const snapshot = await this.agent.getNetworkPerformance!(agentRunId);
        this.progress.set(databaseRunId, snapshot.progress);
        if (!terminalStatuses.has(snapshot.status)) continue;
        if (snapshot.result) {
          await this.persistResult(databaseRunId, snapshot.result);
          await this.writeCompletionAudit(databaseRunId, nodeId, nodeName, actor, snapshot.result);
        } else {
          await this.persistFailure(databaseRunId, snapshot.status, snapshot.errorCode);
          await this.writeFailureRecords(
            databaseRunId,
            nodeId,
            nodeName,
            actor,
            snapshot.status,
            snapshot.errorCode,
          );
        }
        return;
      }
      await this.persistFailure(databaseRunId, 'FAILED', 'NETWORK_PERFORMANCE_TIMEOUT');
      await this.writeFailureRecords(
        databaseRunId,
        nodeId,
        nodeName,
        actor,
        'FAILED',
        'NETWORK_PERFORMANCE_TIMEOUT',
      );
    } catch (error) {
      await this.persistFailure(
        databaseRunId,
        'FAILED',
        error instanceof AppError ? error.code : 'NETWORK_PERFORMANCE_INTERNAL_ERROR',
      );
      await this.writeFailureRecords(
        databaseRunId,
        nodeId,
        nodeName,
        actor,
        'FAILED',
        error instanceof AppError ? error.code : 'NETWORK_PERFORMANCE_INTERNAL_ERROR',
      );
    } finally {
      if (this.active?.databaseRunId === databaseRunId) this.active = undefined;
    }
  }

  private async persistResult(runId: string, result: NetworkPerformanceResult): Promise<void> {
    await this.database.$transaction(async (transaction) => {
      await transaction.networkPerformanceRun.update({
        where: { id: runId },
        data: {
          status: result.status,
          score: result.score.overall,
          summaryJson: safeJson({
            score: result.score,
            tunnelEstablishmentMs: result.tunnelEstablishmentMs,
            medianDirectMbps: result.medianDirectMbps,
            medianTunnelMbps: result.medianTunnelMbps,
            successRatePercent: result.successRatePercent,
            analysisCodes: result.analysisCodes,
          }),
          environmentJson: safeJson(result.environment),
          completedAt: new Date(),
          durationMs: result.durationMs,
          xrayVersion: result.environment.xrayVersion,
          targetResults: {
            create: result.targets.map((target) => ({
              targetId: target.targetId,
              targetLabel: target.targetLabel,
              success: target.success,
              errorCode: target.errorCode ?? null,
              directMbps: target.direct.downloadMbps,
              tunnelMbps: target.tunnel.downloadMbps,
              efficiencyPercent: target.efficiencyPercent,
              latencyMedianMs: target.tunnel.latencyMedianMs,
              latencyP95Ms: target.tunnel.latencyP95Ms,
              jitterMs: target.tunnel.jitterMs,
              successfulRequests: target.tunnel.successfulRequests,
              failedRequests: target.tunnel.failedRequests,
              directSamplesJson: safeJson(target.direct.downloadSamplesMbps),
              tunnelSamplesJson: safeJson(target.tunnel.downloadSamplesMbps),
              uploadStatus: target.uploadStatus,
              analysisCodesJson: safeJson(target.analysisCodes),
            })),
          },
        },
      });
      await this.pruneHistory(transaction, runId);
    });
  }

  private async persistFailure(
    runId: string,
    status: string,
    code = 'NETWORK_PERFORMANCE_INTERNAL_ERROR',
  ): Promise<void> {
    await this.database.$transaction(async (transaction) => {
      await transaction.networkPerformanceRun.update({
        where: { id: runId },
        data: {
          status,
          completedAt: new Date(),
          summaryJson: safeJson({ errorCode: code }),
        },
      });
      await this.pruneHistory(transaction, runId);
    });
  }

  private async pruneHistory(transaction: Prisma.TransactionClient, runId: string): Promise<void> {
    const current = await transaction.networkPerformanceRun.findUniqueOrThrow({
      where: { id: runId },
      select: { nodeId: true },
    });
    const expired = await transaction.networkPerformanceRun.findMany({
      where: { nodeId: current.nodeId },
      orderBy: { startedAt: 'desc' },
      skip: NETWORK_PERFORMANCE_HISTORY_LIMIT,
      select: { id: true },
    });
    if (expired.length > 0) {
      await transaction.networkPerformanceRun.deleteMany({
        where: { id: { in: expired.map(({ id }) => id) } },
      });
    }
  }

  private async writeCompletionAudit(
    runId: string,
    nodeId: string,
    nodeName: string,
    actor: AuditContext,
    result: NetworkPerformanceResult,
  ): Promise<void> {
    await this.database.auditLog.create({
      data: {
        actorId: actor.actorId,
        actorName: actor.actorName,
        action: 'NETWORK_PERFORMANCE_TEST_COMPLETED',
        resource: 'Node',
        resourceId: nodeId,
        ip: actor.ip,
        result: 'SUCCESS',
        metadata: safeJson({
          nodeName,
          runId,
          status: result.status,
          durationMs: result.durationMs,
          score: result.score.overall,
          targetCount: result.targets.length,
        }),
      },
    });
  }

  private async writeFailureRecords(
    runId: string,
    nodeId: string,
    nodeName: string,
    actor: AuditContext,
    status: string,
    code = 'NETWORK_PERFORMANCE_INTERNAL_ERROR',
  ): Promise<void> {
    const cancelled = status === 'CANCELLED';
    const infrastructureFailure = [
      'NETWORK_PERFORMANCE_INTERNAL_ERROR',
      'NETWORK_PERFORMANCE_CLEANUP_FAILED',
    ].includes(code);
    await this.database.$transaction(async (transaction) => {
      await transaction.auditLog.create({
        data: {
          actorId: actor.actorId,
          actorName: actor.actorName,
          action: cancelled
            ? 'NETWORK_PERFORMANCE_TEST_CANCELLED'
            : 'NETWORK_PERFORMANCE_TEST_FAILED',
          resource: 'Node',
          resourceId: nodeId,
          ip: actor.ip,
          result: cancelled ? 'SUCCESS' : 'FAILURE',
          metadata: safeJson({ nodeName, runId, status, errorCode: code }),
        },
      });
      if (infrastructureFailure) {
        await transaction.notification.create({
          data: {
            level: code === 'NETWORK_PERFORMANCE_CLEANUP_FAILED' ? 'CRITICAL' : 'WARNING',
            title: 'Network performance runner failed',
            message: 'The internal performance runner could not finish safely.',
            eventType: code,
          },
        });
      }
    });
  }
}

export function auditContext(request: {
  admin?: { id: string; username: string };
  ip: string;
}): AuditContext {
  return {
    actorId: request.admin?.id ?? null,
    actorName: request.admin?.username ?? 'anonymous',
    ip: request.ip,
  };
}
