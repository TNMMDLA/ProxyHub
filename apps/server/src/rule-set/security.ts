import { BlockList, isIP } from 'node:net';
import { lookup } from 'node:dns/promises';
import { AppError } from '../errors.js';

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

export type ResolveHostname = (hostname: string) => Promise<ResolvedAddress[]>;

const blockedAddresses = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  blockedAddresses.addSubnet(network, prefix, 'ipv4');
}
for (const [network, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const) {
  blockedAddresses.addSubnet(network, prefix, 'ipv6');
}

export function isBlockedAddress(address: string): boolean {
  const normalized = address.toLowerCase().split('%')[0] ?? address.toLowerCase();
  const family = isIP(normalized);
  return family === 0 || blockedAddresses.check(normalized, family === 4 ? 'ipv4' : 'ipv6');
}

export const systemResolver: ResolveHostname = async (hostname) => {
  const addresses = await lookup(hostname, { all: true, verbatim: true });
  return addresses.map(({ address, family }) => ({ address, family: family as 4 | 6 }));
};

export async function validateRemoteUrl(
  rawUrl: string,
  options: { resolver?: ResolveHostname; allowHttp?: boolean } = {},
): Promise<{ url: URL; addresses: ResolvedAddress[] }> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new AppError('RULE_SET_URL_INVALID', 'Remote rule set URL is invalid', 422);
  }
  if (url.protocol !== 'https:' && !(options.allowHttp && url.protocol === 'http:')) {
    throw new AppError('RULE_SET_URL_FORBIDDEN', 'Remote rule sets require HTTPS', 422);
  }
  if (url.username || url.password) {
    throw new AppError('RULE_SET_URL_FORBIDDEN', 'URL credentials are not allowed', 422);
  }
  if (!url.hostname || url.hostname.toLowerCase() === 'localhost') {
    throw new AppError('RULE_SET_SSRF_BLOCKED', 'Remote address is not publicly routable', 422);
  }
  const literalFamily = isIP(url.hostname);
  const addresses = literalFamily
    ? [{ address: url.hostname, family: literalFamily as 4 | 6 }]
    : await (options.resolver ?? systemResolver)(url.hostname).catch(() => []);
  if (addresses.length === 0) {
    throw new AppError('RULE_SET_FETCH_FAILED', 'Remote hostname could not be resolved', 422);
  }
  const allowPrivateForTests =
    process.env.NODE_ENV === 'test' &&
    (options as { allowPrivateForTests?: boolean }).allowPrivateForTests === true;
  if (!allowPrivateForTests && addresses.some(({ address }) => isBlockedAddress(address))) {
    throw new AppError('RULE_SET_SSRF_BLOCKED', 'Remote address is not publicly routable', 422);
  }
  return { url, addresses };
}

export function redactRemoteUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return '[INVALID URL]';
  }
}
