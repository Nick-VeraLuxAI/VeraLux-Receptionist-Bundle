export interface HttpRequestOptions extends Omit<RequestInit, "signal"> {
  timeoutMs?: number;
  retries?: number;
  retryDelayMs?: number;
  retryOnStatuses?: number[];
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_RETRIES = 2;
const DEFAULT_RETRY_DELAY_MS = 250;

const DEFAULT_RETRY_STATUSES = [408, 425, 429, 500, 502, 503, 504];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shouldRetryStatus(status: number, retryOnStatuses: number[]): boolean {
  return retryOnStatuses.includes(status);
}

export async function fetchWithTimeoutRetry(
  url: string,
  options: HttpRequestOptions = {},
): Promise<Response> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const retries = options.retries ?? DEFAULT_RETRIES;
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const retryOnStatuses = options.retryOnStatuses ?? DEFAULT_RETRY_STATUSES;

  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const response = await fetch(url, {
        ...options,
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (attempt < retries && shouldRetryStatus(response.status, retryOnStatuses)) {
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

  throw lastError instanceof Error ? lastError : new Error("HTTP request failed");
}
