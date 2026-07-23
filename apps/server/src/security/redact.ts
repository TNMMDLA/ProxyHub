function isSensitiveKey(key: string): boolean {
  const normalized = key.replaceAll(/[^a-zA-Z]/g, '').toLowerCase();
  if (normalized.endsWith('prefix')) return false;
  return ['password', 'token', 'totp', 'secret', 'privatekey', 'recoverycode'].some((part) =>
    normalized.includes(part),
  );
}

export function redactSensitive(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSensitive);
  if (typeof value === 'string' && /^https?:\/\//i.test(value)) {
    try {
      const url = new URL(value);
      if (url.username || url.password || url.search || url.hash) {
        url.username = '';
        url.password = '';
        url.search = '';
        url.hash = '';
        return url.toString();
      }
    } catch {
      return '[REDACTED URL]';
    }
  }
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      isSensitiveKey(key) ? '[REDACTED]' : redactSensitive(item),
    ]),
  );
}
