import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, copyFile, rename, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';

export interface RealityCredentials {
  uuid: string;
  privateKey: string;
  publicKey: string;
  shortId: string;
  flow: 'xtls-rprx-vision';
}

export function generateRealityCredentials(): RealityCredentials {
  const pair = generateKeyPairSync('x25519');
  const privateJwk = pair.privateKey.export({ format: 'jwk' });
  const publicJwk = pair.publicKey.export({ format: 'jwk' });
  if (!privateJwk.d || !publicJwk.x) throw new Error('Unable to export X25519 key material');
  return {
    uuid: randomUUID(),
    privateKey: privateJwk.d,
    publicKey: publicJwk.x,
    shortId: randomBytes(8).toString('hex'),
    flow: 'xtls-rprx-vision',
  };
}

export interface RealityNodeConfig {
  name: string;
  port: number;
  uuid: string;
  privateKey: string;
  shortId: string;
  sni: string;
  dest: string;
  fingerprint: string;
}

export function buildRealityInbound(node: RealityNodeConfig): Record<string, unknown> {
  if (node.port < 1 || node.port > 65535) throw new Error('Invalid port');
  if (!node.sni || !node.dest || !node.uuid || !node.privateKey)
    throw new Error('Missing Reality field');
  return {
    tag: `proxyhub-${node.name.toLowerCase().replace(/[^a-z0-9-]/g, '-')}`,
    listen: '0.0.0.0',
    port: node.port,
    protocol: 'vless',
    settings: { clients: [{ id: node.uuid, flow: 'xtls-rprx-vision' }], decryption: 'none' },
    streamSettings: {
      network: 'tcp',
      security: 'reality',
      realitySettings: {
        show: false,
        dest: node.dest,
        xver: 0,
        serverNames: [node.sni],
        privateKey: node.privateKey,
        shortIds: [node.shortId],
      },
    },
    sniffing: { enabled: true, destOverride: ['http', 'tls', 'quic'] },
  };
}

export function buildXrayConfig(nodes: RealityNodeConfig[]): Record<string, unknown> {
  return {
    log: { loglevel: 'warning' },
    inbounds: nodes.map(buildRealityInbound),
    outbounds: [
      { tag: 'direct', protocol: 'freedom' },
      { tag: 'blocked', protocol: 'blackhole' },
    ],
  };
}

function runAllowed(binary: string, args: readonly string[], timeoutMs = 10_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, [...args], { shell: false, windowsHide: true });
    let output = '';
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()));
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(output);
      else reject(new Error(output.trim() || `Allowed process exited with ${String(code)}`));
    });
  });
}

export async function testXrayConfig(binary: string, configPath: string): Promise<string> {
  await access(binary, constants.X_OK);
  return runAllowed(binary, ['run', '-test', '-config', configPath]);
}

export async function getXrayVersion(binary: string): Promise<string> {
  const output = await runAllowed(binary, ['version']);
  return output.split(/\r?\n/, 1)[0] ?? 'unknown';
}

export async function restartXrayService(): Promise<string> {
  return runAllowed('systemctl', ['restart', 'xray']);
}

export async function startXrayService(): Promise<string> {
  return runAllowed('systemctl', ['start', 'xray']);
}

export async function stopXrayService(): Promise<string> {
  return runAllowed('systemctl', ['stop', 'xray']);
}

export async function getXrayServiceStatus(): Promise<string> {
  return runAllowed('systemctl', ['is-active', 'xray']);
}

/** Writes only after validation; the previous config is retained as .bak. */
export async function applyValidatedConfig(
  binary: string,
  targetPath: string,
  config: Record<string, unknown>,
  options: {
    backupPath?: string;
    requireExisting?: boolean;
    validate?: (binary: string, configPath: string) => Promise<string>;
  } = {},
): Promise<{ hadPreviousConfig: boolean }> {
  const operationId = randomUUID();
  const temporaryPath = `${targetPath}.next-${operationId}`;
  const backupPath = options.backupPath ?? `${targetPath}.bak`;
  const backupTemporaryPath = `${backupPath}.next-${operationId}`;
  let hadPreviousConfig = false;
  await writeFile(temporaryPath, JSON.stringify(config, null, 2), { mode: 0o600 });
  try {
    await (options.validate ?? testXrayConfig)(binary, temporaryPath);
    try {
      await access(targetPath);
      hadPreviousConfig = true;
      await copyFile(targetPath, backupTemporaryPath);
      await rename(backupTemporaryPath, backupPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      if (options.requireExisting) throw new Error('Active Xray configuration is missing');
    }
    await rename(temporaryPath, targetPath);
    return { hadPreviousConfig };
  } catch (error) {
    throw new Error(`Xray configuration validation failed: ${(error as Error).message}`);
  } finally {
    await Promise.all([
      rm(temporaryPath, { force: true }).catch(() => undefined),
      rm(backupTemporaryPath, { force: true }).catch(() => undefined),
    ]);
  }
}

/** Restores a previously validated backup through another atomic rename. */
export async function restoreValidatedConfig(
  binary: string,
  targetPath: string,
  backupPath: string,
  validate: (binary: string, configPath: string) => Promise<string> = testXrayConfig,
): Promise<void> {
  const temporaryPath = `${targetPath}.rollback-${randomUUID()}`;
  try {
    await access(backupPath);
    await copyFile(backupPath, temporaryPath);
    await validate(binary, temporaryPath);
    await rename(temporaryPath, targetPath);
  } catch (error) {
    throw new Error(`Xray configuration rollback failed: ${(error as Error).message}`);
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

export function createVlessUri(node: {
  uuid: string;
  host: string;
  port: number;
  flow: string;
  sni: string;
  fingerprint: string;
  realityPublicKey: string;
  shortId: string;
  name: string;
}): string {
  const params = new URLSearchParams({
    encryption: 'none',
    flow: node.flow,
    security: 'reality',
    sni: node.sni,
    fp: node.fingerprint,
    pbk: node.realityPublicKey,
    sid: node.shortId,
    type: 'tcp',
  });
  return `vless://${node.uuid}@${node.host}:${String(node.port)}?${params.toString()}#${encodeURIComponent(node.name)}`;
}
