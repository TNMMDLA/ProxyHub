import { describe, expect, it } from 'vitest';
import { parseConfig } from './config.js';

describe('server configuration', () => {
  it('parses explicit false environment values without enabling trust proxy', () => {
    expect(parseConfig({ TRUST_PROXY: 'false' }).TRUST_PROXY).toBe(false);
    expect(parseConfig({ TRUST_PROXY: '0' }).TRUST_PROXY).toBe(false);
    expect(parseConfig({ TRUST_PROXY: 'true' }).TRUST_PROXY).toBe(true);
  });

  it('rejects development and example secrets in production', () => {
    expect(() =>
      parseConfig({
        NODE_ENV: 'production',
        ENCRYPTION_KEY: 'replace-with-at-least-32-random-characters',
        AGENT_TOKEN: 'replace-with-a-long-random-agent-token',
      }),
    ).toThrow(/unique production secret/);
  });
});
