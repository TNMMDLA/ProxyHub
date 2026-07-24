import type { Prisma } from '@prisma/client';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import QRCode from 'qrcode';
import {
  createNodeSchema,
  realityTargetCompatibilityRequestSchema,
  updateNodeSchema,
  type RealityTargetCompatibilityResult,
} from '@proxyhub/shared';
import {
  buildRealityInbound,
  buildXrayConfig,
  createVlessUri,
  generateRealityCredentials,
} from '@proxyhub/xray-manager';
import type { AgentClient } from '../agent-client.js';
import { audit } from '../audit.js';
import { requireRole } from '../auth/session.js';
import { prisma } from '../db.js';
import { AppError } from '../errors.js';
import { decryptSecret, encryptSecret } from '../security/crypto.js';

const nodeSelect = {
  id: true,
  serverId: true,
  name: true,
  protocol: true,
  transport: true,
  host: true,
  port: true,
  uuid: true,
  flow: true,
  realityPublicKey: true,
  shortId: true,
  sni: true,
  dest: true,
  fingerprint: true,
  status: true,
  enabled: true,
  lastCheckAt: true,
  latency: true,
  exitIp: true,
  asn: true,
  country: true,
  region: true,
  createdAt: true,
  updatedAt: true,
  server: { select: { name: true, status: true } },
  pools: { include: { nodePool: true } },
} as const;

interface LifecycleRecord {
  id: string;
  name: string;
}

let nodeLifecycleQueue = Promise.resolve();

async function testRealityTarget(
  request: FastifyRequest,
  agentClient: AgentClient,
  input: { serverName: string; target: string },
  purpose: 'MANUAL' | 'NODE_CREATE' | 'NODE_UPDATE' | 'NODE_CLONE',
): Promise<RealityTargetCompatibilityResult> {
  const metadata = { serverName: input.serverName, target: input.target, purpose };
  await audit(
    request,
    'REALITY_TARGET_COMPATIBILITY_TEST_STARTED',
    'RealityTarget',
    'SUCCESS',
    undefined,
    metadata,
  );
  try {
    const controller = new AbortController();
    const cancel = () => controller.abort();
    request.raw.once('aborted', cancel);
    const compatibility = await agentClient
      .testRealityTarget(input, controller.signal)
      .finally(() => request.raw.off('aborted', cancel));
    await audit(
      request,
      compatibility.status === 'COMPATIBLE'
        ? 'REALITY_TARGET_COMPATIBILITY_TEST_PASSED'
        : 'REALITY_TARGET_COMPATIBILITY_TEST_FAILED',
      'RealityTarget',
      compatibility.status === 'COMPATIBLE' ? 'SUCCESS' : 'FAILURE',
      undefined,
      {
        ...metadata,
        result: compatibility.status,
        xrayVersion: compatibility.xrayVersion,
        durationMs: compatibility.durationMs,
        tlsPrecheck: compatibility.tlsPrecheck.status,
        realityHandshake: compatibility.realityHandshake.status,
        endToEndTraffic: compatibility.endToEndTraffic.status,
      },
    );
    return compatibility;
  } catch (error) {
    const code = error instanceof AppError ? error.code : 'REALITY_TARGET_TEST_INTERNAL_ERROR';
    const expectedRejection = [
      'REALITY_TARGET_INVALID',
      'REALITY_TARGET_DNS_FAILED',
      'REALITY_TARGET_BLOCKED_ADDRESS',
      'REALITY_TARGET_TEST_BUSY',
      'REALITY_TARGET_TEST_CANCELLED',
    ].includes(code);
    const records: Promise<unknown>[] = [
      audit(
        request,
        'REALITY_TARGET_COMPATIBILITY_TEST_FAILED',
        'RealityTarget',
        'FAILURE',
        undefined,
        { ...metadata, errorType: code },
      ),
    ];
    if (!expectedRejection) {
      records.push(
        prisma.notification.create({
          data: {
            level: 'CRITICAL',
            title: 'Reality compatibility test failed',
            message: `The ${purpose.toLowerCase().replaceAll('_', ' ')} preflight could not complete safely.`,
            eventType: 'REALITY_TARGET_TEST_ERROR',
          },
        }),
      );
    }
    await Promise.allSettled(records);
    throw error;
  }
}

async function requireCompatibleRealityTarget(
  request: FastifyRequest,
  agentClient: AgentClient,
  input: { serverName: string; target: string },
  purpose: 'NODE_CREATE' | 'NODE_UPDATE' | 'NODE_CLONE',
): Promise<void> {
  const compatibility = await testRealityTarget(request, agentClient, input, purpose);
  if (compatibility.status === 'COMPATIBLE') return;
  await Promise.allSettled([
    audit(request, purpose, 'Node', 'FAILURE', undefined, {
      errorType: 'REALITY_TARGET_INCOMPATIBLE',
      serverName: compatibility.serverName,
      target: compatibility.target,
      xrayVersion: compatibility.xrayVersion,
      failureStage:
        compatibility.tlsPrecheck.status === 'FAILED'
          ? 'TLS_PRECHECK'
          : compatibility.realityHandshake.status === 'FAILED'
            ? 'REALITY_HANDSHAKE'
            : 'END_TO_END_TRAFFIC',
    }),
    prisma.notification.create({
      data: {
        level: 'WARNING',
        title: 'Reality target is incompatible',
        message: `${compatibility.serverName} / ${compatibility.target} did not pass the live Reality preflight. No node changes were applied.`,
        eventType: 'REALITY_TARGET_INCOMPATIBLE',
      },
    }),
  ]);
  throw new AppError(
    'REALITY_TARGET_INCOMPATIBLE',
    'The Reality target did not pass the live compatibility preflight',
    422,
    compatibility,
  );
}

async function enabledXrayConfig(transaction: Prisma.TransactionClient) {
  const nodes = await transaction.node.findMany({
    where: { enabled: true },
    orderBy: [{ serverId: 'asc' }, { port: 'asc' }],
  });
  return buildXrayConfig(
    nodes.map((node) => ({
      name: node.name,
      port: node.port,
      uuid: node.uuid,
      privateKey: decryptSecret(node.realityPrivateKeyEncrypted),
      shortId: node.shortId,
      sni: node.sni,
      dest: node.dest,
      fingerprint: node.fingerprint,
    })),
  );
}

interface NodeMutationOptions<T extends LifecycleRecord> {
  request: FastifyRequest;
  agentClient: AgentClient;
  action: string;
  eventType: string;
  mutate: (transaction: Prisma.TransactionClient) => Promise<T>;
  metadata?: (record: T) => unknown;
}

async function executeNodeMutation<T extends LifecycleRecord>(
  options: NodeMutationOptions<T>,
): Promise<T> {
  let revision: string | undefined;
  let affectedRecord: T | undefined;
  try {
    const result = await prisma.$transaction(
      async (transaction) => {
        const record = await options.mutate(transaction);
        affectedRecord = record;
        const config = await enabledXrayConfig(transaction);
        const applied = await options.agentClient.applyConfig(config);
        revision = applied.revision;
        await Promise.all([
          audit(
            options.request,
            options.action,
            'Node',
            'SUCCESS',
            record.id,
            options.metadata?.(record) ?? { name: record.name },
            transaction,
          ),
          transaction.notification.create({
            data: {
              level: 'SUCCESS',
              title: 'Xray configuration applied',
              message: `${record.name} was synchronized and Xray is healthy.`,
              eventType: options.eventType,
            },
          }),
        ]);
        return record;
      },
      { maxWait: 5_000, timeout: 40_000 },
    );

    if (revision) {
      await options.agentClient.confirm(revision).catch(async () => {
        await prisma.notification.create({
          data: {
            level: 'WARNING',
            title: 'Xray rollback backup retained',
            message: 'The configuration is active, but its rollback backup could not be cleared.',
          },
        });
      });
    }
    return result;
  } catch (error) {
    let rollbackFailed = error instanceof AppError && error.code === 'XRAY_ROLLBACK_FAILED';
    if (revision) {
      try {
        await options.agentClient.rollback(revision);
      } catch {
        rollbackFailed = true;
      }
    }
    const resourceId = affectedRecord?.id;
    const failureMessage = rollbackFailed
      ? 'The node transaction failed and automatic Xray rollback also failed. Manual intervention is required.'
      : 'The node transaction was rejected and the previous Xray configuration was preserved.';
    await Promise.allSettled([
      audit(options.request, options.action, 'Node', 'FAILURE', resourceId, {
        errorType: error instanceof AppError ? error.code : 'XRAY_CONFIG_SYNC_FAILED',
        rollbackFailed,
      }),
      prisma.notification.create({
        data: {
          level: 'CRITICAL',
          title: 'Node configuration synchronization failed',
          message: failureMessage,
          eventType: 'XRAY_CONFIG_APPLY_FAILED',
        },
      }),
    ]);
    if (error instanceof AppError) throw error;
    throw new AppError(
      'XRAY_CONFIG_SYNC_FAILED',
      'The node change could not be synchronized with Xray',
      503,
    );
  }
}

function synchronizeNodeMutation<T extends LifecycleRecord>(
  options: NodeMutationOptions<T>,
): Promise<T> {
  const operation = nodeLifecycleQueue.then(
    () => executeNodeMutation(options),
    () => executeNodeMutation(options),
  );
  nodeLifecycleQueue = operation.then(
    () => undefined,
    () => undefined,
  );
  return operation;
}

export const nodeRoutes: FastifyPluginAsync<{ agentClient: AgentClient }> = async (
  app,
  options,
) => {
  app.get('/', { preHandler: requireRole('ADMIN', 'OPERATOR', 'VIEWER') }, async () => ({
    success: true,
    data: await prisma.node.findMany({ select: nodeSelect, orderBy: { createdAt: 'desc' } }),
  }));

  app.post(
    '/reality-compatibility',
    { preHandler: requireRole('ADMIN', 'OPERATOR') },
    async (request) => {
      const input = realityTargetCompatibilityRequestSchema.parse(request.body);
      const compatibility = await testRealityTarget(request, options.agentClient, input, 'MANUAL');
      return { success: true, data: compatibility };
    },
  );

  app.post('/', { preHandler: requireRole('ADMIN', 'OPERATOR') }, async (request, reply) => {
    const input = createNodeSchema.parse(request.body);
    await requireCompatibleRealityTarget(
      request,
      options.agentClient,
      { serverName: input.sni, target: input.dest },
      'NODE_CREATE',
    );
    const credentials = generateRealityCredentials();
    buildRealityInbound({
      name: input.name,
      port: input.port,
      uuid: credentials.uuid,
      privateKey: credentials.privateKey,
      shortId: credentials.shortId,
      sni: input.sni,
      dest: input.dest,
      fingerprint: input.fingerprint,
    });
    const node = await synchronizeNodeMutation({
      request,
      agentClient: options.agentClient,
      action: 'NODE_CREATE',
      eventType: 'NODE_CREATED',
      mutate: (transaction) =>
        transaction.node.create({
          data: {
            ...input,
            uuid: credentials.uuid,
            flow: credentials.flow,
            realityPublicKey: credentials.publicKey,
            realityPrivateKeyEncrypted: encryptSecret(credentials.privateKey),
            shortId: credentials.shortId,
            status: 'UNKNOWN',
          },
          select: nodeSelect,
        }),
      metadata: (record) => ({ name: record.name, port: record.port }),
    });
    return reply.code(201).send({ success: true, data: node });
  });

  app.get(
    '/:id/share',
    { preHandler: requireRole('ADMIN', 'OPERATOR', 'VIEWER') },
    async (request) => {
      const id = (request.params as { id: string }).id;
      const node = await prisma.node.findUnique({ where: { id } });
      if (!node) throw new AppError('NODE_NOT_FOUND', 'Node not found', 404);
      const uri = createVlessUri(node);
      return { success: true, data: { uri, qrCode: await QRCode.toDataURL(uri) } };
    },
  );

  app.patch('/:id', { preHandler: requireRole('ADMIN', 'OPERATOR') }, async (request) => {
    const id = (request.params as { id: string }).id;
    const input = updateNodeSchema.parse(request.body);
    if (input.sni !== undefined || input.dest !== undefined) {
      const current = await prisma.node.findUnique({ where: { id } });
      if (!current) throw new AppError('NODE_NOT_FOUND', 'Node not found', 404);
      const serverName = input.sni ?? current.sni;
      const target = input.dest ?? current.dest;
      if (serverName !== current.sni || target !== current.dest) {
        await requireCompatibleRealityTarget(
          request,
          options.agentClient,
          { serverName, target },
          'NODE_UPDATE',
        );
      }
    }
    const node = await synchronizeNodeMutation({
      request,
      agentClient: options.agentClient,
      action:
        input.enabled === undefined
          ? 'NODE_UPDATE'
          : input.enabled
            ? 'NODE_ENABLE'
            : 'NODE_DISABLE',
      eventType: 'NODE_UPDATED',
      mutate: async (transaction) => {
        const current = await transaction.node.findUnique({ where: { id } });
        if (!current) throw new AppError('NODE_NOT_FOUND', 'Node not found', 404);
        buildRealityInbound({
          name: input.name ?? current.name,
          port: input.port ?? current.port,
          uuid: current.uuid,
          privateKey: decryptSecret(current.realityPrivateKeyEncrypted),
          shortId: current.shortId,
          sni: input.sni ?? current.sni,
          dest: input.dest ?? current.dest,
          fingerprint: input.fingerprint ?? current.fingerprint,
        });
        const data = {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.host !== undefined ? { host: input.host } : {}),
          ...(input.port !== undefined ? { port: input.port } : {}),
          ...(input.sni !== undefined ? { sni: input.sni } : {}),
          ...(input.dest !== undefined ? { dest: input.dest } : {}),
          ...(input.fingerprint !== undefined ? { fingerprint: input.fingerprint } : {}),
          ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
        };
        return transaction.node.update({ where: { id }, data, select: nodeSelect });
      },
      metadata: () => input,
    });
    return { success: true, data: node };
  });

  app.post(
    '/:id/clone',
    { preHandler: requireRole('ADMIN', 'OPERATOR') },
    async (request, reply) => {
      const id = (request.params as { id: string }).id;
      const source = await prisma.node.findUnique({ where: { id } });
      if (!source) throw new AppError('NODE_NOT_FOUND', 'Node not found', 404);
      await requireCompatibleRealityTarget(
        request,
        options.agentClient,
        { serverName: source.sni, target: source.dest },
        'NODE_CLONE',
      );
      const credentials = generateRealityCredentials();
      const node = await synchronizeNodeMutation({
        request,
        agentClient: options.agentClient,
        action: 'NODE_CLONE',
        eventType: 'NODE_CREATED',
        mutate: async (transaction) => {
          const source = await transaction.node.findUnique({ where: { id } });
          if (!source) throw new AppError('NODE_NOT_FOUND', 'Node not found', 404);
          if (source.port === 65_535)
            throw new AppError('NO_CLONE_PORT', 'The source node uses the highest valid port', 409);
          buildRealityInbound({
            name: `${source.name} Copy`,
            port: source.port + 1,
            uuid: credentials.uuid,
            privateKey: credentials.privateKey,
            shortId: credentials.shortId,
            sni: source.sni,
            dest: source.dest,
            fingerprint: source.fingerprint,
          });
          return transaction.node.create({
            data: {
              serverId: source.serverId,
              name: `${source.name} Copy`,
              host: source.host,
              port: source.port + 1,
              uuid: credentials.uuid,
              flow: credentials.flow,
              realityPublicKey: credentials.publicKey,
              realityPrivateKeyEncrypted: encryptSecret(credentials.privateKey),
              shortId: credentials.shortId,
              sni: source.sni,
              dest: source.dest,
              fingerprint: source.fingerprint,
            },
            select: nodeSelect,
          });
        },
        metadata: (record) => ({ sourceId: id, cloneId: record.id }),
      });
      return reply.code(201).send({ success: true, data: node });
    },
  );

  app.delete('/:id', { preHandler: requireRole('ADMIN', 'OPERATOR') }, async (request) => {
    const id = (request.params as { id: string }).id;
    await synchronizeNodeMutation({
      request,
      agentClient: options.agentClient,
      action: 'NODE_DELETE',
      eventType: 'NODE_UPDATED',
      mutate: async (transaction) => {
        const current = await transaction.node.findUnique({ where: { id } });
        if (!current) throw new AppError('NODE_NOT_FOUND', 'Node not found', 404);
        await transaction.node.delete({ where: { id } });
        return { id: current.id, name: current.name };
      },
    });
    return { success: true, data: null };
  });
};
