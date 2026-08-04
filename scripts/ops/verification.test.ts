import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const exec = promisify(execFile);
const root = resolve(import.meta.dirname, '../..');
const verification = resolve(root, 'scripts/ops/lib/verification.sh');
const common = resolve(root, 'scripts/ops/lib/common.sh');
const linux = process.platform === 'linux';

async function bash(script: string, helper = verification) {
  return exec('bash', ['-c', `source "$1"; ${script}`, 'bash', helper]);
}

describe('deployment verification helper contract', () => {
  it('contains stable container and health failure codes', async () => {
    const contents = await readFile(verification, 'utf8');
    expect(contents).toContain('OPS_CONTAINER_NOT_FOUND');
    expect(contents).toContain('OPS_CONTAINER_AMBIGUOUS');
    expect(contents).toContain('OPS_HEALTH_PAYLOAD_INVALID');
    expect(contents).toContain('OPS_HEALTH_METADATA_INVALID');
  });

  it('starts Xray before force-recreating Agent and verifies the current PID namespace', async () => {
    const contents = await readFile(common, 'utf8');
    expect(contents).toContain('ops_compose up -d --no-deps xray');
    expect(contents).toContain('ops_compose up -d --no-deps --force-recreate proxyhub-agent');
    expect(contents).toContain('container:$xray_container_id');
  });
});

describe.skipIf(!linux)('deployment verification helper behavior', () => {
  it.each(['customer-a', 'customer-b'])(
    'resolves a service after the Compose project name changes to %s',
    async (project) => {
      const { stdout } = await bash(
        `fake_compose(){ [[ "$1" == ps && "$4" == xray ]] && printf '%s-xray-cid\\n' "$COMPOSE_PROJECT_NAME"; }; ` +
          `COMPOSE_PROJECT_NAME="${project}"; proxyhub_compose_service_container_id fake_compose xray`,
      );
      expect(stdout.trim()).toBe(`${project}-xray-cid`);
    },
  );

  it.each(['proxyhub-xray-1', 'proxyhub-xray-2'])(
    'uses the service query result instead of generated container name %s',
    async (generatedName) => {
      const { stdout } = await bash(
        `fake_compose(){ [[ "$1" == ps && "$4" == xray ]] && echo dynamic-xray-cid; }; ` +
          'proxyhub_compose_service_container_id fake_compose xray',
      );
      expect(stdout.trim()).toBe('dynamic-xray-cid');
      expect(stdout.trim()).not.toBe(generatedName);
    },
  );

  it('rejects an ambiguous service lookup', async () => {
    await expect(
      bash(
        `fake_compose(){ printf 'first\\nsecond\\n'; }; ` +
          'proxyhub_compose_service_container_id fake_compose xray',
      ),
    ).rejects.toMatchObject({ stderr: expect.stringContaining('OPS_CONTAINER_AMBIGUOUS') });
  });

  it('unwraps the current success/data health envelope', async () => {
    const payload = JSON.stringify({
      success: true,
      data: { status: 'ok', version: '0.4.0-dev' },
    });
    const { stdout } = await bash(`printf '%s' '${payload}' | proxyhub_health_data`);
    expect(JSON.parse(stdout)).toEqual({ status: 'ok', version: '0.4.0-dev' });
  });

  it('keeps the legacy flat health payload compatible', async () => {
    const payload = JSON.stringify({ status: 'ok', version: '0.4.0-dev' });
    const { stdout } = await bash(`printf '%s' '${payload}' | proxyhub_health_data`);
    expect(JSON.parse(stdout)).toEqual({ status: 'ok', version: '0.4.0-dev' });
  });

  it('rejects genuinely mismatched metadata', async () => {
    const payload = JSON.stringify({
      status: 'ok',
      version: '0.4.0-dev',
      gitSha: 'a'.repeat(40),
      buildEnvironment: 'candidate',
      deployMode: 'source',
    });
    await expect(
      bash(`proxyhub_health_metadata_valid '${payload}' '0.4.1-dev'`),
    ).rejects.toMatchObject({ stderr: expect.stringContaining('OPS_HEALTH_METADATA_INVALID') });
  });

  it('reports stable invalid metadata when envelope data is missing', async () => {
    const payload = JSON.stringify({ success: true });
    await expect(bash(`proxyhub_health_metadata_valid '${payload}'`)).rejects.toMatchObject({
      stderr: expect.stringContaining('OPS_HEALTH_METADATA_INVALID'),
    });
  });

  it('does not treat Caddy informational ACME logs as failures', async () => {
    const informational = JSON.stringify({
      level: 'info',
      msg: 'creating new account',
      error: 'account file does not exist yet',
    });
    await expect(
      bash(`printf '%s' '${informational}' | proxyhub_caddy_logs_have_explicit_failure`),
    ).rejects.toBeDefined();
  });

  it('detects explicit Caddy error-level logs', async () => {
    const failure = JSON.stringify({ level: 'error', msg: 'challenge failed' });
    await expect(
      bash(`printf '%s' '${failure}' | proxyhub_caddy_logs_have_explicit_failure`),
    ).resolves.toBeDefined();
  });

  it('detects an explicit Caddy error-level log ending with a newline', async () => {
    const failure = JSON.stringify({ level: 'error', msg: 'challenge failed' });
    await expect(
      bash(`printf '%s\\n' '${failure}' | proxyhub_caddy_logs_have_explicit_failure`),
    ).resolves.toBeDefined();
  });

  it('processes the final unterminated line in multiline Caddy logs', async () => {
    const informational = JSON.stringify({ level: 'info', msg: 'serving initial configuration' });
    const failure = JSON.stringify({ level: 'error', msg: 'challenge failed' });
    await expect(
      bash(
        `printf '%s\\n%s' '${informational}' '${failure}' | ` +
          'proxyhub_caddy_logs_have_explicit_failure',
      ),
    ).resolves.toBeDefined();
  });

  it.each(['', 'not-json'])(
    'does not treat empty or invalid Caddy logs as failures',
    async (log) => {
      await expect(
        bash(`printf '%s' '${log}' | proxyhub_caddy_logs_have_explicit_failure`),
      ).rejects.toBeDefined();
    },
  );

  it('binds a recreated Agent to the current Xray container ID', async () => {
    const { stdout } = await bash(
      `ops_compose(){ ` +
        `if [[ "$1" == ps && "$4" == xray ]]; then echo current-xray-cid; ` +
        `elif [[ "$1" == ps && "$4" == proxyhub-agent ]]; then echo current-agent-cid; fi; }; ` +
        `docker(){ [[ "$1" == inspect ]] && echo container:current-xray-cid; }; ` +
        'ops_start_runtime_services; echo PID_BINDING_OK',
      common,
    );
    expect(stdout).toContain('PID_BINDING_OK');
  });
});
