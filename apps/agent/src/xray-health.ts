import { readFile, stat } from 'node:fs/promises';
import { connect } from 'node:net';
import type { XrayHealthState, XrayHealthStatus } from '@proxyhub/shared';
import { getXrayVersion, testXrayConfig } from '@proxyhub/xray-manager';
import type { AgentConfig } from './config.js';

const HEARTBEAT_STALE_MS = 10_000;

interface HealthFlags {
  process: boolean;
  container: boolean;
  ports: boolean;
  config: boolean;
}

export function classifyXrayHealth(flags: HealthFlags): XrayHealthState {
  if (flags.process && flags.container && flags.ports && flags.config) return 'HEALTHY';
  if (!flags.process && !flags.container) return 'OFFLINE';
  return 'DEGRADED';
}

async function processStatus(pidPath: string): Promise<{ healthy: boolean; pid: number | null }> {
  try {
    const pid = Number.parseInt((await readFile(pidPath, 'utf8')).trim(), 10);
    if (!Number.isSafeInteger(pid) || pid <= 0) return { healthy: false, pid: null };
    process.kill(pid, 0);
    return { healthy: true, pid };
  } catch {
    return { healthy: false, pid: null };
  }
}

async function containerStatus(
  heartbeatPath: string,
): Promise<{ healthy: boolean; heartbeatAt: string | null }> {
  try {
    const heartbeat = await stat(heartbeatPath);
    return {
      healthy: Date.now() - heartbeat.mtimeMs <= HEARTBEAT_STALE_MS,
      heartbeatAt: heartbeat.mtime.toISOString(),
    };
  } catch {
    return { healthy: false, heartbeatAt: null };
  }
}

async function configuredPorts(configPath: string): Promise<number[]> {
  const raw = JSON.parse(await readFile(configPath, 'utf8')) as { inbounds?: unknown };
  if (!Array.isArray(raw.inbounds)) return [];
  return raw.inbounds.flatMap((inbound) => {
    if (!inbound || typeof inbound !== 'object') return [];
    const port = (inbound as { port?: unknown }).port;
    return typeof port === 'number' && Number.isInteger(port) && port > 0 && port <= 65_535
      ? [port]
      : [];
  });
}

function portListening(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    const finish = (listening: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(listening);
    };
    socket.setTimeout(750);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

export async function inspectXrayHealth(config: AgentConfig): Promise<XrayHealthStatus> {
  const [processCheck, containerCheck] = await Promise.all([
    processStatus(config.XRAY_PID_PATH),
    containerStatus(config.XRAY_HEARTBEAT_PATH),
  ]);

  let version: string | null = null;
  let configHealthy = false;
  let configMessage: string | null = null;
  let ports: number[] = [];
  let portsKnown = false;
  try {
    ports = await configuredPorts(config.XRAY_CONFIG_PATH);
    portsKnown = true;
  } catch (error) {
    configMessage = error instanceof Error ? error.message.slice(0, 500) : 'Config read failed';
  }
  try {
    version = await getXrayVersion(config.XRAY_BINARY);
    await testXrayConfig(config.XRAY_BINARY, config.XRAY_CONFIG_PATH);
    configHealthy = true;
  } catch (error) {
    configMessage = error instanceof Error ? error.message.slice(0, 500) : 'Config check failed';
  }

  const portResults = await Promise.all(
    ports.map(async (port) => ({
      port,
      listening: await portListening(config.XRAY_PROBE_HOST, port),
    })),
  );
  const listening = portResults.filter((item) => item.listening).map((item) => item.port);
  const portsHealthy = portsKnown && listening.length === ports.length;
  const flags = {
    process: processCheck.healthy,
    container: containerCheck.healthy,
    ports: portsHealthy,
    config: configHealthy,
  };

  return {
    status: classifyXrayHealth(flags),
    running: processCheck.healthy,
    version,
    checkedAt: new Date().toISOString(),
    checks: {
      process: processCheck,
      container: containerCheck,
      ports: { healthy: portsHealthy, known: portsKnown, configured: ports, listening },
      config: { healthy: configHealthy, message: configMessage },
    },
  };
}

export async function waitForHealthyXray(config: AgentConfig): Promise<XrayHealthStatus> {
  const deadline = Date.now() + config.XRAY_HEALTH_TIMEOUT_MS;
  let health = await inspectXrayHealth(config);
  while (health.status !== 'HEALTHY' && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 300));
    health = await inspectXrayHealth(config);
  }
  if (health.status !== 'HEALTHY') {
    throw new Error(`Xray health check failed with status ${health.status}`);
  }
  return health;
}
