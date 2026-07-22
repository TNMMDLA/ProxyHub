import { hostname } from 'node:os';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
await prisma.server.upsert({
  where: { id: 'local-controller' },
  update: {},
  create: {
    id: 'local-controller',
    name: 'Local Controller',
    hostname: hostname(),
    ip: '127.0.0.1',
    status: 'ONLINE',
    agentVersion: '0.1.0',
    region: 'Local',
  },
});
await prisma.$disconnect();
