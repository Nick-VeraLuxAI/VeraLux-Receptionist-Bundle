export interface RuntimeHttpOptions extends Omit<RequestInit, 'signal'> {
  timeoutMs?: number;
  retries?: number;
  retryDelayMs?: number;
  retryOnStatuses?: number[];
}

const DEFAULT_RETRY_STATUSES = [408, 425, 429, 500, 502, 503, 504];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function fetchWithTimeoutRetry(
  url: string,
  options: RuntimeHttpOptions = {},
): Promise<Response> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const retries = options.retries ?? 1;
  const retryDelayMs = options.retryDelayMs ?? 250;
  const retryOnStatuses = options.retryOnStatuses ?? DEFAULT_RETRY_STATUSES;

  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const response = await fetch(url, {
        ...options,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (attempt < retries && retryOnStatuses.includes(response.status)) {
        await sleep(retryDelayMs * (attempt + 1));
        continue;
      }
      return response;
    } catch (error) {
      lastError = error;
      if (attempt < retries) {
        await sleep(retryDelayMs * (attempt + 1));
        continue;
      }
    }
  }

  throw lastError instanceof Error ? lastError : new Error('HTTP request failed');
}
