import { describe, expect, it, vi } from 'vitest';
import { buildRealityCompatibilityConfigs, type ResolvedAddress } from '@proxyhub/xray-manager';
import {
  parseRealityServerName,
  parseRealityTarget,
  RealityTargetCompatibilityService,
  type ManagedXrayProcess,
  type RealityCompatibilityRuntime,
} from './reality-target-compatibility.js';

class FakeProcess implements ManagedXrayProcess {
  stopCalls = 0;

  constructor(private alive = true) {}

  isAlive() {
    return this.alive;
  }

  async stop() {
    this.stopCalls += 1;
    this.alive = false;
  }
}

function fixture(overrides: Partial<RealityCompatibilityRuntime> = {}) {
  const processes: FakeProcess[] = [];
  const configs = new Map<string, Record<string, unknown>>();
  const removeTempDirectory = vi.fn(async () => undefined);
  const runtime: RealityCompatibilityRuntime = {
    resolve: async () => [{ address: '142.250.72.206', family: 4 }],
    version: async () => 'Xray 26.5.9',
    tlsPrecheck: async () => true,
    allocatePort: vi
      .fn<RealityCompatibilityRuntime['allocatePort']>()
      .mockResolvedValueOnce(41_001)
      .mockResolvedValueOnce(41_002),
    createTempDirectory: async () => '/tmp/proxyhub-reality-test',
    writeConfig: async (path, config) => {
      configs.set(path, config);
    },
    validateConfig: async () => 'valid',
    startXray: () => {
      const process = new FakeProcess();
      processes.push(process);
      return process;
    },
    waitForPort: async (_port, process) => {
      if (!process.isAlive()) throw new Error('process exited');
    },
    probeThroughSocks: async () => ({ handshakePassed: true, trafficPassed: true }),
    removeTempDirectory,
    ...overrides,
  };
  return {
    runtime,
    service: new RealityTargetCompatibilityService({
      binary: '/configured/xray',
      timeoutMs: 2_000,
      runtime,
    }),
    processes,
    configs,
    removeTempDirectory,
  };
}

function expectErrorCode(run: () => unknown, code: string) {
  let caught: unknown;
  try {
    run();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(Error);
  expect(caught).toMatchObject({ code });
}

describe('Reality target compatibility service', () => {
  it.each([
    ['https://dl.google.com:443', 'REALITY_TARGET_INVALID'],
    ['user:password@example.com:443', 'REALITY_TARGET_INVALID'],
    ['example.com:443/path', 'REALITY_TARGET_INVALID'],
    ['localhost:443', 'REALITY_TARGET_INVALID'],
    ['example.com:0', 'REALITY_TARGET_INVALID'],
  ])('rejects invalid target %s with %s', (target, code) => {
    expectErrorCode(() => parseRealityTarget(target), code);
  });

  it('rejects invalid Reality server names', () => {
    for (const value of ['localhost', '127.0.0.1', 'https://example.com', 'bad host']) {
      expectErrorCode(() => parseRealityServerName(value), 'REALITY_TARGET_INVALID');
    }
  });

  it.each([
    { address: '127.0.0.1', family: 4 },
    { address: '10.0.0.8', family: 4 },
    { address: '::1', family: 6 },
    { address: '::ffff:127.0.0.1', family: 6 },
  ] satisfies ResolvedAddress[])('blocks non-public resolved address $address', async (address) => {
    const context = fixture({ resolve: async () => [address] });
    await expect(
      context.service.test({ serverName: 'example.com', target: 'example.com:443' }),
    ).rejects.toMatchObject({ code: 'REALITY_TARGET_BLOCKED_ADDRESS' });
    expect(context.processes).toHaveLength(0);
  });

  it('rejects DNS rebinding candidates when any resolved address is private', async () => {
    const context = fixture({
      resolve: async () => [
        { address: '142.250.72.206', family: 4 },
        { address: '127.0.0.1', family: 4 },
      ],
    });
    await expect(
      context.service.test({ serverName: 'example.com', target: 'example.com:443' }),
    ).rejects.toMatchObject({ code: 'REALITY_TARGET_BLOCKED_ADDRESS' });
  });

  it('returns an explicit DNS failure without starting a process', async () => {
    const context = fixture({ resolve: async () => [] });
    await expect(
      context.service.test({ serverName: 'example.com', target: 'example.com:443' }),
    ).rejects.toMatchObject({ code: 'REALITY_TARGET_DNS_FAILED' });
    expect(context.processes).toHaveLength(0);
  });

  it('returns TLS precheck failure without treating TLS success as Reality success', async () => {
    const context = fixture({ tlsPrecheck: async () => false });
    await expect(
      context.service.test({ serverName: 'example.com', target: 'example.com:443' }),
    ).resolves.toMatchObject({
      status: 'INCOMPATIBLE',
      tlsPrecheck: { status: 'FAILED' },
      realityHandshake: { status: 'NOT_RUN' },
      endToEndTraffic: { status: 'NOT_RUN' },
    });
    expect(context.processes).toHaveLength(0);
  });

  it('builds isolated loopback configs, completes traffic, and cleans every resource', async () => {
    const context = fixture();
    const result = await context.service.test({
      serverName: 'dl.google.com',
      target: 'dl.google.com:443',
    });
    expect(result).toMatchObject({
      status: 'COMPATIBLE',
      tlsPrecheck: { status: 'PASSED' },
      realityHandshake: { status: 'PASSED' },
      endToEndTraffic: { status: 'PASSED' },
      xrayVersion: 'Xray 26.5.9',
    });
    expect(context.configs.size).toBe(2);
    const [serverConfig, clientConfig] = [...context.configs.values()];
    expect(serverConfig).toMatchObject({
      inbounds: [{ listen: '127.0.0.1', port: 41_001 }],
    });
    expect(clientConfig).toMatchObject({
      inbounds: [{ listen: '127.0.0.1', port: 41_002 }],
    });
    expect([...context.configs.keys()].every((path) => path.endsWith('.json'))).toBe(true);
    expect([...context.configs.keys()]).not.toContain('/etc/xray/config.json');
    expect(context.processes).toHaveLength(2);
    expect(context.processes.every((process) => process.stopCalls === 1)).toBe(true);
    expect(context.removeTempDirectory).toHaveBeenCalledOnce();

    const privateKey = (
      (
        (serverConfig!.inbounds as Array<Record<string, unknown>>)[0]!.streamSettings as Record<
          string,
          unknown
        >
      ).realitySettings as Record<string, string>
    ).privateKey;
    expect(JSON.stringify(result)).not.toContain(privateKey);
  });

  it('reports TLS passed and Reality handshake failed as an incompatible business result', async () => {
    const context = fixture({
      probeThroughSocks: async () => ({ handshakePassed: false, trafficPassed: false }),
    });
    await expect(
      context.service.test({ serverName: 'example.com', target: 'example.com:443' }),
    ).resolves.toMatchObject({
      status: 'INCOMPATIBLE',
      tlsPrecheck: { status: 'PASSED' },
      realityHandshake: { status: 'FAILED' },
      endToEndTraffic: { status: 'NOT_RUN' },
    });
  });

  it('distinguishes a completed Reality handshake from failed end-to-end HTTPS traffic', async () => {
    const context = fixture({
      probeThroughSocks: async () => ({ handshakePassed: true, trafficPassed: false }),
    });
    await expect(
      context.service.test({ serverName: 'example.com', target: 'example.com:443' }),
    ).resolves.toMatchObject({
      status: 'INCOMPATIBLE',
      realityHandshake: { status: 'PASSED' },
      endToEndTraffic: { status: 'FAILED' },
    });
  });

  it('cleans processes and temporary files after timeout', async () => {
    const context = fixture({
      probeThroughSocks: (_port, signal) =>
        new Promise((resolve) => {
          signal.addEventListener(
            'abort',
            () => resolve({ handshakePassed: false, trafficPassed: false }),
            { once: true },
          );
        }),
    });
    context.service = new RealityTargetCompatibilityService({
      binary: '/configured/xray',
      timeoutMs: 10,
      runtime: context.runtime,
    });
    await expect(
      context.service.test({ serverName: 'example.com', target: 'example.com:443' }),
    ).rejects.toMatchObject({ code: 'REALITY_TARGET_TEST_TIMEOUT' });
    expect(context.processes.every((process) => process.stopCalls === 1)).toBe(true);
    expect(context.removeTempDirectory).toHaveBeenCalledOnce();
  });

  it('cleans processes and temporary files when the API request is cancelled', async () => {
    const context = fixture({
      probeThroughSocks: (_port, signal) =>
        new Promise((resolve) => {
          signal.addEventListener(
            'abort',
            () => resolve({ handshakePassed: false, trafficPassed: false }),
            { once: true },
          );
        }),
    });
    const controller = new AbortController();
    const running = context.service.test(
      { serverName: 'example.com', target: 'example.com:443' },
      controller.signal,
    );
    await vi.waitFor(() => expect(context.processes).toHaveLength(2));
    controller.abort();
    await expect(running).rejects.toMatchObject({ code: 'REALITY_TARGET_TEST_CANCELLED' });
    expect(context.processes.every((process) => process.stopCalls === 1)).toBe(true);
    expect(context.removeTempDirectory).toHaveBeenCalledOnce();
  });

  it('cleans temporary files when generated configs fail real validation', async () => {
    const context = fixture({
      validateConfig: async () => {
        throw new Error('synthetic config rejection with a private path');
      },
    });
    await expect(
      context.service.test({ serverName: 'example.com', target: 'example.com:443' }),
    ).rejects.toMatchObject({
      code: 'REALITY_TARGET_TEST_START_FAILED',
      message: 'Temporary Reality configuration validation failed',
    });
    expect(context.processes).toHaveLength(0);
    expect(context.removeTempDirectory).toHaveBeenCalledOnce();
  });

  it('cleans temporary files when the server process crashes', async () => {
    const context = fixture({
      startXray: () => {
        const process = new FakeProcess(false);
        context.processes.push(process);
        return process;
      },
    });
    await expect(
      context.service.test({ serverName: 'example.com', target: 'example.com:443' }),
    ).rejects.toMatchObject({ code: 'REALITY_TARGET_SERVER_START_FAILED' });
    expect(context.processes).toHaveLength(1);
    expect(context.processes[0]!.stopCalls).toBe(1);
    expect(context.removeTempDirectory).toHaveBeenCalledOnce();
  });

  it('cleans the server when the temporary client crashes', async () => {
    let starts = 0;
    const context = fixture({
      startXray: () => {
        starts += 1;
        const process = new FakeProcess(starts === 1);
        context.processes.push(process);
        return process;
      },
    });
    await expect(
      context.service.test({ serverName: 'example.com', target: 'example.com:443' }),
    ).rejects.toMatchObject({ code: 'REALITY_TARGET_CLIENT_START_FAILED' });
    expect(context.processes.every((process) => process.stopCalls === 1)).toBe(true);
    expect(context.removeTempDirectory).toHaveBeenCalledOnce();
  });

  it('allows only one compatibility test at a time', async () => {
    let release:
      ((value: { handshakePassed: boolean; trafficPassed: boolean }) => void) | undefined;
    const context = fixture({
      probeThroughSocks: () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    });
    const running = context.service.test({
      serverName: 'example.com',
      target: 'example.com:443',
    });
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    await expect(
      context.service.test({ serverName: 'example.com', target: 'example.com:443' }),
    ).rejects.toMatchObject({ code: 'REALITY_TARGET_TEST_BUSY' });
    release!({ handshakePassed: true, trafficPassed: true });
    await expect(running).resolves.toMatchObject({ status: 'COMPATIBLE' });
  });

  it('surfaces cleanup failure with an explicit safe error', async () => {
    const context = fixture({
      removeTempDirectory: async () => {
        throw new Error('private temporary path');
      },
    });
    await expect(
      context.service.test({ serverName: 'example.com', target: 'example.com:443' }),
    ).rejects.toMatchObject({
      code: 'REALITY_TARGET_TEST_CLEANUP_FAILED',
      message: 'Reality compatibility test cleanup failed',
    });
  });
});

describe('Reality compatibility config builder', () => {
  it('pins the target IP while retaining the requested server name', () => {
    const configs = buildRealityCompatibilityConfigs({
      serverName: 'dl.google.com',
      targetAddress: { address: '142.250.72.206', family: 4 },
      targetPort: 443,
      serverPort: 41_001,
      proxyPort: 41_002,
      uuid: '00000000-0000-4000-8000-000000000001',
      privateKey: 'temporary-private-key',
      publicKey: 'temporary-public-key',
      shortId: '0123456789abcdef',
    });
    expect(JSON.stringify(configs.server)).toContain('142.250.72.206:443');
    expect(JSON.stringify(configs.server)).not.toContain('0.0.0.0');
    expect(JSON.stringify(configs.client)).toContain('temporary-public-key');
    expect(JSON.stringify(configs.client)).toContain('"password"');
    expect(JSON.stringify(configs.client)).not.toContain('temporary-private-key');
  });
});
