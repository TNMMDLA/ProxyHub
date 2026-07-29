import { parseXrayUserMetrics, serializeBytes } from '@proxyhub/users-core';

const MAX_METRICS_BYTES = 2 * 1024 * 1024;

export interface AgentUserMetric {
  statsIdentity: string;
  uplinkBytes: string;
  downlinkBytes: string;
}

export async function fetchXrayUserStats(
  url: string,
  fetcher: typeof fetch = fetch,
  signal: AbortSignal = AbortSignal.timeout(5_000),
): Promise<AgentUserMetric[]> {
  const response = await fetcher(url, {
    signal,
    headers: { accept: 'application/json' },
  });
  if (!response.ok) throw new Error(`Xray metrics returned ${String(response.status)}`);
  const declaredLength = Number(response.headers.get('content-length') ?? '0');
  if (declaredLength > MAX_METRICS_BYTES) throw new Error('Xray metrics response is too large');
  const body = await response.text();
  if (Buffer.byteLength(body, 'utf8') > MAX_METRICS_BYTES)
    throw new Error('Xray metrics response is too large');
  return parseXrayUserMetrics(JSON.parse(body) as unknown).map((metric) => ({
    statsIdentity: metric.statsIdentity,
    uplinkBytes: serializeBytes(metric.uplinkBytes),
    downlinkBytes: serializeBytes(metric.downlinkBytes),
  }));
}
