import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildXrayConfig,
  buildRealityCompatibilityConfigs,
  generateRealityCredentials,
  testXrayConfig,
} from '../../packages/xray-manager/dist/index.js';

const configPath = '/etc/xray/config.json';
const agentUrl = 'http://127.0.0.1:3001';
const authorization = `Bearer ${process.env.AGENT_TOKEN ?? ''}`;

/** @param {unknown} rawBody */
function envelope(rawBody) {
  if (typeof rawBody !== 'object' || rawBody === null) {
    throw new Error('Agent returned a non-object response');
  }
  return {
    success: /** @type {unknown} */ (Reflect.get(rawBody, 'success')),
    data: /** @type {unknown} */ (Reflect.get(rawBody, 'data')),
    error: /** @type {unknown} */ (Reflect.get(rawBody, 'error')),
  };
}

/**
 * @param {string} path
 * @param {unknown} payload
 */
async function agentJsonPost(path, payload) {
  const response = await fetch(`${agentUrl}${path}`, {
    method: 'POST',
    headers: { authorization, 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body = envelope(/** @type {unknown} */ (await response.json()));
  return { response, body };
}

/**
 * @param {string} path
 * @param {unknown} config
 */
function agentPost(path, config) {
  return agentJsonPost(path, { config });
}

/** @returns {Promise<number>} */
async function ephemeralPort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close((error) => {
        if (error || port === 0) reject(error ?? new Error('Could not allocate ephemeral port'));
        else resolve(port);
      });
    });
  });
}

async function temporaryRealityProcessCount() {
  const entries = await readdir('/proc');
  let count = 0;
  await Promise.all(
    entries
      .filter((entry) => /^\d+$/.test(entry))
      .map(async (entry) => {
        const command = await readFile(`/proc/${entry}/cmdline`, 'utf8').catch(() => '');
        if (command.includes('proxyhub-reality-compat-')) count += 1;
      }),
  );
  return count;
}

const generatedConfig = buildXrayConfig([]);
if (typeof generatedConfig !== 'object' || generatedConfig === null) {
  throw new Error('Generated Xray config is invalid');
}

const xrayVersion = spawnSync('/usr/local/bin/xray', ['version'], { encoding: 'utf8' });
if (xrayVersion.status !== 0 || !xrayVersion.stdout.includes('26.5.9')) {
  throw new Error(`Expected Xray 26.5.9, received: ${xrayVersion.stdout}${xrayVersion.stderr}`);
}

const activeBeforeInvalidValidation = await readFile(configPath);
const validValidation = await agentPost('/xray/validate', generatedConfig);
if (!validValidation.response.ok || validValidation.body.success !== true) {
  throw new Error(`Valid generated config was rejected: ${JSON.stringify(validValidation.body)}`);
}

const invalidValidation = await agentPost('/xray/validate', { inbounds: 'invalid' });
if (invalidValidation.response.ok || invalidValidation.body.success === true) {
  throw new Error('Invalid generated config unexpectedly passed Xray validation');
}
const activeAfterInvalidValidation = await readFile(configPath);
if (!activeBeforeInvalidValidation.equals(activeAfterInvalidValidation)) {
  throw new Error('Manual validation changed the active Xray configuration');
}

const activePidBeforeCompatibility = await readFile('/var/run/proxyhub/xray.pid', 'utf8');
const compatibilityDirectory = await mkdtemp(join(tmpdir(), 'proxyhub-reality-runtime-'));
try {
  const credentials = generateRealityCredentials();
  const serverPort = await ephemeralPort();
  const proxyPort = await ephemeralPort();
  const configs = buildRealityCompatibilityConfigs({
    serverName: 'www.cloudflare.com',
    targetAddress: { address: '1.1.1.1', family: 4 },
    targetPort: 443,
    serverPort,
    proxyPort,
    uuid: credentials.uuid,
    privateKey: credentials.privateKey,
    publicKey: credentials.publicKey,
    shortId: credentials.shortId,
  });
  const serverConfigPath = join(compatibilityDirectory, 'reality-server.json');
  const clientConfigPath = join(compatibilityDirectory, 'reality-client.json');
  await Promise.all([
    writeFile(serverConfigPath, JSON.stringify(configs.server), { mode: 0o600 }),
    writeFile(clientConfigPath, JSON.stringify(configs.client), { mode: 0o600 }),
  ]);
  await Promise.all([
    testXrayConfig('/usr/local/bin/xray', serverConfigPath),
    testXrayConfig('/usr/local/bin/xray', clientConfigPath),
  ]);
  if (!(await readFile(configPath)).equals(activeAfterInvalidValidation)) {
    throw new Error('Compatibility config validation changed the active Xray configuration');
  }
  if ((await readFile('/var/run/proxyhub/xray.pid', 'utf8')) !== activePidBeforeCompatibility) {
    throw new Error('Compatibility config validation restarted the active Xray process');
  }
} finally {
  await rm(compatibilityDirectory, { recursive: true, force: true });
}

const applied = await agentPost('/xray/apply', generatedConfig);
if (!applied.response.ok || applied.body.success !== true) {
  throw new Error(`Generated config apply failed: ${JSON.stringify(applied.body)}`);
}
if (typeof applied.body.data !== 'object' || applied.body.data === null) {
  throw new Error('Agent apply response did not contain data');
}
const revision = /** @type {unknown} */ (Reflect.get(applied.body.data, 'revision'));
const health = /** @type {unknown} */ (Reflect.get(applied.body.data, 'health'));
if (typeof revision !== 'string' || typeof health !== 'object' || health === null) {
  throw new Error('Agent apply response omitted revision or health');
}
if (Reflect.get(health, 'status') !== 'HEALTHY') {
  throw new Error(`Xray did not become healthy after apply: ${JSON.stringify(health)}`);
}

const rollbackPath = `/etc/xray/config.rollback-${revision}.json`;
const rollbackValidation = spawnSync(
  '/usr/local/bin/xray',
  ['run', '-test', '-config', rollbackPath],
  { encoding: 'utf8' },
);
if (rollbackValidation.status !== 0) {
  throw new Error(
    `Rollback config failed real Xray validation: ${rollbackValidation.stdout}${rollbackValidation.stderr}`,
  );
}

const confirmed = await fetch(`${agentUrl}/xray/confirm`, {
  method: 'POST',
  headers: { authorization, 'content-type': 'application/json' },
  body: JSON.stringify({ revision }),
});
if (!confirmed.ok) throw new Error('Agent could not confirm the applied Xray revision');

const residualLifecycleFiles = (await readdir('/etc/xray')).filter(
  (entry) => entry !== 'config.json',
);
if (residualLifecycleFiles.length > 0) {
  throw new Error(`Lifecycle files were not cleaned up: ${residualLifecycleFiles.join(', ')}`);
}

if (process.env.RUN_PUBLIC_REALITY_COMPAT_SMOKE === 'true') {
  const activeBeforePublicSmoke = await readFile(configPath);
  const activePidBeforePublicSmoke = await readFile('/var/run/proxyhub/xray.pid', 'utf8');
  const publicSmoke = await agentJsonPost('/xray/reality-compatibility', {
    serverName: 'dl.google.com',
    target: 'dl.google.com:443',
  });
  if (!publicSmoke.response.ok || publicSmoke.body.success !== true) {
    throw new Error(`Optional public Reality smoke failed: ${JSON.stringify(publicSmoke.body)}`);
  }
  if (!(await readFile(configPath)).equals(activeBeforePublicSmoke)) {
    throw new Error('Optional public Reality smoke changed the active Xray configuration');
  }
  if ((await readFile('/var/run/proxyhub/xray.pid', 'utf8')) !== activePidBeforePublicSmoke) {
    throw new Error('Optional public Reality smoke restarted the active Xray process');
  }
  console.log(`Optional public Reality result: ${JSON.stringify(publicSmoke.body.data)}`);
}
if ((await temporaryRealityProcessCount()) !== 0) {
  throw new Error('Temporary Reality child processes remained after the runtime smoke');
}

console.log(
  'Xray 26.5.9 accepted Agent lifecycle and isolated Reality server/client JSON configs.',
);
