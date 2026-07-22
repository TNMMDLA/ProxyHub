import type { Prisma } from '@prisma/client';
import type { FastifyRequest } from 'fastify';
import { prisma } from './db.js';
import { redactSensitive } from './security/redact.js';

export async function audit(
  request: FastifyRequest,
  action: string,
  resource: string,
  result: 'SUCCESS' | 'FAILURE',
  resourceId?: string,
  metadata: unknown = {},
  database: Pick<Prisma.TransactionClient, 'auditLog'> = prisma,
): Promise<void> {
  await database.auditLog.create({
    data: {
      actorId: request.admin?.id ?? null,
      actorName: request.admin?.username ?? 'anonymous',
      action,
      resource,
      resourceId: resourceId ?? null,
      ip: request.ip,
      result,
      metadata: JSON.stringify(redactSensitive(metadata)),
    },
  });
}
