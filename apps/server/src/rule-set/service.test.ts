import { createServer } from 'node:http';
import type { RequestListener } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { prisma } from '../db.js';
import { refreshRuleSet } from './service.js';
import type { RemoteFetchOptions } from './fetcher.js';

const servers: Array<ReturnType<typeof createServer>> = [];
const createdIds: string[] = [];

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
  if (createdIds.length) {
    await prisma.ruleSet.deleteMany({ where: { id: { in: createdIds.splice(0) } } });
  }
  await prisma.notification.deleteMany({ where: { eventType: { startsWith: 'RULE_SET_' } } });
  await prisma.auditLog.deleteMany({ where: { resource: 'RuleSet' } });
});

async function fixtureServer(
  handler: RequestListener,
): Promise<{ url: string; options: RemoteFetchOptions }> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://rules.test:${String(port)}/rules`,
    options: {
      allowHttp: true,
      allowPrivateForTests: true,
      resolver: async () => [{ address: '127.0.0.1', family: 4 }],
    },
  };
}

async function createRemote(url: string) {
  const ruleSet = await prisma.ruleSet.create({
    data: {
      name: `Remote ${crypto.randomUUID()}`,
      sourceType: 'REMOTE',
      format: 'PLAIN_TEXT',
      sourceUrl: url,
      enabled: true,
      status: 'ERROR',
    },
  });
  createdIds.push(ruleSet.id);
  return ruleSet;
}

describe('rule set Last Known Good refresh state machine', () => {
  it('preserves cache on failure, becomes stale, and recovers atomically', async () => {
    let body = 'DOMAIN_SUFFIX,openai.com\n';
    const target = await fixtureServer((_request, response) => response.end(body));
    const ruleSet = await createRemote(target.url);

    const first = await refreshRuleSet(ruleSet.id, target.options);
    expect(first).toMatchObject({ status: 'READY', changed: true, ruleCount: 1 });
    const cacheA = await prisma.ruleSetCache.findUniqueOrThrow({
      where: { ruleSetId: ruleSet.id },
    });

    body = 'malformed line';
    await expect(refreshRuleSet(ruleSet.id, target.options)).rejects.toMatchObject({
      code: 'RULE_SET_PARSE_FAILED',
    });
    const stale = await prisma.ruleSet.findUniqueOrThrow({
      where: { id: ruleSet.id },
      include: { cache: true },
    });
    expect(stale.status).toBe('STALE');
    expect(stale.cache?.contentHash).toBe(cacheA.contentHash);
    expect(stale.cache?.normalizedContent).toBe(cacheA.normalizedContent);

    await expect(refreshRuleSet(ruleSet.id, target.options)).rejects.toBeTruthy();
    expect(
      await prisma.notification.findMany({ where: { eventType: 'RULE_SET_STALE' } }),
    ).toHaveLength(1);

    body = 'DOMAIN_SUFFIX,chatgpt.com\nDOMAIN_SUFFIX,openai.com\n';
    const recovered = await refreshRuleSet(ruleSet.id, target.options);
    expect(recovered).toMatchObject({ status: 'READY', changed: true, ruleCount: 2 });
    expect(await prisma.notification.count({ where: { eventType: 'RULE_SET_RECOVERED' } })).toBe(1);
  });

  it('handles conditional 304 without changing hash or revision', async () => {
    let requestCount = 0;
    const target = await fixtureServer((request, response) => {
      requestCount += 1;
      if (requestCount > 1) {
        expect(request.headers['if-none-match']).toBe('rules-a');
        response.statusCode = 304;
        response.end();
        return;
      }
      response.setHeader('etag', 'rules-a');
      response.end('DOMAIN,example.com\n');
    });
    const ruleSet = await createRemote(target.url);
    await refreshRuleSet(ruleSet.id, target.options);
    const before = await prisma.ruleSet.findUniqueOrThrow({ where: { id: ruleSet.id } });
    const second = await refreshRuleSet(ruleSet.id, target.options);
    const after = await prisma.ruleSet.findUniqueOrThrow({ where: { id: ruleSet.id } });
    expect(second.changed).toBe(false);
    expect(after.contentHash).toBe(before.contentHash);
    expect(after.revision).toBe(before.revision);
    expect(after.lastFetchAt?.getTime()).toBeGreaterThanOrEqual(before.lastFetchAt?.getTime() ?? 0);
  });

  it('coalesces ten concurrent refreshes into one fetch', async () => {
    let requests = 0;
    const target = await fixtureServer((_request, response) => {
      requests += 1;
      setTimeout(() => response.end('DOMAIN,example.com\n'), 20);
    });
    const ruleSet = await createRemote(target.url);
    const results = await Promise.all(
      Array.from({ length: 10 }, () => refreshRuleSet(ruleSet.id, target.options)),
    );
    expect(requests).toBe(1);
    expect(results.every((result) => result.contentHash === results[0]?.contentHash)).toBe(true);
  });

  it('marks an initial failure as ERROR with no cache', async () => {
    const target = await fixtureServer((_request, response) => response.end('broken'));
    const ruleSet = await createRemote(target.url);
    await expect(refreshRuleSet(ruleSet.id, target.options)).rejects.toBeTruthy();
    await expect(
      prisma.ruleSet.findUniqueOrThrow({ where: { id: ruleSet.id } }),
    ).resolves.toMatchObject({
      status: 'ERROR',
      contentHash: null,
    });
    expect(await prisma.ruleSetCache.count({ where: { ruleSetId: ruleSet.id } })).toBe(0);
    expect(await prisma.notification.count({ where: { eventType: 'RULE_SET_UNAVAILABLE' } })).toBe(
      1,
    );
  });

  it('rejects more than 50,000 normalized rules', async () => {
    const source = Array.from(
      { length: 50_001 },
      (_, index) => `DOMAIN_SUFFIX,service-${String(index)}.example.com`,
    ).join('\n');
    const target = await fixtureServer((_request, response) => response.end(source));
    const ruleSet = await createRemote(target.url);
    await expect(refreshRuleSet(ruleSet.id, target.options)).rejects.toMatchObject({
      code: 'RULE_SET_TOO_LARGE',
    });
    expect(await prisma.ruleSetCache.count({ where: { ruleSetId: ruleSet.id } })).toBe(0);
  });
});
