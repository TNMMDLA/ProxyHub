import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';

const databasePath = resolve('apps/server/prisma/data/proxyhub-test.db');

export function setup() {
  mkdirSync(resolve('apps/server/prisma/data'), { recursive: true });
  rmSync(databasePath, { force: true });
  writeFileSync(databasePath, '');
  const serverRequire = createRequire(resolve('apps/server/package.json'));
  const prismaCli = serverRequire.resolve('prisma/build/index.js');
  execFileSync(process.execPath, [prismaCli, 'migrate', 'deploy'], {
    cwd: resolve('apps/server'),
    stdio: 'inherit',
    env: { ...process.env, DATABASE_URL: 'file:./data/proxyhub-test.db' },
  });
  return () => rmSync(databasePath, { force: true });
}
