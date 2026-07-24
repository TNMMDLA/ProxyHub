import { isIP } from 'node:net';
import {
  isBlockedAddress,
  systemResolver,
  type ResolvedAddress,
  type ResolveHostname,
} from '@proxyhub/xray-manager';
import { AppError } from '../errors.js';

export { isBlockedAddress, systemResolver, type ResolvedAddress, type ResolveHostname };

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
