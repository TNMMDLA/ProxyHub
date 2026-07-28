import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../../..');
const schema = join(root, 'apps/server/prisma/schema.prisma');
const migrations = join(root, 'apps/server/prisma/migrations');
const require = createRequire(import.meta.url);
const prismaCli = require.resolve('prisma/build/index.js');
const temporaryDirectories: string[] = [];

function databaseUrl(path: string): string {
  return `file:${path.replaceAll('\\', '/')}`;
}

function prisma(args: string[], databasePath: string): void {
  execFileSync(process.execPath, [prismaCli, ...args, '--schema', schema], {
    cwd: root,
    env: { ...process.env, DATABASE_URL: databaseUrl(databasePath) },
    stdio: 'pipe',
  });
}

function tableNames(database: DatabaseSync): string[] {
  return (
    database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all() as Array<{ name: string }>
  ).map((row) => row.name);
}

async function temporaryDatabase(name: string): Promise<{ directory: string; path: string }> {
  const directory = await mkdtemp(join(tmpdir(), `proxyhub-${name}-`));
  temporaryDirectories.push(directory);
  return { directory, path: join(directory, 'proxyhub.db') };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('Prisma migration compatibility', () => {
  it('creates the complete V0.4 schema from an empty database', async () => {
    const databasePath = (await temporaryDatabase('fresh')).path;
    new DatabaseSync(databasePath).close();
    prisma(['migrate', 'deploy'], databasePath);

    const database = new DatabaseSync(databasePath);
    try {
      const tables = tableNames(database);
      for (const table of [
        'AdminUser',
        'Node',
        'NodePool',
        'Policy',
        'PolicyRule',
        'Subscription',
        'RuleSet',
        'RuleSetEntry',
        'RuleSetCache',
        'NetworkPerformanceRun',
        'NetworkPerformanceTargetResult',
      ]) {
        expect(tables).toContain(table);
      }
      expect(
        database.prepare('SELECT COUNT(*) AS count FROM _prisma_migrations').get(),
      ).toMatchObject({ count: 4 });
      expect(database.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    } finally {
      database.close();
    }
  }, 15_000);

  it('upgrades a populated V0.1.1 database without losing auth, nodes, or pools', async () => {
    const databasePath = (await temporaryDatabase('upgrade')).path;
    const database = new DatabaseSync(databasePath);
    database.exec('PRAGMA foreign_keys = ON');
    database.exec(readFileSync(join(migrations, '20260722000100_init/migration.sql'), 'utf8'));
    database.exec(`
      INSERT INTO "AdminUser" ("id", "username", "passwordHash", "updatedAt")
        VALUES ('admin-v011', 'recovery-admin', 'argon2id-sentinel', CURRENT_TIMESTAMP);
      INSERT INTO "Session" ("id", "tokenHash", "userId", "ip", "userAgent", "expiresAt")
        VALUES ('session-v011', 'session-hash-sentinel', 'admin-v011', '127.0.0.1', 'migration-test', '2099-01-01T00:00:00.000Z');
      INSERT INTO "Server" ("id", "name", "hostname", "ip", "updatedAt")
        VALUES ('server-v011', 'Existing Server', 'proxyhub-vps', '192.0.2.10', CURRENT_TIMESTAMP);
      INSERT INTO "Node" (
        "id", "serverId", "name", "host", "port", "uuid", "realityPublicKey",
        "realityPrivateKeyEncrypted", "shortId", "sni", "dest", "updatedAt"
      ) VALUES (
        'node-v011', 'server-v011', 'Existing Node', 'edge.example.com', 443,
        '11111111-1111-4111-8111-111111111111', 'public-key-sentinel',
        'encrypted-private-key-sentinel', '0123456789abcdef', 'www.microsoft.com',
        'www.microsoft.com:443', CURRENT_TIMESTAMP
      );
      INSERT INTO "NodePool" ("id", "name", "updatedAt")
        VALUES ('pool-v011', 'Existing Pool', CURRENT_TIMESTAMP);
      INSERT INTO "NodePoolMember" ("nodeId", "nodePoolId", "priority")
        VALUES ('node-v011', 'pool-v011', 0);
    `);
    database.close();

    prisma(['migrate', 'resolve', '--applied', '20260722000100_init'], databasePath);
    prisma(['migrate', 'deploy'], databasePath);

    const upgraded = new DatabaseSync(databasePath);
    upgraded.exec('PRAGMA foreign_keys = ON');
    try {
      expect(upgraded.prepare('SELECT username, passwordHash FROM AdminUser').get()).toMatchObject({
        username: 'recovery-admin',
        passwordHash: 'argon2id-sentinel',
      });
      expect(upgraded.prepare('SELECT tokenHash FROM Session').get()).toMatchObject({
        tokenHash: 'session-hash-sentinel',
      });
      expect(
        upgraded.prepare('SELECT name, realityPrivateKeyEncrypted FROM Node').get(),
      ).toMatchObject({
        name: 'Existing Node',
        realityPrivateKeyEncrypted: 'encrypted-private-key-sentinel',
      });
      expect(upgraded.prepare('SELECT nodeId, nodePoolId FROM NodePoolMember').get()).toMatchObject(
        {
          nodeId: 'node-v011',
          nodePoolId: 'pool-v011',
        },
      );
      expect(tableNames(upgraded)).toEqual(
        expect.arrayContaining(['Policy', 'PolicyRule', 'Subscription']),
      );
      expect(upgraded.prepare('PRAGMA foreign_key_check').all()).toEqual([]);

      upgraded.exec(`
        INSERT INTO "Policy" (
          "id", "name", "defaultAction", "defaultNodePoolId", "updatedAt"
        ) VALUES ('policy-v02', 'Protected Policy', 'NODE_POOL', 'pool-v011', CURRENT_TIMESTAMP);
        INSERT INTO "Subscription" (
          "id", "name", "policyId", "format", "tokenHash", "tokenPrefix", "updatedAt"
        ) VALUES (
          'subscription-v02', 'Protected Subscription', 'policy-v02', 'raw',
          'subscription-hash-sentinel', 'prefix', CURRENT_TIMESTAMP
        );
      `);
      expect(() => upgraded.exec("DELETE FROM Policy WHERE id = 'policy-v02'")).toThrow(
        /foreign key constraint/i,
      );
      expect(() => upgraded.exec("DELETE FROM NodePool WHERE id = 'pool-v011'")).toThrow(
        /foreign key constraint/i,
      );
    } finally {
      upgraded.close();
    }
  }, 15_000);

  it('upgrades a populated V0.2.1 database through V0.4 without losing existing records', async () => {
    const databasePath = (await temporaryDatabase('v021-upgrade')).path;
    const database = new DatabaseSync(databasePath);
    database.exec('PRAGMA foreign_keys = ON');
    database.exec(readFileSync(join(migrations, '20260722000100_init/migration.sql'), 'utf8'));
    database.exec(
      readFileSync(
        join(migrations, '20260723000100_v02_policy_subscription/migration.sql'),
        'utf8',
      ),
    );
    database.exec(`
      INSERT INTO "AdminUser" ("id", "username", "passwordHash", "updatedAt")
        VALUES ('admin-v021', 'v021-admin', 'argon2id-v021', CURRENT_TIMESTAMP);
      INSERT INTO "Session" ("id", "tokenHash", "userId", "ip", "userAgent", "expiresAt")
        VALUES ('session-v021', 'session-v021-hash', 'admin-v021', '127.0.0.1', 'migration-test', '2099-01-01T00:00:00.000Z');
      INSERT INTO "Server" ("id", "name", "hostname", "ip", "updatedAt")
        VALUES ('server-v021', 'V0.2.1 Server', 'v021-vps', '192.0.2.20', CURRENT_TIMESTAMP);
      INSERT INTO "Node" (
        "id", "serverId", "name", "host", "port", "uuid", "realityPublicKey",
        "realityPrivateKeyEncrypted", "shortId", "sni", "dest", "updatedAt"
      ) VALUES (
        'node-v021', 'server-v021', 'V0.2.1 Node', 'edge-v021.example.com', 443,
        '22222222-2222-4222-8222-222222222222', 'public-v021', 'encrypted-private-v021',
        'abcdef0123456789', 'www.microsoft.com', 'www.microsoft.com:443', CURRENT_TIMESTAMP
      );
      INSERT INTO "NodePool" ("id", "name", "updatedAt")
        VALUES ('pool-v021', 'V0.2.1 Pool', CURRENT_TIMESTAMP);
      INSERT INTO "NodePoolMember" ("nodeId", "nodePoolId", "priority")
        VALUES ('node-v021', 'pool-v021', 0);
      INSERT INTO "Policy" ("id", "name", "defaultAction", "defaultNodePoolId", "updatedAt")
        VALUES ('policy-v021', 'V0.2.1 Policy', 'NODE_POOL', 'pool-v021', CURRENT_TIMESTAMP);
      INSERT INTO "PolicyRule" (
        "id", "policyId", "name", "priority", "matchType", "matchValue", "actionType", "nodePoolId", "updatedAt"
      ) VALUES (
        'rule-v021', 'policy-v021', 'V0.2.1 Rule', 10, 'DOMAIN_SUFFIX', 'example.com',
        'NODE_POOL', 'pool-v021', CURRENT_TIMESTAMP
      );
      INSERT INTO "Subscription" (
        "id", "name", "policyId", "format", "tokenHash", "tokenPrefix", "updatedAt"
      ) VALUES (
        'subscription-v021', 'V0.2.1 Subscription', 'policy-v021', 'mihomo',
        'subscription-v021-hash', 'v021pref', CURRENT_TIMESTAMP
      );
    `);
    database.close();

    prisma(['migrate', 'resolve', '--applied', '20260722000100_init'], databasePath);
    prisma(
      ['migrate', 'resolve', '--applied', '20260723000100_v02_policy_subscription'],
      databasePath,
    );
    prisma(['migrate', 'deploy'], databasePath);

    const upgraded = new DatabaseSync(databasePath);
    upgraded.exec('PRAGMA foreign_keys = ON');
    try {
      expect(upgraded.prepare('SELECT username FROM AdminUser').get()).toMatchObject({
        username: 'v021-admin',
      });
      expect(upgraded.prepare('SELECT name FROM Node').get()).toMatchObject({
        name: 'V0.2.1 Node',
      });
      expect(upgraded.prepare('SELECT name FROM NodePool').get()).toMatchObject({
        name: 'V0.2.1 Pool',
      });
      expect(upgraded.prepare('SELECT name FROM Policy').get()).toMatchObject({
        name: 'V0.2.1 Policy',
      });
      expect(
        upgraded.prepare('SELECT name, matchSourceType, ruleSetId FROM PolicyRule').get(),
      ).toMatchObject({
        name: 'V0.2.1 Rule',
        matchSourceType: 'INLINE',
        ruleSetId: null,
      });
      expect(upgraded.prepare('SELECT name FROM Subscription').get()).toMatchObject({
        name: 'V0.2.1 Subscription',
      });
      expect(tableNames(upgraded)).toEqual(
        expect.arrayContaining([
          'RuleSet',
          'RuleSetEntry',
          'RuleSetCache',
          'NetworkPerformanceRun',
          'NetworkPerformanceTargetResult',
        ]),
      );
      expect(upgraded.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    } finally {
      upgraded.close();
    }
  }, 20_000);

  it('upgrades a populated V0.3.1 database to V0.4 and preserves all existing data', async () => {
    const databasePath = (await temporaryDatabase('v031-upgrade')).path;
    const database = new DatabaseSync(databasePath);
    database.exec('PRAGMA foreign_keys = ON');
    for (const migration of [
      '20260722000100_init',
      '20260723000100_v02_policy_subscription',
      '20260724000100_v03_rule_sets',
    ]) {
      database.exec(readFileSync(join(migrations, migration, 'migration.sql'), 'utf8'));
    }
    database.exec(`
      INSERT INTO "Server" ("id", "name", "hostname", "ip", "updatedAt")
        VALUES ('server-v031', 'V0.3.1 Server', 'v031-vps', '192.0.2.31', CURRENT_TIMESTAMP);
      INSERT INTO "Node" (
        "id", "serverId", "name", "host", "port", "uuid", "realityPublicKey",
        "realityPrivateKeyEncrypted", "shortId", "sni", "dest", "updatedAt"
      ) VALUES (
        'node-v031', 'server-v031', 'V0.3.1 Node', 'edge-v031.example.com', 443,
        '31313131-3131-4131-8131-313131313131', 'public-v031',
        'encrypted-private-v031', '3131313131313131', 'www.microsoft.com',
        'www.microsoft.com:443', CURRENT_TIMESTAMP
      );
      INSERT INTO "RuleSet" (
        "id", "name", "sourceType", "format", "updatedAt"
      ) VALUES ('rules-v031', 'V0.3.1 Rules', 'MANUAL', 'PLAIN_TEXT', CURRENT_TIMESTAMP);
    `);
    database.close();

    for (const migration of [
      '20260722000100_init',
      '20260723000100_v02_policy_subscription',
      '20260724000100_v03_rule_sets',
    ]) {
      prisma(['migrate', 'resolve', '--applied', migration], databasePath);
    }
    prisma(['migrate', 'deploy'], databasePath);

    const upgraded = new DatabaseSync(databasePath);
    upgraded.exec('PRAGMA foreign_keys = ON');
    try {
      expect(upgraded.prepare('SELECT name FROM Node').get()).toMatchObject({
        name: 'V0.3.1 Node',
      });
      expect(upgraded.prepare('SELECT name FROM RuleSet').get()).toMatchObject({
        name: 'V0.3.1 Rules',
      });
      upgraded.exec(`
        INSERT INTO "NetworkPerformanceRun" (
          "id", "nodeId", "status", "proxyhubVersion", "buildSha"
        ) VALUES ('run-v04', 'node-v031', 'COMPLETED', '0.4.0-dev', 'fixture');
        INSERT INTO "NetworkPerformanceTargetResult" (
          "id", "runId", "targetId", "targetLabel", "success"
        ) VALUES ('target-v04', 'run-v04', 'fixture', 'Fixture Target', 1);
      `);
      expect(
        upgraded.prepare('SELECT targetLabel FROM NetworkPerformanceTargetResult').get(),
      ).toMatchObject({ targetLabel: 'Fixture Target' });
      expect(upgraded.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      upgraded.exec("DELETE FROM Node WHERE id = 'node-v031'");
      expect(
        upgraded.prepare('SELECT COUNT(*) AS count FROM NetworkPerformanceRun').get(),
      ).toMatchObject({ count: 0 });
    } finally {
      upgraded.close();
    }
  }, 20_000);
});
