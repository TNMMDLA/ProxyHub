import { hostname } from 'node:os';
import { buildApp } from './app.js';
import { config } from './config.js';
import { prisma } from './db.js';

const app = await buildApp();

await prisma.server.upsert({
  where: { id: 'local-controller' },
  update: { status: 'ONLINE', lastHeartbeat: new Date() },
  create: {
    id: 'local-controller',
    name: 'Local Controller',
    hostname: hostname(),
    ip: '127.0.0.1',
    status: 'ONLINE',
    agentVersion: '0.2.1',
    lastHeartbeat: new Date(),
  },
});

const close = async () => {
  await app.close();
  await prisma.$disconnect();
  process.exit(0);
};
process.on('SIGINT', () => void close());
process.on('SIGTERM', () => void close());

await app.listen({ host: config.HOST, port: config.PORT });
