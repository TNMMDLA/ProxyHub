import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { cpus, freemem, hostname, loadavg, totalmem, uptime } from 'node:os';
import { readFile, rm, stat, writeFile } from 'node:fs/promises';
import Fastify from 'fastify';
import { z } from 'zod';
import {
  applyValidatedConfig,
  restoreValidatedConfig,
  testXrayConfig,
} from '@proxyhub/xray-manager';
import { parseAgentConfig } from './config.js';
import { inspectXrayHealth, waitForHealthyXray } from './xray-health.js';

const env = parseAgentConfig(process.env);

class AgentOperationError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'AgentOperationError';
  }
}

const app = Fastify({
  logger: {
    level: process.env.NODE_ENV === 'test' ? 'silent' : 'info',
    redact: ['req.headers.authorization'],
  },
});

let xrayOperation = Promise.resolve();

function withXrayLock<T>(operation: () => Promise<T>): Promise<T> {
  const result = xrayOperation.then(operation, operation);
  xrayOperation = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

async function restartXrayAndWait(): Promise<Awaited<ReturnType<typeof waitForHealthyXray>>> {
  const token = randomUUID();
  await writeFile(env.XRAY_RESTART_SIGNAL, token, { mode: 0o600 });
  const deadline = Date.now() + env.XRAY_HEALTH_TIMEOUT_MS;
  let acknowledged = false;
  while (!acknowledged && Date.now() < deadline) {
    try {
      acknowledged = (await readFile(env.XRAY_APPLIED_PATH, 'utf8')).trim() === token;
    } catch {
      acknowledged = false;
    }
    if (!acknowledged) await new Promise((resolve) => setTimeout(resolve, 200));
  }
  if (!acknowledged) throw new Error('Xray restart acknowledgement timed out');
  return waitForHealthyXray(env);
}

function rollbackPath(revision: string): string {
  return `${env.XRAY_CONFIG_PATH}.rollback-${revision}`;
}

app.addHook('preHandler', async (request, reply) => {
  const candidate = request.headers.authorization?.replace(/^Bearer\s+/i, '') ?? '';
  const expected = createHash('sha256').update(env.AGENT_TOKEN).digest();
  const actual = createHash('sha256').update(candidate).digest();
  if (!timingSafeEqual(expected, actual))
    return reply.code(401).send({
      success: false,
      error: { code: 'AGENT_AUTH_FAILED', message: 'Agent authentication failed' },
    });
});

app.get('/status', async () => {
  const total = totalmem();
  const xray = await inspectXrayHealth(env);
  return {
    success: true,
    data: {
      agent: { version: '0.3.0', hostname: hostname(), uptime: uptime() },
      system: {
        cpuCount: cpus().length,
        load: loadavg()[0] ?? 0,
        memoryUsage: Math.round(((total - freemem()) / total) * 100),
      },
      xray,
    },
  };
});

app.post('/xray/validate', async (request) => {
  const body = z.object({ config: z.record(z.string(), z.unknown()) }).parse(request.body);
  const temporary = `${env.XRAY_CONFIG_PATH}.validation-${randomUUID()}`;
  try {
    await writeFile(temporary, JSON.stringify(body.config, null, 2), { mode: 0o600 });
    await testXrayConfig(env.XRAY_BINARY, temporary);
    return { success: true, data: { valid: true } };
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
});

app.post('/xray/apply', async (request) => {
  const body = z.object({ config: z.record(z.string(), z.unknown()) }).parse(request.body);
  return withXrayLock(async () => {
    const revision = randomUUID();
    const backupPath = rollbackPath(revision);
    await applyValidatedConfig(env.XRAY_BINARY, env.XRAY_CONFIG_PATH, body.config, {
      backupPath,
      requireExisting: true,
    });
    try {
      const health = await restartXrayAndWait();
      return { success: true, data: { applied: true, restarted: true, revision, health } };
    } catch (error) {
      try {
        await restoreValidatedConfig(env.XRAY_BINARY, env.XRAY_CONFIG_PATH, backupPath);
        await restartXrayAndWait();
        await rm(backupPath, { force: true });
      } catch (rollbackError) {
        throw new AgentOperationError(
          'XRAY_ROLLBACK_FAILED',
          `The new configuration was unhealthy and automatic rollback failed: ${(rollbackError as Error).message}`,
        );
      }
      throw new AgentOperationError(
        'XRAY_CONFIG_ROLLED_BACK',
        `The new configuration was unhealthy and the previous configuration was restored: ${(error as Error).message}`,
      );
    }
  });
});

app.post('/xray/restart', async () => {
  return withXrayLock(async () => {
    await stat(env.XRAY_CONFIG_PATH);
    await testXrayConfig(env.XRAY_BINARY, env.XRAY_CONFIG_PATH);
    const health = await restartXrayAndWait();
    return { success: true, data: { restarted: true, health } };
  });
});

const revisionSchema = z.object({ revision: z.string().uuid() });

app.post('/xray/rollback', async (request) => {
  const { revision } = revisionSchema.parse(request.body);
  return withXrayLock(async () => {
    const backupPath = rollbackPath(revision);
    await restoreValidatedConfig(env.XRAY_BINARY, env.XRAY_CONFIG_PATH, backupPath);
    const health = await restartXrayAndWait();
    await rm(backupPath, { force: true });
    return { success: true, data: { rolledBack: true, health } };
  });
});

app.post('/xray/confirm', async (request) => {
  const { revision } = revisionSchema.parse(request.body);
  await rm(rollbackPath(revision), { force: true });
  return { success: true, data: { confirmed: true } };
});

app.setErrorHandler((error, request, reply) => {
  request.log.error(error);
  const message = error instanceof Error ? error.message : 'Agent operation failed';
  const code = error instanceof AgentOperationError ? error.code : 'AGENT_OPERATION_FAILED';
  return reply.code(error instanceof AgentOperationError ? 500 : 400).send({
    success: false,
    error: { code, message },
  });
});

await app.listen({ host: env.AGENT_HOST, port: env.AGENT_PORT });
