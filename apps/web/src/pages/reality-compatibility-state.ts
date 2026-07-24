import type { RealityTargetCompatibilityResult } from '@proxyhub/shared';

export const initialForm = {
  name: '',
  serverId: '',
  host: '',
  port: 443,
  sni: 'dl.google.com',
  dest: 'dl.google.com:443',
  fingerprint: 'chrome',
};

export type CompatibilityView =
  RealityTargetCompatibilityResult | { status: 'ERROR'; message: string } | null;

export function clearCompatibilityOnRealityChange<T>(
  form: T,
  field: 'sni' | 'dest',
  value: string,
): { form: T; compatibility: null } {
  return { form: { ...form, [field]: value }, compatibility: null };
}
