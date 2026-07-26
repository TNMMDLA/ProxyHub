import { describe, expect, it } from 'vitest';
import type { CompilerNode } from '@proxyhub/policy-core';
import {
  contentTypeFor,
  sanitizeSubscriptionOutput,
  subscriptionCapabilities,
} from './subscription-delivery.js';

const node: CompilerNode = {
  id: 'node-1',
  name: 'Test',
  host: 'edge.example.com',
  port: 443,
  uuid: '00000000-0000-4000-8000-000000000001',
  flow: 'xtls-rprx-vision',
  sni: 'www.example.com',
  fingerprint: 'chrome',
  realityPublicKey: 'public-material',
  shortId: '1234567890abcdef',
  enabled: true,
  status: 'HEALTHY',
  uri: '',
};

describe('subscription delivery safety', () => {
  it('redacts UUID and short ID values', () => {
    const result = sanitizeSubscriptionOutput(`${node.uuid}\n${node.shortId}`, [node]);
    expect(result).toContain('[REDACTED-UUID]');
    expect(result).toContain('[REDACTED-SHORT-ID]');
    expect(result).not.toContain(node.uuid);
    expect(result).not.toContain(node.shortId);
  });

  it('redacts VLESS credentials and subscription paths', () => {
    const result = sanitizeSubscriptionOutput(
      'vless://secret-user@edge.example.com:443\nhttps://panel.example.com/sub/secret-token-value',
      [],
    );
    expect(result).toContain('vless://[REDACTED-UUID]@');
    expect(result).toContain('/sub/[REDACTED-TOKEN]');
    expect(result).not.toContain('secret-user');
    expect(result).not.toContain('secret-token-value');
  });

  it.each([
    ['https://example.com/config?token=secret', 'secret'],
    ['authorization: bearer-value', 'bearer-value'],
    ['privateKey: private-value', 'private-value'],
  ])('redacts secret-bearing output %s', (input, secret) => {
    expect(sanitizeSubscriptionOutput(input, [])).not.toContain(secret);
  });

  it.each([
    ['mihomo', 'text/yaml; charset=utf-8'],
    ['sing-box', 'application/json; charset=utf-8'],
    ['raw', 'text/plain; charset=utf-8'],
  ] as const)('maps %s to its public content type', (format, expected) => {
    expect(contentTypeFor(format)).toBe(expected);
  });

  it('derives the client matrix from compiler metadata', () => {
    const capabilities = subscriptionCapabilities();
    expect(capabilities).toHaveLength(3);
    expect(capabilities.find((item) => item.format === 'mihomo')).toMatchObject({
      features: { routingRules: 'SUPPORTED', configPreview: 'SUPPORTED' },
    });
    expect(capabilities.find((item) => item.format === 'raw')).toMatchObject({
      features: { routingRules: 'UNSUPPORTED', ruleSets: 'UNSUPPORTED' },
    });
  });
});
