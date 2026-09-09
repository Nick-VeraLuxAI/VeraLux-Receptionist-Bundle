export async function waitUntilHealthy(input: {
  controlUrl: string;
  runtimeUrl: string;
  timeoutMs?: number;
  intervalMs?: number;
  fetchImpl?: typeof fetch;
}): Promise<void> {
  const timeoutMs = input.timeoutMs ?? 8 * 60_000;
  const intervalMs = input.intervalMs ?? 4000;
  const fetchImpl = input.fetchImpl ?? fetch;
  const control = `${input.controlUrl.replace(/\/$/, "")}/health`;
  const runtime = `${input.runtimeUrl.replace(/\/$/, "")}/health/live`;
  const started = Date.now();
  let lastErr = "health_not_ok";
  while (Date.now() - started < timeoutMs) {
    const controlOk = await probe(fetchImpl, control);
    const runtimeOk = await probe(fetchImpl, runtime);
    if (controlOk && runtimeOk) return;
    lastErr = `health_pending control=${controlOk} runtime=${runtimeOk}`;
    await sleep(intervalMs);
  }
  throw new Error(`wait_healthy_timeout: ${lastErr}`);
}

async function probe(fetchImpl: typeof fetch, url: string): Promise<boolean> {
  try {
    const res = await fetchImpl(url, { method: "GET" });
    return res.ok;
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
