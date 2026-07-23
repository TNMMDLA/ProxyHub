import { describe, expect, it } from 'vitest';
import { redactRequestUrl } from '../app.js';
import { hashToken, newOpaqueToken } from './crypto.js';
import { redactSensitive } from './redact.js';

describe('subscription secret security', () => {
  it('issues 256-bit opaque tokens with unique values', () => {
    const tokens = Array.from({ length: 100 }, () => newOpaqueToken(32));
    expect(new Set(tokens).size).toBe(100);
    for (const token of tokens) expect(Buffer.from(token, 'base64url')).toHaveLength(32);
  });

  it('stores a deterministic SHA-256 digest instead of the token', () => {
    const token = 'subscription-token-sentinel';
    const digest = hashToken(token);
    expect(digest).toMatch(/^[a-f0-9]{64}$/);
    expect(digest).toBe(hashToken(token));
    expect(digest).not.toContain(token);
  });

  it('recursively removes password, token, TOTP, recovery and private-key sentinels', () => {
    const sentinels = {
      password: 'PASSWORD_SENTINEL',
      passwordHash: 'PASSWORD_HASH_SENTINEL',
      sessionToken: 'SESSION_TOKEN_SENTINEL',
      totpSecretEncrypted: 'TOTP_SENTINEL',
      recoveryCodes: ['RECOVERY_SENTINEL'],
      nested: { realityPrivateKeyEncrypted: 'PRIVATE_KEY_SENTINEL' },
      subscriptionToken: 'SUBSCRIPTION_TOKEN_SENTINEL',
      tokenPrefix: 'safe-prefix',
    };
    const serialized = JSON.stringify(redactSensitive(sentinels));
    for (const sentinel of [
      'PASSWORD_SENTINEL',
      'PASSWORD_HASH_SENTINEL',
      'SESSION_TOKEN_SENTINEL',
      'TOTP_SENTINEL',
      'RECOVERY_SENTINEL',
      'PRIVATE_KEY_SENTINEL',
      'SUBSCRIPTION_TOKEN_SENTINEL',
    ]) {
      expect(serialized).not.toContain(sentinel);
    }
    expect(serialized).toContain('safe-prefix');
  });

  it('redacts subscription tokens from relative and nested request URLs', () => {
    const token = 'FULL_SUBSCRIPTION_TOKEN_SENTINEL';
    expect(redactRequestUrl(`/sub/${token}`)).toBe('/sub/[REDACTED]');
    expect(redactRequestUrl(`/prefix/sub/${token}?download=1`)).toBe(
      '/prefix/sub/[REDACTED]?download=1',
    );
    expect(redactRequestUrl(`/sub/${token}`)).not.toContain(token);
  });

  it('redacts remote URL query tokens, signatures and basic-auth credentials', () => {
    expect(
      redactSensitive({
        sourceUrl: 'https://user:pass@rules.example.com/list?token=secret&signature=signed#key',
      }),
    ).toEqual({ sourceUrl: 'https://rules.example.com/list' });
  });
});
