import { spawnSync } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { buildXrayConfig } from '../../packages/xray-manager/dist/index.js';

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
 * @param {unknown} config
 */
async function agentPost(path, config) {
  const response = await fetch(`${agentUrl}${path}`, {
    method: 'POST',
    headers: { authorization, 'content-type': 'application/json' },
    body: JSON.stringify({ config }),
  });
  const body = envelope(/** @type {unknown} */ (await response.json()));
  return { response, body };
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

console.log(
  'Xray 26.5.9 accepted Agent validation, apply, restart, health, and rollback JSON files.',
);
