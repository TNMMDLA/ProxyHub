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
});
