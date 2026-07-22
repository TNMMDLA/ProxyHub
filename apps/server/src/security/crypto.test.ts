import { describe, expect, it } from 'vitest';
import { decryptSecret, encryptSecret, hashPassword, verifyPassword } from './crypto.js';

describe('security primitives', () => {
  it('encrypts secrets with authenticated encryption', () => {
    const encrypted = encryptSecret('private-value');
    expect(encrypted).not.toContain('private-value');
    expect(decryptSecret(encrypted)).toBe('private-value');
  });

  it('hashes passwords using argon2id', async () => {
    const hash = await hashPassword('a-very-long-password');
    expect(hash).toContain('$argon2id$');
    await expect(verifyPassword(hash, 'a-very-long-password')).resolves.toBe(true);
    await expect(verifyPassword(hash, 'wrong')).resolves.toBe(false);
  });
});
