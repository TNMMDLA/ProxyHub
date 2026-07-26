import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeAll, describe, expect, it } from 'vitest';
import type { RealityTargetCompatibilityResult } from '@proxyhub/shared';
import i18n from '../i18n/index.js';
import { RealityCompatibilityPanel } from './RealityCompatibilityPanel.js';
import { clearCompatibilityOnRealityChange, initialForm } from './reality-compatibility-state.js';

function compatibility(
  status: RealityTargetCompatibilityResult['status'],
): RealityTargetCompatibilityResult {
  return {
    status,
    target: 'example.com:443',
    serverName: 'example.com',
    xrayVersion: 'Xray 26.5.9',
    durationMs: 1_200,
    tlsPrecheck: { status: 'PASSED' },
    realityHandshake: { status: status === 'COMPATIBLE' ? 'PASSED' : 'FAILED' },
    endToEndTraffic: { status: status === 'COMPATIBLE' ? 'PASSED' : 'NOT_RUN' },
    diagnostics:
      status === 'COMPATIBLE'
        ? []
        : ['TLS precheck passed, but the end-to-end Reality handshake failed.'],
  };
}

describe('Node Reality compatibility UI', () => {
  beforeAll(async () => {
    await i18n.changeLanguage('en');
  });

  it('uses dl.google.com as the recommended default without guaranteeing compatibility', () => {
    expect(initialForm.sni).toBe('dl.google.com');
    expect(initialForm.dest).toBe('dl.google.com:443');
    expect(
      renderToStaticMarkup(createElement(RealityCompatibilityPanel, { result: null })),
    ).toContain('Not tested');
  });

  it.each(['sni', 'dest'] as const)('clears the previous result when %s changes', (field) => {
    const next = clearCompatibilityOnRealityChange(initialForm, field, 'changed.example');
    expect(next.form[field]).toBe('changed.example');
    expect(next.compatibility).toBeNull();
  });

  it('renders a compatible end-to-end result', () => {
    const output = renderToStaticMarkup(
      createElement(RealityCompatibilityPanel, { result: compatibility('COMPATIBLE') }),
    );
    expect(output).toContain('Compatible');
    expect(output).toContain('Reality handshake: Passed');
    expect(output).toContain('End-to-end traffic: Passed');
    expect(output).toContain('Xray 26.5.9');
  });

  it('shows that TLS passed while the Reality handshake failed', () => {
    const output = renderToStaticMarkup(
      createElement(RealityCompatibilityPanel, { result: compatibility('INCOMPATIBLE') }),
    );
    expect(output).toContain('Incompatible');
    expect(output).toContain('TLS precheck: Passed');
    expect(output).toContain('Reality handshake: Failed');
    expect(output).toContain('End-to-end traffic: Not run');
  });
});
