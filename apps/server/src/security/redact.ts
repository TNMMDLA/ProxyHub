const SENSITIVE_KEYS = new Set([
  'password',
  'currentPassword',
  'token',
  'totp',
  'secret',
  'privateKey',
  'recoveryCode',
]);

export function redactSensitive(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSensitive);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      SENSITIVE_KEYS.has(key) ? '[REDACTED]' : redactSensitive(item),
    ]),
  );
}
