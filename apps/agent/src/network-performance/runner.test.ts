import { describe, expect, it, vi } from 'vitest';
import type { NetworkPerformanceTarget } from '@proxyhub/network-performance-core';
import {
  NetworkPerformanceError,
  NetworkPerformanceRunner,
  type NetworkPerformanceNodeInput,
  type PerformanceRunnerRuntime,
} from './runner.js';
import type { ManagedTemporaryXray } from './network-runtime.js';

class FakeProcess implements ManagedTemporaryXray {
  stopped = false;
  isAlive() {
    return !this.stopped;
  }
  async stop() {
    this.stopped = true;
  }
}

const targets: NetworkPerformanceTarget[] = [
  {
    id: 'one',
    label: 'Target One',
    smallRequestUrl: 'https://one.example/small',
    downloadUrl: 'https://one.example/download',
    enabled: true,
    maxDownloadBytes: 1024 * 1024,
  },
  {
    id: 'two',
    label: 'Target Two',
    smallRequestUrl: 'https://two.example/small',
    downloadUrl: 'https://two.example/download',
    enabled: true,
    maxDownloadBytes: 1024 * 1024,
  },
];

const node: NetworkPerformanceNodeInput = {
  address: '127.0.0.1',
  port: 443,
  uuid: '00000000-0000-4000-8000-000000000040',
  flow: 'xtls-rprx-vision',
  sni: 'target.example',
  publicKey: 'PUBLIC-KEY-SENTINEL',
  shortId: 'SHORT-ID-SENTINEL',
  fingerprint: 'chrome',
  enabled: true,
  protocol: 'VLESS',
  transport: 'TCP',
  security: 'REALITY',
  name: 'Fixture Node',
  serverName: 'Fixture Server',
  serverRegion: 'Test',
  realityTarget: 'target.example:443',
  proxyhubVersion: '0.4.0-dev',
  gitSha: 'abcdef123456',
  deployMode: 'source',
};

function context(
  overrides: Partial<PerformanceRunnerRuntime> = {},
  optionOverrides: Partial<ConstructorParameters<typeof NetworkPerformanceRunner>[0]> = {},
) {
  const process = new FakeProcess();
  const cleanupDirectory = vi.fn(async () => undefined);
  const runtime: PerformanceRunnerRuntime = {
    version: async () => 'Xray 26.5.9',
    allocatePort: async () => 41_000,
    createDirectory: async () => '/tmp/proxyhub-network-performance-fixture',
    writeConfig: async () => '/tmp/proxyhub-network-performance-fixture/config.json',
    startXray: async () => process,
    waitForPort: async () => undefined,
    measure: async (input) => ({
      statusCode: 200,
      bytes: input.proxyPort === undefined ? 1_000_000 : 900_000,
      durationMs: 100,
      firstByteMs: input.proxyPort === undefined ? 10 : 12,
    }),
    cleanupDirectory,
    ...overrides,
  };
  const runner = new NetworkPerformanceRunner({
    binary: '/configured/xray',
    targets,
    globalTimeoutMs: 2_000,
    targetTimeoutMs: 1_000,
    smallRequestSamples: 2,
    downloadSamples: 2,
    runtime,
    ...optionOverrides,
  });
  return { runner, process, cleanupDirectory };
}

async function completed(runner: NetworkPerformanceRunner, id: string) {
  await vi.waitFor(() => expect(runner.get(id)?.status).not.toBe('RUNNING'));
  return runner.get(id)!;
}

function expectPerformanceError(action: () => unknown, code: NetworkPerformanceError['code']) {
  try {
    action();
    throw new Error(`Expected ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(NetworkPerformanceError);
    expect((error as NetworkPerformanceError).code).toBe(code);
  }
}

describe('network performance runner', () => {
  it('runs all targets sequentially and returns only sanitized results', async () => {
    const { runner, process, cleanupDirectory } = context();
    const started = runner.start(node);
    const result = await completed(runner, started.id);
    expect(result.status).toBe('COMPLETED');
    expect(result.result?.targets).toHaveLength(2);
    expect(result.result?.medianDirectMbps).toBe(80);
    expect(result.result?.medianTunnelMbps).toBe(72);
    expect(result.result?.score.throughput).toBe(90);
    const serialized = JSON.stringify(result);
    for (const secret of [node.uuid, node.publicKey, node.shortId]) {
      expect(serialized).not.toContain(secret);
    }
    expect(process.stopped).toBe(true);
    expect(cleanupDirectory).toHaveBeenCalledOnce();
  });

  it('rejects concurrent tests with a stable 409-compatible code', () => {
    const { runner } = context({
      measure: async (input) =>
        new Promise((resolve) => {
          input.signal.addEventListener(
            'abort',
            () => resolve({ statusCode: 200, bytes: 1, durationMs: 1, firstByteMs: 1 }),
            { once: true },
          );
        }),
    });
    const first = runner.start(node);
    expectPerformanceError(() => runner.start(node), 'NETWORK_PERFORMANCE_TEST_BUSY');
    runner.cancel(first.id);
  });

  it('cancels active network work and releases the lock', async () => {
    const { runner, cleanupDirectory } = context(
      {
        measure: async (input) =>
          new Promise((_resolve, reject) => {
            if (input.signal.aborted) {
              reject(new Error('aborted'));
              return;
            }
            input.signal.addEventListener('abort', () => reject(new Error('aborted')), {
              once: true,
            });
          }),
      },
      { targets: [targets[0]!] },
    );
    const started = runner.start(node);
    await vi.waitFor(() => expect(runner.get(started.id)?.progress.stage).toBe('TESTING_TARGET'));
    expect(runner.cancel(started.id)).toBe(true);
    expect((await completed(runner, started.id)).status).toBe('CANCELLED');
    expect(cleanupDirectory).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(runner.capability().busy).toBe(false));
  });

  it('applies the global timeout and cleans resources', async () => {
    const { runner, cleanupDirectory } = context(
      {
        measure: async (input) =>
          new Promise((_resolve, reject) => {
            if (input.signal.aborted) {
              reject(new Error('aborted'));
              return;
            }
            input.signal.addEventListener('abort', () => reject(new Error('aborted')), {
              once: true,
            });
          }),
      },
      { globalTimeoutMs: 20 },
    );
    const started = runner.start(node);
    const result = await completed(runner, started.id);
    expect(result).toMatchObject({
      status: 'FAILED',
      errorCode: 'NETWORK_PERFORMANCE_TIMEOUT',
    });
    expect(cleanupDirectory).toHaveBeenCalledOnce();
  });

  it('reports cleanup failure without leaking its path or child output', async () => {
    const { runner } = context({
      cleanupDirectory: async () => {
        throw new Error('/private/path cleanup sentinel');
      },
    });
    const result = await completed(runner, runner.start(node).id);
    expect(result).toMatchObject({
      status: 'FAILED',
      errorCode: 'NETWORK_PERFORMANCE_CLEANUP_FAILED',
    });
    expect(JSON.stringify(result)).not.toContain('/private/path');
  });

  it('retains successful targets when one target fails', async () => {
    const { runner } = context({
      measure: async (input) => {
        if (input.url.includes('two.example')) throw new Error('unreachable');
        return {
          statusCode: 200,
          bytes: input.proxyPort === undefined ? 1_000_000 : 900_000,
          durationMs: 100,
          firstByteMs: 10,
        };
      },
    });
    const result = await completed(runner, runner.start(node).id);
    expect(result.status).toBe('PARTIAL');
    expect(result.result?.targets[0]?.success).toBe(true);
    expect(result.result?.targets[1]?.success).toBe(false);
  });

  it('rejects disabled and unsupported nodes before creating resources', () => {
    const { runner } = context();
    expectPerformanceError(
      () => runner.start({ ...node, enabled: false }),
      'NETWORK_PERFORMANCE_NODE_DISABLED',
    );
    expectPerformanceError(
      () => runner.start({ ...node, protocol: 'VMESS' }),
      'NETWORK_PERFORMANCE_UNSUPPORTED_NODE',
    );
  });

  it('rejects an empty target registry without inventing benchmark data', () => {
    const { runner } = context({}, { targets: [] });
    expect(runner.capability()).toMatchObject({ available: false, targetCount: 0 });
    expectPerformanceError(() => runner.start(node), 'NETWORK_PERFORMANCE_TARGET_INVALID');
  });
});
