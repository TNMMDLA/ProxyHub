import { hostname } from 'node:os';
import { buildApp } from './app.js';
import { config } from './config.js';
import { prisma } from './db.js';
import { startRuleSetScheduler } from './rule-set/scheduler.js';
import { PROXYHUB_RELEASE } from '@proxyhub/shared';
import { defaultAgentClient } from './agent-client.js';
import { TrafficAccountingService } from './traffic/accounting.js';
import { startTrafficAccountingScheduler } from './traffic/scheduler.js';

const app = await buildApp();
const stopRuleSetScheduler = startRuleSetScheduler();
const stopTrafficAccountingScheduler = startTrafficAccountingScheduler(
  new TrafficAccountingService(prisma, defaultAgentClient),
  config.PROXYHUB_TRAFFIC_ACCOUNTING_INTERVAL_MS,
);

await prisma.server.upsert({
  where: { id: 'local-controller' },
  update: { status: 'ONLINE', lastHeartbeat: new Date() },
  create: {
    id: 'local-controller',
    name: 'Local Controller',
    hostname: hostname(),
    ip: '127.0.0.1',
    status: 'ONLINE',
    agentVersion: PROXYHUB_RELEASE.version,
    lastHeartbeat: new Date(),
  },
});

const close = async () => {
  stopRuleSetScheduler();
  stopTrafficAccountingScheduler();
  await app.close();
  await prisma.$disconnect();
  process.exit(0);
};
process.on('SIGINT', () => void close());
process.on('SIGTERM', () => void close());

await app.listen({ host: config.HOST, port: config.PORT });
