import { hostname, loadavg, totalmem, freemem, uptime } from 'node:os';
import type { FastifyPluginAsync } from 'fastify';
import { requireRole } from '../auth/session.js';
import { prisma } from '../db.js';
import { audit } from '../audit.js';
import type { AgentClient } from '../agent-client.js';

export const operationRoutes: FastifyPluginAsync<{ agentClient: AgentClient }> = async (
  app,
  options,
) => {
  app.get('/dashboard', { preHandler: requireRole('ADMIN', 'OPERATOR', 'VIEWER') }, async () => {
    const [servers, nodes, pools, unread, activity, securityEvents, agentStatus] =
      await Promise.all([
        prisma.server.findMany({ orderBy: { createdAt: 'asc' } }),
        prisma.node.findMany(),
        prisma.nodePool.findMany(),
        prisma.notification.count({ where: { readAt: null } }),
        prisma.auditLog.findMany({ take: 6, orderBy: { createdAt: 'desc' } }),
        prisma.securityEvent.count({
          where: { createdAt: { gte: new Date(Date.now() - 7 * 86_400_000) } },
        }),
        options.agentClient.status().catch(() => null),
      ]);
    const total = totalmem();
    const memoryUsage = Math.round(((total - freemem()) / total) * 100);
    const onlineServers = servers.filter((server) => server.status === 'ONLINE').length;
    const healthyNodes = nodes.filter((node) => node.status === 'HEALTHY').length;
    const securityScore = Math.max(40, 100 - securityEvents * 3);
    return {
      success: true,
      data: {
        metrics: {
          serversOnline: onlineServers,
          serversTotal: servers.length,
          healthyNodes,
          nodesTotal: nodes.length,
          activePools: pools.filter((pool) => pool.enabled).length,
          poolsTotal: pools.length,
          securityScore,
          unreadNotifications: unread,
        },
        system: {
          hostname: hostname(),
          uptime: uptime(),
          memoryUsage,
          load: loadavg()[0] ?? 0,
          version: '0.2.1',
          xrayStatus: agentStatus?.xray.status ?? 'UNKNOWN',
        },
        servers,
        activity,
        trafficMode: 'DEMO',
        traffic: Array.from({ length: 13 }, (_, index) => ({
          time: `${String(index * 2).padStart(2, '0')}:00`,
          inbound: 18 + ((index * 13) % 28),
          outbound: 10 + ((index * 9) % 20),
        })),
      },
    };
  });

  app.get('/servers', { preHandler: requireRole('ADMIN', 'OPERATOR', 'VIEWER') }, async () => ({
    success: true,
    data: await prisma.server.findMany({ include: { _count: { select: { nodes: true } } } }),
  }));

  app.get('/xray/status', { preHandler: requireRole('ADMIN', 'OPERATOR', 'VIEWER') }, async () => ({
    success: true,
    data: await options.agentClient.status(),
  }));
  app.post('/xray/restart', { preHandler: requireRole('ADMIN', 'OPERATOR') }, async (request) => {
    const response = await options.agentClient.restart();
    await Promise.all([
      audit(request, 'XRAY_RESTART', 'Xray', 'SUCCESS'),
      prisma.notification.create({
        data: {
          level: 'SUCCESS',
          title: 'Xray restarted',
          message: 'The local Xray service restarted successfully.',
          eventType: 'XRAY_RESTARTED',
        },
      }),
    ]);
    return { success: true, data: response };
  });

  app.get(
    '/notifications',
    { preHandler: requireRole('ADMIN', 'OPERATOR', 'VIEWER') },
    async () => ({
      success: true,
      data: await prisma.notification.findMany({ take: 100, orderBy: { createdAt: 'desc' } }),
    }),
  );
  app.patch(
    '/notifications/:id/read',
    { preHandler: requireRole('ADMIN', 'OPERATOR', 'VIEWER') },
    async (request) => ({
      success: true,
      data: await prisma.notification.update({
        where: { id: (request.params as { id: string }).id },
        data: { readAt: new Date() },
      }),
    }),
  );
  app.post(
    '/notifications/read-all',
    { preHandler: requireRole('ADMIN', 'OPERATOR', 'VIEWER') },
    async () => {
      await prisma.notification.updateMany({
        where: { readAt: null },
        data: { readAt: new Date() },
      });
      return { success: true, data: null };
    },
  );
  app.get('/audit-logs', { preHandler: requireRole('ADMIN', 'VIEWER') }, async () => ({
    success: true,
    data: await prisma.auditLog.findMany({ take: 200, orderBy: { createdAt: 'desc' } }),
  }));
};
