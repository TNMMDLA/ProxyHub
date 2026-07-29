import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit.js';
import { requireRole } from '../auth/session.js';
import { prisma } from '../db.js';
import { AppError } from '../errors.js';
import type { UserService } from '../users/service.js';

const idParams = z.object({ id: z.string().min(1) });
const accessParams = z.object({ id: z.string().min(1), accessId: z.string().min(1) });
const byteLimit = z
  .union([z.string().regex(/^[1-9]\d*$/u), z.null()])
  .transform((value) => (value === null ? null : BigInt(value)));
const expiration = z
  .union([z.string().datetime(), z.null()])
  .transform((value) => (value === null ? null : new Date(value)));
const createUserSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    remark: z.string().trim().max(500).default(''),
    groupId: z.string().min(1).nullable().default(null),
    adminEnabled: z.boolean().default(true),
    expiresAt: expiration.default(null),
    trafficLimitBytes: byteLimit.default(null),
    resetPolicy: z.enum(['NEVER', 'MONTHLY']).default('NEVER'),
    resetDay: z.number().int().min(1).max(28).nullable().default(null),
    nodeIds: z.array(z.string().min(1)).max(100).default([]),
  })
  .strict();
const updateUserSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    remark: z.string().trim().max(500).optional(),
    groupId: z.string().min(1).nullable().optional(),
    adminEnabled: z.boolean().optional(),
    expiresAt: expiration.optional(),
    trafficLimitBytes: byteLimit.optional(),
    resetPolicy: z.enum(['NEVER', 'MONTHLY']).optional(),
    resetDay: z.number().int().min(1).max(28).nullable().optional(),
  })
  .strict();

export const userRoutes: FastifyPluginAsync<{ service: UserService }> = async (app, options) => {
  app.get('/', { preHandler: requireRole('ADMIN', 'OPERATOR', 'VIEWER') }, async (request) => {
    const query = z
      .object({
        page: z.coerce.number().int().min(1).default(1),
        limit: z.coerce.number().int().min(1).max(100).default(25),
        search: z.string().trim().max(120).optional(),
        status: z.enum(['ACTIVE', 'DISABLED', 'EXPIRED', 'TRAFFIC_EXHAUSTED']).optional(),
        groupId: z.string().min(1).optional(),
      })
      .parse(request.query);
    return { success: true, data: await options.service.list(query) };
  });

  app.post('/', { preHandler: requireRole('ADMIN', 'OPERATOR') }, async (request, reply) =>
    reply.code(201).send({
      success: true,
      data: await options.service.create(request, createUserSchema.parse(request.body)),
    }),
  );

  app.get('/:id', { preHandler: requireRole('ADMIN', 'OPERATOR', 'VIEWER') }, async (request) => {
    const { id } = idParams.parse(request.params);
    return { success: true, data: await options.service.detail(id) };
  });

  app.patch('/:id', { preHandler: requireRole('ADMIN', 'OPERATOR') }, async (request) => {
    const { id } = idParams.parse(request.params);
    return {
      success: true,
      data: await options.service.update(request, id, updateUserSchema.parse(request.body)),
    };
  });

  app.delete('/:id', { preHandler: requireRole('ADMIN') }, async (request) => {
    const { id } = idParams.parse(request.params);
    return { success: true, data: await options.service.delete(request, id) };
  });

  for (const [path, enabled] of [
    ['enable', true],
    ['disable', false],
  ] as const) {
    app.post(`/:id/${path}`, { preHandler: requireRole('ADMIN', 'OPERATOR') }, async (request) => {
      const { id } = idParams.parse(request.params);
      return { success: true, data: await options.service.setEnabled(request, id, enabled) };
    });
  }

  app.post('/:id/credential/rotate', { preHandler: requireRole('ADMIN') }, async (request) => {
    const { id } = idParams.parse(request.params);
    return { success: true, data: await options.service.rotateCredential(request, id) };
  });

  app.post(
    '/:id/traffic/reset',
    { preHandler: requireRole('ADMIN', 'OPERATOR') },
    async (request) => {
      const { id } = idParams.parse(request.params);
      return { success: true, data: await options.service.resetTraffic(request, id) };
    },
  );

  app.get(
    '/:id/traffic',
    { preHandler: requireRole('ADMIN', 'OPERATOR', 'VIEWER') },
    async (request) => {
      const { id } = idParams.parse(request.params);
      const user = await options.service.detail(id);
      return { success: true, data: { traffic: user.traffic, accesses: user.accesses } };
    },
  );

  app.get(
    '/:id/access',
    { preHandler: requireRole('ADMIN', 'OPERATOR', 'VIEWER') },
    async (request) => {
      const { id } = idParams.parse(request.params);
      return { success: true, data: (await options.service.detail(id)).accesses };
    },
  );

  app.post('/:id/access', { preHandler: requireRole('ADMIN', 'OPERATOR') }, async (request) => {
    const { id } = idParams.parse(request.params);
    const { nodeIds } = z
      .object({ nodeIds: z.array(z.string().min(1)).min(1).max(100) })
      .strict()
      .parse(request.body);
    return { success: true, data: await options.service.grantAccess(request, id, nodeIds) };
  });

  app.delete(
    '/:id/access/:accessId',
    { preHandler: requireRole('ADMIN', 'OPERATOR') },
    async (request) => {
      const { id, accessId } = accessParams.parse(request.params);
      return {
        success: true,
        data: await options.service.updateAccess(request, id, accessId, 'REVOKE'),
      };
    },
  );

  for (const [path, operation] of [
    ['enable', 'ENABLE'],
    ['disable', 'DISABLE'],
  ] as const) {
    app.post(
      `/:id/access/:accessId/${path}`,
      { preHandler: requireRole('ADMIN', 'OPERATOR') },
      async (request) => {
        const { id, accessId } = accessParams.parse(request.params);
        return {
          success: true,
          data: await options.service.updateAccess(request, id, accessId, operation),
        };
      },
    );
  }

  app.post(
    '/:id/access/:accessId/share-link',
    { preHandler: requireRole('ADMIN') },
    async (request, reply) => {
      const { id, accessId } = accessParams.parse(request.params);
      reply.header('cache-control', 'no-store');
      return {
        success: true,
        data: await options.service.shareLink(request, id, accessId),
      };
    },
  );
};

const groupSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    description: z.string().trim().max(500).default(''),
  })
  .strict();

export const userGroupRoutes: FastifyPluginAsync = async (app) => {
  app.get('/', { preHandler: requireRole('ADMIN', 'OPERATOR', 'VIEWER') }, async () => ({
    success: true,
    data: await prisma.userGroup.findMany({
      include: { _count: { select: { users: { where: { deletedAt: null } } } } },
      orderBy: { name: 'asc' },
    }),
  }));

  app.post('/', { preHandler: requireRole('ADMIN', 'OPERATOR') }, async (request, reply) => {
    const input = groupSchema.parse(request.body);
    const group = await prisma.userGroup.create({ data: input });
    await audit(request, 'USER_GROUP_CREATED', 'UserGroup', 'SUCCESS', group.id, {
      name: group.name,
    });
    return reply.code(201).send({ success: true, data: group });
  });

  app.patch('/:id', { preHandler: requireRole('ADMIN', 'OPERATOR') }, async (request) => {
    const { id } = idParams.parse(request.params);
    const input = groupSchema.partial().parse(request.body);
    const existing = await prisma.userGroup.findUnique({ where: { id } });
    if (!existing) throw new AppError('USER_GROUP_NOT_FOUND', 'User group not found', 404);
    const data = {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
    };
    const group = await prisma.userGroup.update({ where: { id }, data });
    await audit(request, 'USER_GROUP_UPDATED', 'UserGroup', 'SUCCESS', id, {
      fields: Object.keys(input),
    });
    return { success: true, data: group };
  });

  app.delete('/:id', { preHandler: requireRole('ADMIN', 'OPERATOR') }, async (request) => {
    const { id } = idParams.parse(request.params);
    const group = await prisma.userGroup.findUnique({
      where: { id },
      include: { _count: { select: { users: { where: { deletedAt: null } } } } },
    });
    if (!group) throw new AppError('USER_GROUP_NOT_FOUND', 'User group not found', 404);
    if (group._count.users > 0)
      throw new AppError('USER_GROUP_IN_USE', 'User group is still in use', 409);
    await prisma.$transaction([
      prisma.user.updateMany({
        where: { groupId: id, deletedAt: { not: null } },
        data: { groupId: null },
      }),
      prisma.userGroup.delete({ where: { id } }),
    ]);
    await audit(request, 'USER_GROUP_DELETED', 'UserGroup', 'SUCCESS', id, {
      name: group.name,
    });
    return { success: true, data: null };
  });
};

export const nodeUserRoutes: FastifyPluginAsync<{ service: UserService }> = async (
  app,
  options,
) => {
  app.get(
    '/:id/users',
    { preHandler: requireRole('ADMIN', 'OPERATOR', 'VIEWER') },
    async (request) => {
      const { id } = idParams.parse(request.params);
      return { success: true, data: await options.service.listNodeUsers(id) };
    },
  );
};
