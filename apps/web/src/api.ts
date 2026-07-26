export class ApiError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    const headers = new Headers(init?.headers);
    if (init?.body != null && !headers.has('content-type')) {
      headers.set('content-type', 'application/json');
    }
    response = await fetch(`/api${path}`, {
      credentials: 'include',
      ...init,
      headers,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new ApiError('NETWORK_ERROR', 'Unable to reach the ProxyHub API');
  }
  let result: {
    success: boolean;
    data?: T;
    error?: { code: string; message: string };
  };
  try {
    result = (await response.json()) as typeof result;
  } catch {
    throw new ApiError('INVALID_RESPONSE', 'The ProxyHub API returned an invalid response');
  }
  if (!response.ok || !result.success)
    throw new ApiError(
      result.error?.code ?? 'REQUEST_FAILED',
      result.error?.message ?? 'Request failed',
    );
  return result.data as T;
}

export function formatRelative(value: string | Date): string {
  const seconds = Math.floor((Date.now() - new Date(value).getTime()) / 1000);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}
