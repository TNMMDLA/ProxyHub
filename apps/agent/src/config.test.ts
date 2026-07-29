import { describe, expect, it } from 'vitest';
import { parseAgentConfig } from './config.js';

describe('agent configuration', () => {
  it('allows the documented development defaults outside production', () => {
    expect(parseAgentConfig({}).AGENT_PORT).toBe(3001);
  });

  it('rejects the example Agent token in production', () => {
    expect(() =>
      parseAgentConfig({
        NODE_ENV: 'production',
        AGENT_TOKEN: 'replace-with-a-long-random-agent-token',
      }),
    ).toThrow(/unique production secret/);
  });

  it('restricts Xray metrics to the exact internal endpoint', () => {
    expect(() =>
      parseAgentConfig({
        XRAY_METRICS_URL: 'http://host.docker.internal:11111/debug/vars?target=secret',
      }),
    ).toThrow(/internal Xray HTTP metrics endpoint/);
    expect(
      parseAgentConfig({
        XRAY_METRICS_URL: 'http://127.0.0.1:11111/debug/vars',
      }).XRAY_METRICS_URL,
    ).toBe('http://127.0.0.1:11111/debug/vars');
  });
});
