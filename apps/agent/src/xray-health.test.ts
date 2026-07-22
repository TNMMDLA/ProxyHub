import { describe, expect, it } from 'vitest';
import { classifyXrayHealth } from './xray-health.js';

describe('Xray health classification', () => {
  it('requires all checks before reporting healthy', () => {
    expect(classifyXrayHealth({ process: true, container: true, ports: true, config: true })).toBe(
      'HEALTHY',
    );
    expect(classifyXrayHealth({ process: true, container: true, ports: false, config: true })).toBe(
      'DEGRADED',
    );
  });

  it('reports offline only when process and companion container are both absent', () => {
    expect(
      classifyXrayHealth({ process: false, container: false, ports: false, config: false }),
    ).toBe('OFFLINE');
    expect(
      classifyXrayHealth({ process: false, container: true, ports: false, config: false }),
    ).toBe('DEGRADED');
  });
});
