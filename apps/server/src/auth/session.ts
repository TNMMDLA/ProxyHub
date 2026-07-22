import type { AdminUser } from '@prisma/client';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config.js';
import { prisma } from '../db.js';
import { AppError } from '../errors.js';
import { hashToken, newOpaqueToken } from '../security/crypto.js';

declare module 'fastify' {
  interface FastifyRequest {
    admin?: Pick<AdminUser, 'id' | 'username' | 'role' | 'totpEnabled'>;
  }
}

export async function createSession(request: FastifyRequest, reply: FastifyReply, userId: string) {
  const token = newOpaqueToken();
  const expiresAt = new Date(Date.now() + config.SESSION_TTL_HOURS * 60 * 60 * 1000);
  await prisma.session.create({
    data: {
      tokenHash: hashToken(token),
      userId,
      ip: request.ip,
      userAgent: request.headers['user-agent']?.slice(0, 500) ?? 'unknown',
      expiresAt,
    },
  });
  reply.setCookie(config.SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    secure: config.NODE_ENV === 'production',
    sameSite: 'strict',
    path: '/',
    expires: expiresAt,
  });
}

export async function authenticate(request: FastifyRequest): Promise<void> {
  const token = request.cookies[config.SESSION_COOKIE_NAME];
  if (!token) throw new AppError('AUTH_REQUIRED', 'Authentication required', 401);
  const session = await prisma.session.findUnique({
    where: { tokenHash: hashToken(token) },
    include: { user: true },
  });
  if (!session || session.expiresAt <= new Date()) {
    if (session) await prisma.session.delete({ where: { id: session.id } });
    throw new AppError('SESSION_EXPIRED', 'Session expired', 401);
  }
  request.admin = {
    id: session.user.id,
    username: session.user.username,
    role: session.user.role,
    totpEnabled: session.user.totpEnabled,
  };
  void prisma.session.update({ where: { id: session.id }, data: { lastUsedAt: new Date() } });
}

export function requireRole(...roles: string[]) {
  return async (request: FastifyRequest) => {
    await authenticate(request);
    if (!request.admin || !roles.includes(request.admin.role)) {
      throw new AppError('FORBIDDEN', 'Insufficient permission', 403);
    }
  };
}
