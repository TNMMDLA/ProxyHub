import type { Prisma } from '@prisma/client';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import QRCode from 'qrcode';
import { createNodeSchema, updateNodeSchema } from '@proxyhub/shared';
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

  app.post('/', { preHandler: requireRole('ADMIN', 'OPERATOR') }, async (request, reply) => {
    const input = createNodeSchema.parse(request.body);
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
