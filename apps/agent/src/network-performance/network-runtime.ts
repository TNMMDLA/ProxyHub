import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { chmod, lstat, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { connect, createServer, isIP } from 'node:net';
import type { LookupFunction, Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { connect as connectTls } from 'node:tls';
import type { TLSSocket } from 'node:tls';
import { request as httpsRequest } from 'node:https';
import type { ResolvedAddress, ResolveHostname } from '@proxyhub/xray-manager';
import { isBlockedAddress, systemResolver, testXrayConfig } from '@proxyhub/xray-manager';

const TEMP_PREFIX = 'proxyhub-network-performance-';

function abortError(): Error {
  const error = new Error('Operation aborted');
  error.name = 'AbortError';
  return error;
}

export interface ManagedTemporaryXray {
  isAlive(): boolean;
  stop(): Promise<void>;
}

class NativeTemporaryXray implements ManagedTemporaryXray {
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

export async function allocateLoopbackPort(signal: AbortSignal): Promise<number> {
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

export async function createSecureTempDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), TEMP_PREFIX));
  await chmod(directory, 0o700);
  return directory;
}

export async function writeSecureXrayConfig(
  directory: string,
  config: Record<string, unknown>,
): Promise<string> {
  const path = join(directory, 'config.json');
  await writeFile(path, JSON.stringify(config, null, 2), { mode: 0o600 });
  await chmod(path, 0o600);
  return path;
}

export async function startTemporaryXray(
  binary: string,
  configPath: string,
): Promise<ManagedTemporaryXray> {
  await testXrayConfig(binary, configPath);
  return new NativeTemporaryXray(
    spawn(binary, ['run', '-config', configPath], {
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    }),
  );
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

export async function waitForLoopbackPort(
  port: number,
  process: ManagedTemporaryXray,
  signal: AbortSignal,
): Promise<void> {
  while (!signal.aborted) {
    if (!process.isAlive()) throw new Error('Temporary Xray exited before opening SOCKS');
    const listening = await new Promise<boolean>((resolve) => {
      const socket = connect({ host: '127.0.0.1', port });
      const finish = (value: boolean) => {
        socket.removeAllListeners();
        socket.destroy();
        resolve(value);
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

function ipv6Bytes(address: string): Buffer {
  let normalized = address.split('%')[0]!.toLowerCase();
  const ipv4Tail = normalized.match(/(?:^|:)(\d+\.\d+\.\d+\.\d+)$/u)?.[1];
  if (ipv4Tail) {
    const octets = ipv4Tail.split('.').map(Number);
    const replacement = `${((octets[0]! << 8) | octets[1]!).toString(16)}:${(
      (octets[2]! << 8) |
      octets[3]!
    ).toString(16)}`;
    normalized = normalized.slice(0, -ipv4Tail.length) + replacement;
  }
  const [left = '', right = ''] = normalized.split('::');
  const leftParts = left.split(':').filter(Boolean);
  const rightParts = right.split(':').filter(Boolean);
  const zeros = normalized.includes('::') ? 8 - leftParts.length - rightParts.length : 0;
  const groups = [...leftParts, ...Array.from({ length: zeros }, () => '0'), ...rightParts];
  if (groups.length !== 8) throw new Error('Invalid IPv6 destination');
  const bytes = Buffer.alloc(16);
  groups.forEach((group, index) => bytes.writeUInt16BE(Number.parseInt(group, 16), index * 2));
  return bytes;
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
    const onAbort = () => {
      socket.destroy();
      fail(abortError());
    };
    socket.on('data', onData);
    socket.once('error', onError);
    socket.once('close', onClose);
    signal.addEventListener('abort', onAbort, { once: true });
    socket.resume();
  });
}

export async function connectSocksSocket(
  proxyPort: number,
  destination: ResolvedAddress,
  destinationPort: number,
  signal: AbortSignal,
): Promise<Socket> {
  const socket = connect({ host: '127.0.0.1', port: proxyPort });
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

  const address =
    destination.family === 4
      ? Buffer.concat([
          Buffer.from([0x01]),
          Buffer.from(destination.address.split('.').map(Number)),
        ])
      : Buffer.concat([Buffer.from([0x04]), ipv6Bytes(destination.address)]);
  socket.write(
    Buffer.concat([
      Buffer.from([0x05, 0x01, 0x00]),
      address,
      Buffer.from([destinationPort >> 8, destinationPort & 0xff]),
    ]),
  );
  const response = await readExactly(socket, 4, state, signal);
  if (response[0] !== 0x05 || response[1] !== 0x00) {
    socket.destroy();
    throw new Error('SOCKS proxy could not establish the destination');
  }
  const responseAddressLength =
    response[3] === 0x01
      ? 4
      : response[3] === 0x04
        ? 16
        : response[3] === 0x03
          ? (await readExactly(socket, 1, state, signal))[0]!
          : 0;
  if (responseAddressLength === 0) {
    socket.destroy();
    throw new Error('SOCKS proxy returned an invalid address');
  }
  await readExactly(socket, responseAddressLength + 2, state, signal);
  socket.setTimeout(0);
  socket.pause();
  return socket;
}

export interface SafeHttpsRuntimeOptions {
  resolver?: ResolveHostname;
  allowPrivateTargets?: boolean;
  insecureTlsForTesting?: boolean;
  maxRedirects?: number;
  onDiagnostic?: (stage: string) => void;
}

export interface HttpsMeasurement {
  statusCode: number;
  bytes: number;
  durationMs: number;
  firstByteMs: number;
}

/**
 * Pins a request to the address that passed validation while honoring both
 * Node lookup callback shapes. Node 24 requests an address array when
 * autoSelectFamily sets `all: true`.
 */
export function createPinnedLookup(selected: ResolvedAddress): LookupFunction {
  return (_hostname, options, callback) => {
    if (options.all) {
      callback(null, [{ address: selected.address, family: selected.family }]);
      return;
    }
    callback(null, selected.address, selected.family);
  };
}

export async function validateNetworkPerformanceUrl(
  value: string,
  resolver: ResolveHostname,
  allowPrivateTargets: boolean,
): Promise<{ url: URL; addresses: ResolvedAddress[] }> {
  const url = new URL(value);
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.hostname.toLowerCase() === 'localhost'
  ) {
    throw new Error('NETWORK_PERFORMANCE_TARGET_INVALID');
  }
  const literalFamily = isIP(url.hostname);
  const addresses = literalFamily
    ? [{ address: url.hostname, family: literalFamily as 4 | 6 }]
    : await resolver(url.hostname);
  if (
    addresses.length === 0 ||
    (!allowPrivateTargets && addresses.some(({ address }) => isBlockedAddress(address)))
  ) {
    throw new Error('NETWORK_PERFORMANCE_TARGET_INVALID');
  }
  return { url, addresses };
}

export async function measureHttps(
  input: {
    url: string;
    signal: AbortSignal;
    maxBytes: number;
    proxyPort?: number;
  },
  options: SafeHttpsRuntimeOptions = {},
): Promise<HttpsMeasurement> {
  const resolver = options.resolver ?? systemResolver;
  const maxRedirects = options.maxRedirects ?? 3;
  let currentUrl = input.url;
  for (let redirect = 0; redirect <= maxRedirects; redirect += 1) {
    if (input.signal.aborted) throw abortError();
    const validated = await validateNetworkPerformanceUrl(
      currentUrl,
      resolver,
      options.allowPrivateTargets ?? false,
    );
    const selected = [...validated.addresses].sort((left, right) => left.family - right.family)[0]!;
    const result = await requestOnce(
      validated.url,
      selected,
      input,
      options.insecureTlsForTesting ?? false,
      options.onDiagnostic,
    );
    if (result.location && [301, 302, 303, 307, 308].includes(result.measurement.statusCode)) {
      if (redirect === maxRedirects) throw new Error('NETWORK_PERFORMANCE_REDIRECT_LIMIT');
      currentUrl = new URL(result.location, validated.url).toString();
      continue;
    }
    if (result.measurement.statusCode < 200 || result.measurement.statusCode >= 300) {
      throw new Error('NETWORK_PERFORMANCE_TARGET_UNREACHABLE');
    }
    return result.measurement;
  }
  throw new Error('NETWORK_PERFORMANCE_REDIRECT_LIMIT');
}

async function createTlsSocketThroughSocks(
  proxyPort: number,
  selected: ResolvedAddress,
  port: number,
  servername: string,
  rejectUnauthorized: boolean,
  signal: AbortSignal,
  onDiagnostic?: (stage: string) => void,
): Promise<TLSSocket> {
  const socket = await connectSocksSocket(proxyPort, selected, port, signal);
  onDiagnostic?.('SOCKS_CONNECTED');
  // The SOCKS parser pauses reads while it consumes framing. Resume before
  // handing the already-connected transport to Node's TLS state machine.
  socket.resume();
  return new Promise((resolve, reject) => {
    const tlsSocket = connectTls({
      socket,
      servername,
      rejectUnauthorized,
    });
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    const onAbort = () => tlsSocket.destroy(abortError());
    signal.addEventListener('abort', onAbort, { once: true });
    tlsSocket.once('secureConnect', () => {
      cleanup();
      onDiagnostic?.('TLS_SECURE');
      resolve(tlsSocket);
    });
    tlsSocket.once('error', (error) => {
      cleanup();
      reject(error instanceof Error ? error : new Error('Tunneled TLS connection failed'));
    });
    tlsSocket.resume();
  });
}

async function requestOnce(
  url: URL,
  selected: ResolvedAddress,
  input: {
    signal: AbortSignal;
    maxBytes: number;
    proxyPort?: number;
  },
  insecureTlsForTesting: boolean,
  onDiagnostic?: (stage: string) => void,
): Promise<{ measurement: HttpsMeasurement; location?: string }> {
  const startedAt = performance.now();
  const tunneledSocket =
    input.proxyPort === undefined
      ? undefined
      : await createTlsSocketThroughSocks(
          input.proxyPort,
          selected,
          url.port ? Number(url.port) : 443,
          url.hostname,
          !insecureTlsForTesting,
          input.signal,
          onDiagnostic,
        );
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (
      error: Error | null,
      value?: { measurement: HttpsMeasurement; location?: string },
    ) => {
      if (settled) return;
      settled = true;
      input.signal.removeEventListener('abort', onAbort);
      if (error) reject(error);
      else resolve(value!);
    };
    const onAbort = () => {
      outgoing.destroy(abortError());
      finish(abortError());
    };
    const port = url.port ? Number(url.port) : 443;
    const outgoing = httpsRequest(
      {
        protocol: 'https:',
        hostname: url.hostname,
        port,
        path: `${url.pathname}${url.search}`,
        method: 'GET',
        headers: {
          host: url.host,
          accept: 'application/octet-stream,*/*;q=0.8',
          'user-agent': 'ProxyHub-Network-Performance/0.4',
          connection: 'close',
        },
        rejectUnauthorized: !insecureTlsForTesting,
        ...(tunneledSocket
          ? {
              agent: false,
              createConnection: () => tunneledSocket,
            }
          : {
              lookup: createPinnedLookup(selected),
            }),
      },
      (response) => {
        if (tunneledSocket) onDiagnostic?.('HTTP_RESPONSE');
        const firstByteMs = performance.now() - startedAt;
        let bytes = 0;
        response.on('data', (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes >= input.maxBytes) response.destroy();
        });
        const complete = () =>
          finish(null, {
            measurement: {
              statusCode: response.statusCode ?? 0,
              bytes: Math.min(bytes, input.maxBytes),
              durationMs: Math.max(1, performance.now() - startedAt),
              firstByteMs,
            },
            ...(response.headers.location ? { location: response.headers.location } : {}),
          });
        response.once('end', complete);
        response.once('close', complete);
        response.once('error', (error) => finish(error));
      },
    );
    input.signal.addEventListener('abort', onAbort, { once: true });
    outgoing.setTimeout(20_000, () =>
      outgoing.destroy(new Error('NETWORK_PERFORMANCE_TARGET_TIMEOUT')),
    );
    outgoing.once('error', (error) => finish(error));
    outgoing.end();
  });
}

export async function cleanupPerformanceDirectory(directory: string | undefined): Promise<void> {
  if (!directory) return;
  if (!basename(directory).startsWith(TEMP_PREFIX)) {
    throw new Error('Refusing to remove an unrecognized performance directory');
  }
  const metadata = await lstat(directory).catch(() => null);
  if (metadata?.isSymbolicLink()) {
    throw new Error('Refusing to follow a performance directory symlink');
  }
  await rm(directory, { recursive: true, force: true });
}

export async function cleanupStalePerformanceDirectories(
  maxAgeMs = 60 * 60 * 1_000,
): Promise<void> {
  const now = Date.now();
  const entries = await readdir(tmpdir(), { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.name.startsWith(TEMP_PREFIX) || !entry.isDirectory()) continue;
    const path = join(tmpdir(), entry.name);
    const metadata = await lstat(path).catch(() => null);
    if (metadata && !metadata.isSymbolicLink() && now - metadata.mtimeMs >= maxAgeMs) {
      await rm(path, { recursive: true, force: true });
    }
  }
}
