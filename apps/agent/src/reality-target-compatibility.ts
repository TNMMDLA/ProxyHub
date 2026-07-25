import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { connect, createServer, isIP } from 'node:net';
import type { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect as connectTls } from 'node:tls';
import { domainToASCII } from 'node:url';
import type { RealityTargetCompatibilityResult } from '@proxyhub/shared';
import {
  buildRealityCompatibilityConfigs,
  generateRealityCredentials,
  getXrayVersion,
  isBlockedAddress,
  systemResolver,
  testXrayConfig,
  type ResolvedAddress,
  type ResolveHostname,
} from '@proxyhub/xray-manager';

export type RealityCompatibilityErrorCode =
  | 'REALITY_TARGET_INVALID'
  | 'REALITY_TARGET_DNS_FAILED'
  | 'REALITY_TARGET_BLOCKED_ADDRESS'
  | 'REALITY_TARGET_TEST_BUSY'
  | 'REALITY_TARGET_TEST_CANCELLED'
  | 'REALITY_TARGET_TEST_START_FAILED'
  | 'REALITY_TARGET_SERVER_START_FAILED'
  | 'REALITY_TARGET_CLIENT_START_FAILED'
  | 'REALITY_TARGET_TEST_TIMEOUT'
  | 'REALITY_TARGET_TEST_INTERNAL_ERROR'
  | 'REALITY_TARGET_TEST_CLEANUP_FAILED';

export class RealityCompatibilityError extends Error {
  constructor(
    readonly code: RealityCompatibilityErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'RealityCompatibilityError';
  }
}

interface ParsedTarget {
  hostname: string;
  port: number;
  normalized: string;
}

export interface ManagedXrayProcess {
  isAlive(): boolean;
  stop(): Promise<void>;
}

export interface SocksProbeResult {
  handshakePassed: boolean;
  trafficPassed: boolean;
}

export interface RealityCompatibilityRuntime {
  resolve: ResolveHostname;
  version(binary: string): Promise<string>;
  tlsPrecheck(options: {
    address: ResolvedAddress;
    port: number;
    serverName: string;
    signal: AbortSignal;
  }): Promise<boolean>;
  allocatePort(signal: AbortSignal): Promise<number>;
  createTempDirectory(): Promise<string>;
  writeConfig(path: string, config: Record<string, unknown>): Promise<void>;
  validateConfig(binary: string, path: string): Promise<string>;
  startXray(binary: string, configPath: string): ManagedXrayProcess;
  waitForPort(port: number, process: ManagedXrayProcess, signal: AbortSignal): Promise<void>;
  probeThroughSocks(port: number, signal: AbortSignal): Promise<SocksProbeResult>;
  removeTempDirectory(path: string): Promise<void>;
}

export interface RealityCompatibilityServiceOptions {
  binary: string;
  timeoutMs?: number;
  runtime?: Partial<RealityCompatibilityRuntime>;
}

const INVALID_TARGET_MESSAGE = 'Reality target must use hostname:port without a URL or path';
const PROBE_HOST = 'www.cloudflare.com';
const PROBE_PATH = '/cdn-cgi/trace';

function validHostname(value: string): boolean {
  if (value.length < 1 || value.length > 253 || value.endsWith('.')) return false;
  return value
    .split('.')
    .every(
      (label) =>
        label.length >= 1 && label.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label),
    );
}

export function parseRealityServerName(raw: string): string {
  const value = domainToASCII(raw.trim()).toLowerCase();
  if (
    !value ||
    value === 'localhost' ||
    isIP(value) !== 0 ||
    !validHostname(value) ||
    /[/?#@:\s]/.test(value)
  ) {
    throw new RealityCompatibilityError(
      'REALITY_TARGET_INVALID',
      'Reality server name must be a public DNS hostname',
    );
  }
  return value;
}

export function parseRealityTarget(raw: string): ParsedTarget {
  const value = raw.trim();
  if (
    !value ||
    value.includes('://') ||
    /[/?#@\s]/.test(value) ||
    value.toLowerCase().startsWith('localhost:')
  ) {
    throw new RealityCompatibilityError('REALITY_TARGET_INVALID', INVALID_TARGET_MESSAGE);
  }

  let rawHostname: string;
  let rawPort: string;
  if (value.startsWith('[')) {
    const closingBracket = value.indexOf(']');
    if (closingBracket < 2 || value[closingBracket + 1] !== ':') {
      throw new RealityCompatibilityError('REALITY_TARGET_INVALID', INVALID_TARGET_MESSAGE);
    }
    rawHostname = value.slice(1, closingBracket);
    rawPort = value.slice(closingBracket + 2);
  } else {
    const colon = value.lastIndexOf(':');
    if (colon <= 0 || value.indexOf(':') !== colon) {
      throw new RealityCompatibilityError('REALITY_TARGET_INVALID', INVALID_TARGET_MESSAGE);
    }
    rawHostname = value.slice(0, colon);
    rawPort = value.slice(colon + 1);
  }

  if (!/^\d{1,5}$/.test(rawPort)) {
    throw new RealityCompatibilityError('REALITY_TARGET_INVALID', INVALID_TARGET_MESSAGE);
  }
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new RealityCompatibilityError('REALITY_TARGET_INVALID', INVALID_TARGET_MESSAGE);
  }

  const literalFamily = isIP(rawHostname);
  const hostname = literalFamily
    ? rawHostname.toLowerCase()
    : domainToASCII(rawHostname).toLowerCase();
  if (!hostname || (!literalFamily && !validHostname(hostname))) {
    throw new RealityCompatibilityError('REALITY_TARGET_INVALID', INVALID_TARGET_MESSAGE);
  }
  return {
    hostname,
    port,
    normalized: `${literalFamily === 6 ? `[${hostname}]` : hostname}:${String(port)}`,
  };
}

function abortError(): Error {
  return new Error('Operation aborted');
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(abortError());
    const timer = setTimeout(resolve, milliseconds);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(abortError());
      },
      { once: true },
    );
  });
}

async function allocateLoopbackPort(signal: AbortSignal): Promise<number> {
  if (signal.aborted) throw abortError();
  return new Promise((resolve, reject) => {
    const server = createServer();
    const onAbort = () => server.close(() => reject(abortError()));
    signal.addEventListener('abort', onAbort, { once: true });
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close((error) => {
        signal.removeEventListener('abort', onAbort);
        if (error || port === 0) reject(error ?? new Error('Unable to allocate loopback port'));
        else resolve(port);
      });
    });
  });
}

async function tlsPrecheck(options: {
  address: ResolvedAddress;
  port: number;
  serverName: string;
  signal: AbortSignal;
}): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connectTls({
      host: options.address.address,
      port: options.port,
      servername: options.serverName,
      rejectUnauthorized: true,
    });
    const finish = (result: boolean) => {
      options.signal.removeEventListener('abort', onAbort);
      socket.removeAllListeners();
      socket.destroy();
      resolve(result);
    };
    const onAbort = () => finish(false);
    options.signal.addEventListener('abort', onAbort, { once: true });
    socket.setTimeout(5_000, () => finish(false));
    socket.once('secureConnect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

class NativeXrayProcess implements ManagedXrayProcess {
  private readonly exit: Promise<void>;
  private failed = false;

  constructor(private readonly child: ChildProcessWithoutNullStreams) {
    this.exit = new Promise((resolve) => {
      child.once('close', () => resolve());
      child.once('error', () => {
        this.failed = true;
        resolve();
      });
    });
    child.stdout.resume();
    child.stderr.resume();
  }

  isAlive(): boolean {
    return !this.failed && this.child.exitCode === null && this.child.signalCode === null;
  }

  async stop(): Promise<void> {
    if (!this.isAlive()) {
      await this.exit;
      return;
    }
    this.child.kill('SIGTERM');
    await Promise.race([this.exit, new Promise((resolve) => setTimeout(resolve, 1_000))]);
    if (this.isAlive()) {
      this.child.kill('SIGKILL');
      await this.exit;
    }
  }
}

function startXray(binary: string, configPath: string): ManagedXrayProcess {
  return new NativeXrayProcess(
    spawn(binary, ['run', '-config', configPath], {
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    }),
  );
}

async function waitForLoopbackPort(
  port: number,
  process: ManagedXrayProcess,
  signal: AbortSignal,
): Promise<void> {
  while (!signal.aborted) {
    if (!process.isAlive()) throw new Error('Temporary Xray process exited before listening');
    const listening = await new Promise<boolean>((resolve) => {
      const socket = connect({ host: '127.0.0.1', port });
      const finish = (result: boolean) => {
        socket.removeAllListeners();
        socket.destroy();
        resolve(result);
      };
      socket.setTimeout(200, () => finish(false));
      socket.once('connect', () => finish(true));
      socket.once('error', () => finish(false));
    });
    if (listening) return;
    await delay(100, signal);
  }
  throw abortError();
}

interface SocketBuffer {
  value: Buffer;
}

function readExactly(
  socket: Socket,
  length: number,
  state: SocketBuffer,
  signal: AbortSignal,
): Promise<Buffer> {
  if (state.value.length >= length) {
    const result = state.value.subarray(0, length);
    state.value = state.value.subarray(length);
    return Promise.resolve(result);
  }
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      socket.pause();
      socket.off('data', onData);
      socket.off('error', onError);
      socket.off('close', onClose);
      signal.removeEventListener('abort', onAbort);
    };
    const fail = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onData = (chunk: Buffer) => {
      state.value = Buffer.concat([state.value, chunk]);
      if (state.value.length < length) return;
      const result = state.value.subarray(0, length);
      state.value = state.value.subarray(length);
      cleanup();
      resolve(result);
    };
    const onError = () => fail(new Error('SOCKS proxy connection failed'));
    const onClose = () => fail(new Error('SOCKS proxy closed the connection'));
    const onAbort = () => fail(abortError());
    socket.on('data', onData);
    socket.once('error', onError);
    socket.once('close', onClose);
    signal.addEventListener('abort', onAbort, { once: true });
    socket.resume();
  });
}

async function connectSocksTunnel(port: number, signal: AbortSignal): Promise<Socket> {
  const socket = connect({ host: '127.0.0.1', port });
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      socket.destroy();
      reject(abortError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
    socket.setTimeout(5_000, () => socket.destroy(new Error('SOCKS connection timed out')));
    socket.once('connect', () => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    });
    socket.once('error', reject);
  });

  const state: SocketBuffer = { value: Buffer.alloc(0) };
  socket.write(Buffer.from([0x05, 0x01, 0x00]));
  const greeting = await readExactly(socket, 2, state, signal);
  if (greeting[0] !== 0x05 || greeting[1] !== 0x00) {
    socket.destroy();
    throw new Error('SOCKS proxy rejected unauthenticated negotiation');
  }

  const host = Buffer.from(PROBE_HOST, 'ascii');
  socket.write(
    Buffer.concat([
      Buffer.from([0x05, 0x01, 0x00, 0x03, host.length]),
      host,
      Buffer.from([0x01, 0xbb]),
    ]),
  );
  const response = await readExactly(socket, 4, state, signal);
  if (response[0] !== 0x05 || response[1] !== 0x00) {
    socket.destroy();
    throw new Error('Reality outbound could not establish the SOCKS destination');
  }
  const addressLength =
    response[3] === 0x01
      ? 4
      : response[3] === 0x04
        ? 16
        : response[3] === 0x03
          ? (await readExactly(socket, 1, state, signal))[0]!
          : 0;
  if (addressLength === 0) {
    socket.destroy();
    throw new Error('SOCKS proxy returned an invalid address type');
  }
  await readExactly(socket, addressLength + 2, state, signal);
  socket.setTimeout(0);
  socket.pause();
  return socket;
}

async function probeThroughSocks(port: number, signal: AbortSignal): Promise<SocksProbeResult> {
  let tunnel: Socket;
  try {
    tunnel = await connectSocksTunnel(port, signal);
  } catch {
    return { handshakePassed: false, trafficPassed: false };
  }

  return new Promise((resolve) => {
    const socket = connectTls({
      socket: tunnel,
      servername: PROBE_HOST,
      rejectUnauthorized: true,
    });
    let response = '';
    const finish = (trafficPassed: boolean) => {
      signal.removeEventListener('abort', onAbort);
      socket.removeAllListeners();
      socket.destroy();
      resolve({ handshakePassed: true, trafficPassed });
    };
    const onAbort = () => finish(false);
    signal.addEventListener('abort', onAbort, { once: true });
    socket.setTimeout(5_000, () => finish(false));
    socket.once('secureConnect', () => {
      socket.write(
        `GET ${PROBE_PATH} HTTP/1.1\r\nHost: ${PROBE_HOST}\r\nConnection: close\r\n\r\n`,
      );
    });
    socket.on('data', (chunk: Buffer) => {
      response += chunk.toString('utf8');
      if (response.includes('\r\n\r\n')) {
        finish(/^HTTP\/1\.[01] [23]\d\d /i.test(response));
      }
    });
    socket.once('error', () => finish(false));
    socket.once('end', () => finish(/^HTTP\/1\.[01] [23]\d\d /i.test(response)));
  });
}

const nativeRuntime: RealityCompatibilityRuntime = {
  resolve: systemResolver,
  version: getXrayVersion,
  tlsPrecheck,
  allocatePort: allocateLoopbackPort,
  createTempDirectory: () => mkdtemp(join(tmpdir(), 'proxyhub-reality-compat-')),
  writeConfig: (path, config) => writeFile(path, JSON.stringify(config, null, 2), { mode: 0o600 }),
  validateConfig: testXrayConfig,
  startXray,
  waitForPort: waitForLoopbackPort,
  probeThroughSocks,
  removeTempDirectory: (path) => rm(path, { recursive: true, force: true }),
};

function result(
  input: {
    target: string;
    serverName: string;
    xrayVersion: string;
    startedAt: number;
  },
  stages: Pick<
    RealityTargetCompatibilityResult,
    'status' | 'tlsPrecheck' | 'realityHandshake' | 'endToEndTraffic' | 'diagnostics'
  >,
): RealityTargetCompatibilityResult {
  return {
    ...stages,
    target: input.target,
    serverName: input.serverName,
    xrayVersion: input.xrayVersion,
    durationMs: Date.now() - input.startedAt,
  };
}

export class RealityTargetCompatibilityService {
  private readonly runtime: RealityCompatibilityRuntime;
  private readonly timeoutMs: number;
  private busy = false;
  private temporaryProcessCount = 0;
  private temporaryDirectoryCount = 0;

  constructor(private readonly options: RealityCompatibilityServiceOptions) {
    this.timeoutMs = options.timeoutMs ?? 20_000;
    this.runtime = { ...nativeRuntime, ...options.runtime };
  }

  diagnosticsState(): {
    available: true;
    busy: boolean;
    temporaryProcessCount: number;
    temporaryDirectoryCount: number;
  } {
    return {
      available: true,
      busy: this.busy,
      temporaryProcessCount: this.temporaryProcessCount,
      temporaryDirectoryCount: this.temporaryDirectoryCount,
    };
  }

  async test(
    input: {
      serverName: string;
      target: string;
    },
    externalSignal?: AbortSignal,
  ): Promise<RealityTargetCompatibilityResult> {
    if (this.busy) {
      throw new RealityCompatibilityError(
        'REALITY_TARGET_TEST_BUSY',
        'Another Reality compatibility test is already running',
      );
    }
    this.busy = true;
    const controller = new AbortController();
    let timedOut = false;
    const onExternalAbort = () => controller.abort();
    externalSignal?.addEventListener('abort', onExternalAbort, { once: true });
    if (externalSignal?.aborted) controller.abort();
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.timeoutMs);
    try {
      return await this.run(input, controller.signal);
    } catch (error) {
      if (controller.signal.aborted) {
        throw new RealityCompatibilityError(
          timedOut ? 'REALITY_TARGET_TEST_TIMEOUT' : 'REALITY_TARGET_TEST_CANCELLED',
          timedOut
            ? 'Reality compatibility test timed out'
            : 'Reality compatibility test cancelled',
        );
      }
      if (error instanceof RealityCompatibilityError) throw error;
      throw new RealityCompatibilityError(
        'REALITY_TARGET_TEST_INTERNAL_ERROR',
        'Reality compatibility test failed unexpectedly',
      );
    } finally {
      clearTimeout(timeout);
      externalSignal?.removeEventListener('abort', onExternalAbort);
      this.busy = false;
    }
  }

  private async run(
    input: { serverName: string; target: string },
    signal: AbortSignal,
  ): Promise<RealityTargetCompatibilityResult> {
    const startedAt = Date.now();
    const serverName = parseRealityServerName(input.serverName);
    const target = parseRealityTarget(input.target);
    const literalFamily = isIP(target.hostname);
    const addresses = literalFamily
      ? [{ address: target.hostname, family: literalFamily as 4 | 6 }]
      : await this.runtime.resolve(target.hostname).catch(() => []);
    if (signal.aborted) throw abortError();
    if (addresses.length === 0) {
      throw new RealityCompatibilityError(
        'REALITY_TARGET_DNS_FAILED',
        'Reality target could not be resolved',
      );
    }
    if (addresses.some(({ address }) => isBlockedAddress(address))) {
      throw new RealityCompatibilityError(
        'REALITY_TARGET_BLOCKED_ADDRESS',
        'Reality target resolved to a non-public address',
      );
    }
    const selected = [...addresses].sort((left, right) => left.family - right.family)[0]!;
    const xrayVersion = await this.runtime.version(this.options.binary);
    if (signal.aborted) throw abortError();
    const base = { target: target.normalized, serverName, xrayVersion, startedAt };
    const tlsPassed = await this.runtime.tlsPrecheck({
      address: selected,
      port: target.port,
      serverName,
      signal,
    });
    if (signal.aborted) throw abortError();
    if (!tlsPassed) {
      return result(base, {
        status: 'INCOMPATIBLE',
        tlsPrecheck: { status: 'FAILED' },
        realityHandshake: { status: 'NOT_RUN' },
        endToEndTraffic: { status: 'NOT_RUN' },
        diagnostics: ['TLS precheck failed for the validated public target address.'],
      });
    }

    let directory: string | undefined;
    const processes: ManagedXrayProcess[] = [];
    let operationResult: RealityTargetCompatibilityResult | undefined;
    let operationError: unknown;
    try {
      operationResult = await (async () => {
        directory = await this.runtime.createTempDirectory();
        this.temporaryDirectoryCount += 1;
        const credentials = generateRealityCredentials();
        const serverPort = await this.runtime.allocatePort(signal);
        let proxyPort = await this.runtime.allocatePort(signal);
        while (proxyPort === serverPort) proxyPort = await this.runtime.allocatePort(signal);
        const configs = buildRealityCompatibilityConfigs({
          serverName,
          targetAddress: selected,
          targetPort: target.port,
          serverPort,
          proxyPort,
          uuid: credentials.uuid,
          privateKey: credentials.privateKey,
          publicKey: credentials.publicKey,
          shortId: credentials.shortId,
        });
        const serverConfigPath = join(directory, `reality-server-${randomUUID()}.json`);
        const clientConfigPath = join(directory, `reality-client-${randomUUID()}.json`);
        await Promise.all([
          this.runtime.writeConfig(serverConfigPath, configs.server),
          this.runtime.writeConfig(clientConfigPath, configs.client),
        ]);
        try {
          await Promise.all([
            this.runtime.validateConfig(this.options.binary, serverConfigPath),
            this.runtime.validateConfig(this.options.binary, clientConfigPath),
          ]);
        } catch {
          throw new RealityCompatibilityError(
            'REALITY_TARGET_TEST_START_FAILED',
            'Temporary Reality configuration validation failed',
          );
        }

        let server: ManagedXrayProcess;
        try {
          server = this.runtime.startXray(this.options.binary, serverConfigPath);
          processes.push(server);
          this.temporaryProcessCount += 1;
          await this.runtime.waitForPort(serverPort, server, signal);
        } catch {
          throw new RealityCompatibilityError(
            'REALITY_TARGET_SERVER_START_FAILED',
            'Temporary Reality server could not start',
          );
        }

        let client: ManagedXrayProcess;
        try {
          client = this.runtime.startXray(this.options.binary, clientConfigPath);
          processes.push(client);
          this.temporaryProcessCount += 1;
          await this.runtime.waitForPort(proxyPort, client, signal);
        } catch {
          throw new RealityCompatibilityError(
            'REALITY_TARGET_CLIENT_START_FAILED',
            'Temporary Reality client could not start',
          );
        }

        const probe = await this.runtime.probeThroughSocks(proxyPort, signal);
        if (signal.aborted) throw abortError();
        if (!probe.handshakePassed) {
          return result(base, {
            status: 'INCOMPATIBLE',
            tlsPrecheck: { status: 'PASSED' },
            realityHandshake: { status: 'FAILED' },
            endToEndTraffic: { status: 'NOT_RUN' },
            diagnostics: ['TLS precheck passed, but the end-to-end Reality handshake failed.'],
          });
        }
        if (!probe.trafficPassed) {
          return result(base, {
            status: 'INCOMPATIBLE',
            tlsPrecheck: { status: 'PASSED' },
            realityHandshake: { status: 'PASSED' },
            endToEndTraffic: { status: 'FAILED' },
            diagnostics: ['Reality handshake passed, but the external HTTPS probe failed.'],
          });
        }
        return result(base, {
          status: 'COMPATIBLE',
          tlsPrecheck: { status: 'PASSED' },
          realityHandshake: { status: 'PASSED' },
          endToEndTraffic: { status: 'PASSED' },
          diagnostics: [],
        });
      })();
    } catch (error) {
      operationError = error;
    }
    const cleanup = await Promise.allSettled([
      ...processes.reverse().map((process) => process.stop()),
      ...(directory ? [this.runtime.removeTempDirectory(directory)] : []),
    ]);
    this.temporaryProcessCount = Math.max(0, this.temporaryProcessCount - processes.length);
    if (directory) this.temporaryDirectoryCount = Math.max(0, this.temporaryDirectoryCount - 1);
    if (cleanup.some((entry) => entry.status === 'rejected')) {
      throw new RealityCompatibilityError(
        'REALITY_TARGET_TEST_CLEANUP_FAILED',
        'Reality compatibility test cleanup failed',
      );
    }
    if (operationError !== undefined) {
      throw operationError instanceof Error
        ? operationError
        : new RealityCompatibilityError(
            'REALITY_TARGET_TEST_INTERNAL_ERROR',
            'Reality compatibility test failed unexpectedly',
          );
    }
    if (!operationResult) {
      throw new RealityCompatibilityError(
        'REALITY_TARGET_TEST_INTERNAL_ERROR',
        'Reality compatibility test did not produce a result',
      );
    }
    return operationResult;
  }
}
