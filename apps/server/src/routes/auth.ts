import { randomBytes } from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';
import { authenticator } from 'otplib';
import QRCode from 'qrcode';
import { bootstrapSchema, loginSchema } from '@proxyhub/shared';
import { audit } from '../audit.js';
import { config } from '../config.js';
import { prisma } from '../db.js';
import { AppError } from '../errors.js';
import {
  decryptSecret,
  encryptSecret,
  hashPassword,
  hashToken,
  verifyPassword,
} from '../security/crypto.js';
import { authenticate, createSession, setSessionCookie } from '../auth/session.js';

const MAX_FAILED_LOGINS = 5;

async function verifyRecoveryCode(userId: string, code: string): Promise<boolean> {
  const unused = await prisma.recoveryCode.findMany({ where: { userId, usedAt: null } });
  for (const candidate of unused) {
    if (await verifyPassword(candidate.codeHash, code)) {
      await prisma.recoveryCode.update({
        where: { id: candidate.id },
        data: { usedAt: new Date() },
      });
      return true;
    }
  }
  return false;
}

async function createRecoveryCodes(userId: string): Promise<string[]> {
  const codes = Array.from({ length: 10 }, () => {
    const raw = randomBytes(5).toString('hex').toUpperCase();
    return `${raw.slice(0, 5)}-${raw.slice(5)}`;
  });
  const hashed = await Promise.all(codes.map((code) => hashPassword(code)));
  await prisma.$transaction([
    prisma.recoveryCode.deleteMany({ where: { userId } }),
    prisma.recoveryCode.createMany({
      data: hashed.map((codeHash) => ({ userId, codeHash })),
    }),
  ]);
  return codes;
}

export const authRoutes: FastifyPluginAsync = async (app) => {
  app.get('/status', async () => ({
    success: true,
    data: { needsBootstrap: (await prisma.adminUser.count()) === 0 },
  }));

  app.post('/bootstrap', async (request, reply) => {
    const input = bootstrapSchema.parse(request.body);
    if ((await prisma.adminUser.count()) > 0) {
      throw new AppError('ALREADY_BOOTSTRAPPED', 'Administrator already exists', 409);
    }
    const authenticatedAt = new Date();
    const passwordHash = await hashPassword(input.password);
    const bootstrap = await prisma.$transaction(async (database) => {
      if ((await database.adminUser.count()) > 0) {
        throw new AppError('ALREADY_BOOTSTRAPPED', 'Administrator already exists', 409);
      }
      const created = await database.adminUser.create({
        data: { username: input.username, passwordHash, lastLoginAt: authenticatedAt },
      });
      const session = await createSession(request, reply, created.id, {
        database,
        authenticatedAt,
        setCookie: false,
      });
      request.admin = {
        id: created.id,
        username: created.username,
        role: created.role,
        totpEnabled: false,
      };
      await audit(request, 'ADMIN_BOOTSTRAP', 'AdminUser', 'SUCCESS', created.id, {}, database);
      await database.notification.create({
        data: {
          level: 'SUCCESS',
          title: 'ProxyHub is ready',
          message: 'Administrator account created successfully.',
        },
      });
      return { user: created, session };
    });
    setSessionCookie(reply, bootstrap.session);
    return reply.code(201).send({ success: true, data: { username: bootstrap.user.username } });
  });

  app.post('/login', async (request, reply) => {
    const input = loginSchema.parse(request.body);
    const user = await prisma.adminUser.findUnique({ where: { username: input.username } });
    if (!user || !(await verifyPassword(user.passwordHash, input.password))) {
      if (user) {
        const count = user.failedLoginCount + 1;
        await prisma.adminUser.update({
          where: { id: user.id },
          data: {
            failedLoginCount: count,
            lockedUntil: count >= MAX_FAILED_LOGINS ? new Date(Date.now() + 15 * 60_000) : null,
          },
        });
      }
      await prisma.securityEvent.create({
        data: {
          type: 'LOGIN_FAILED',
          severity: 'WARNING',
          ip: request.ip,
          userAgent: request.headers['user-agent'] ?? null,
        },
      });
      await audit(request, 'LOGIN', 'Session', 'FAILURE');
      throw new AppError('INVALID_CREDENTIALS', 'Invalid username or password', 401);
    }
    if (user.lockedUntil && user.lockedUntil > new Date()) {
      throw new AppError('ACCOUNT_LOCKED', 'Account temporarily locked', 423);
    }
    if (user.totpEnabled) {
      const validTotp =
        input.totp && user.totpSecretEncrypted
          ? authenticator.check(input.totp, decryptSecret(user.totpSecretEncrypted))
          : false;
      const validRecovery = input.recoveryCode
        ? await verifyRecoveryCode(user.id, input.recoveryCode)
        : false;
      if (!validTotp && !validRecovery) {
        await prisma.securityEvent.create({
          data: { type: 'TOTP_FAILED', severity: 'WARNING', ip: request.ip },
        });
        throw new AppError('TOTP_REQUIRED', 'A valid 2FA or recovery code is required', 401);
      }
    }
    const isNewIp = Boolean(user.lastLoginIp && user.lastLoginIp !== request.ip);
    const authenticatedAt = new Date();
    await prisma.adminUser.update({
      where: { id: user.id },
      data: {
        failedLoginCount: 0,
        lockedUntil: null,
        lastLoginAt: authenticatedAt,
        lastLoginIp: request.ip,
      },
    });
    await createSession(request, reply, user.id, { authenticatedAt });
    request.admin = {
      id: user.id,
      username: user.username,
      role: user.role,
      totpEnabled: user.totpEnabled,
    };
    if (isNewIp) {
      await prisma.securityEvent.create({
        data: { type: 'LOGIN_NEW_IP', severity: 'INFO', ip: request.ip },
      });
      await prisma.notification.create({
        data: {
          level: 'WARNING',
          title: 'New IP login',
          message: `A login was detected from ${request.ip}.`,
          eventType: 'LOGIN_NEW_IP',
        },
      });
    }
    await audit(request, 'LOGIN', 'Session', 'SUCCESS');
    return {
      success: true,
      data: { username: user.username, role: user.role, totpEnabled: user.totpEnabled },
    };
  });

  app.post('/logout', { preHandler: authenticate }, async (request, reply) => {
    const token = request.cookies[config.SESSION_COOKIE_NAME];
    if (token) await prisma.session.deleteMany({ where: { tokenHash: hashToken(token) } });
    await audit(request, 'LOGOUT', 'Session', 'SUCCESS');
    reply.clearCookie(config.SESSION_COOKIE_NAME, { path: '/' });
    return { success: true, data: null };
  });

  app.get('/me', { preHandler: authenticate }, async (request) => ({
    success: true,
    data: request.admin,
  }));

  app.get('/sessions', { preHandler: authenticate }, async (request) => ({
    success: true,
    data: await prisma.session.findMany({
      where: { userId: request.admin!.id },
      select: {
        id: true,
        ip: true,
        userAgent: true,
        createdAt: true,
        lastUsedAt: true,
        expiresAt: true,
      },
      orderBy: { lastUsedAt: 'desc' },
    }),
  }));

  app.delete('/sessions', { preHandler: authenticate }, async (request, reply) => {
    await prisma.session.deleteMany({ where: { userId: request.admin!.id } });
    reply.clearCookie(config.SESSION_COOKIE_NAME, { path: '/' });
    await audit(request, 'LOGOUT_ALL', 'Session', 'SUCCESS');
    return { success: true, data: null };
  });

  app.post('/2fa/setup', { preHandler: authenticate }, async (request) => {
    const user = await prisma.adminUser.findUniqueOrThrow({ where: { id: request.admin!.id } });
    if (user.totpEnabled) throw new AppError('TOTP_ALREADY_ENABLED', '2FA is already enabled', 409);
    const secret = authenticator.generateSecret();
    const uri = authenticator.keyuri(user.username, 'ProxyHub', secret);
    await prisma.systemSetting.upsert({
      where: { key: `totp-pending:${user.id}` },
      update: { value: encryptSecret(secret), encrypted: true },
      create: { key: `totp-pending:${user.id}`, value: encryptSecret(secret), encrypted: true },
    });
    return { success: true, data: { secret, qrCode: await QRCode.toDataURL(uri) } };
  });

  app.post('/2fa/enable', { preHandler: authenticate }, async (request) => {
    const body = request.body as { code?: string };
    if (!body.code) throw new AppError('VALIDATION_ERROR', 'Verification code is required');
    const pending = await prisma.systemSetting.findUnique({
      where: { key: `totp-pending:${request.admin!.id}` },
    });
    if (!pending) throw new AppError('TOTP_SETUP_REQUIRED', 'Start 2FA setup first', 409);
    const secret = decryptSecret(pending.value);
    if (!authenticator.check(body.code, secret))
      throw new AppError('TOTP_INVALID', 'Invalid verification code', 400);
    const recoveryCodes = await createRecoveryCodes(request.admin!.id);
    await prisma.$transaction([
      prisma.adminUser.update({
        where: { id: request.admin!.id },
        data: { totpEnabled: true, totpSecretEncrypted: encryptSecret(secret) },
      }),
      prisma.systemSetting.delete({ where: { key: pending.key } }),
    ]);
    await audit(request, '2FA_ENABLE', 'AdminUser', 'SUCCESS', request.admin!.id);
    return { success: true, data: { recoveryCodes } };
  });
};
