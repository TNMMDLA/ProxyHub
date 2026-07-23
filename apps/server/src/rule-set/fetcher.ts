import http from 'node:http';
import https from 'node:https';
import type { IncomingMessage } from 'node:http';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';
import type { Readable } from 'node:stream';
import { AppError } from '../errors.js';
import { validateRemoteUrl, type ResolveHostname } from './security.js';

export interface RemoteFetchOptions {
  etag?: string | null;
  lastModified?: string | null;
  maxBytes?: number;
  timeoutMs?: number;
  maxRedirects?: number;
  resolver?: ResolveHostname;
  allowHttp?: boolean;
  /** Test-only loopback transport; ignored by production call sites. */
  allowPrivateForTests?: boolean;
}

export interface RemoteFetchResult {
  status: 200 | 304;
  content: string | null;
  etag: string | null;
  lastModified: string | null;
  finalUrl: URL;
}

export function readLimitedBody(response: IncomingMessage, maxBytes: number): Promise<string> {
  const contentLength = Number(response.headers['content-length']);
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    response.destroy();
    throw new AppError('RULE_SET_TOO_LARGE', 'Remote rule set exceeds the size limit', 413);
  }
  const encoding = String(response.headers['content-encoding'] ?? '').toLowerCase();
  let stream: Readable = response;
  if (encoding === 'gzip') stream = response.pipe(createGunzip());
  else if (encoding === 'deflate') stream = response.pipe(createInflate());
  else if (encoding === 'br') stream = response.pipe(createBrotliDecompress());
  else if (encoding && encoding !== 'identity') {
    response.destroy();
    throw new AppError('RULE_SET_FETCH_FAILED', 'Unsupported content encoding', 422);
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    stream.on('data', (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buffer.length;
      if (total > maxBytes) {
        stream.destroy(
          new AppError('RULE_SET_TOO_LARGE', 'Remote rule set exceeds the size limit', 413),
        );
        return;
      }
      chunks.push(buffer);
    });
    stream.once('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    stream.once('error', reject);
  });
}

async function requestOnce(
  rawUrl: string,
  options: RemoteFetchOptions,
): Promise<{ response: IncomingMessage; url: URL }> {
  const validated = await validateRemoteUrl(rawUrl, options);
  const selected = validated.addresses[0]!;
  const headers: Record<string, string> = {
    accept: 'application/json, text/plain, application/yaml, text/yaml;q=0.9',
    'accept-encoding': 'gzip, deflate, br',
    'user-agent': 'ProxyHub-RuleSet/0.3',
    host: validated.url.host,
  };
  if (options.etag) headers['if-none-match'] = options.etag;
  if (options.lastModified) headers['if-modified-since'] = options.lastModified;
  const requestOptions: https.RequestOptions = {
    protocol: validated.url.protocol,
    hostname: selected.address,
    ...(validated.url.port ? { port: validated.url.port } : {}),
    path: `${validated.url.pathname}${validated.url.search}`,
    method: 'GET',
    headers,
    servername: validated.url.hostname,
    family: selected.family,
  };
  const client = validated.url.protocol === 'https:' ? https : http;
  const response = await new Promise<IncomingMessage>((resolve, reject) => {
    const request = client.request(requestOptions, resolve);
    request.setTimeout(options.timeoutMs ?? 10_000, () => {
      request.destroy(
        new AppError('RULE_SET_FETCH_FAILED', 'Remote rule set request timed out', 504),
      );
    });
    request.once('error', reject);
    request.end();
  }).catch((error: unknown) => {
    if (error instanceof AppError) throw error;
    throw new AppError('RULE_SET_FETCH_FAILED', 'Remote rule set request failed', 502);
  });
  return { response, url: validated.url };
}

export async function fetchRemoteRuleSet(
  rawUrl: string,
  options: RemoteFetchOptions = {},
): Promise<RemoteFetchResult> {
  const maxRedirects = options.maxRedirects ?? 3;
  let current = rawUrl;
  for (let redirect = 0; redirect <= maxRedirects; redirect += 1) {
    const { response, url } = await requestOnce(current, options);
    const status = response.statusCode ?? 0;
    if ([301, 302, 303, 307, 308].includes(status)) {
      const location = response.headers.location;
      response.resume();
      if (!location || redirect === maxRedirects) {
        throw new AppError('RULE_SET_FETCH_FAILED', 'Remote redirect limit exceeded', 502);
      }
      current = new URL(location, url).toString();
      continue;
    }
    const common = {
      etag: typeof response.headers.etag === 'string' ? response.headers.etag : null,
      lastModified:
        typeof response.headers['last-modified'] === 'string'
          ? response.headers['last-modified']
          : null,
      finalUrl: url,
    };
    if (status === 304) {
      response.resume();
      return { status: 304, content: null, ...common };
    }
    if (status !== 200) {
      response.resume();
      throw new AppError(
        'RULE_SET_FETCH_FAILED',
        `Remote source returned HTTP ${String(status)}`,
        502,
      );
    }
    return {
      status: 200,
      content: await readLimitedBody(response, options.maxBytes ?? 5 * 1024 * 1024),
      ...common,
    };
  }
  throw new AppError('RULE_SET_FETCH_FAILED', 'Remote redirect limit exceeded', 502);
}
