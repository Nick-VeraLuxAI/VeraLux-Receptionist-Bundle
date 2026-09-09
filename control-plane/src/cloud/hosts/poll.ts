/** Tests shrink these so missing host URLs fail fast instead of sleeping. */
export const hostPollDefaults = { attempts: 90, delayMs: 8000 };

export async function retryUntil<T>(
  fn: () => Promise<T | null | undefined>,
  opts?: { attempts?: number; delayMs?: number; label?: string },
): Promise<T> {
  const attempts = opts?.attempts ?? hostPollDefaults.attempts;
  const delayMs = opts?.delayMs ?? hostPollDefaults.delayMs;
  let last: T | null | undefined;
  for (let i = 0; i < attempts; i += 1) {
    last = await fn();
    if (last) return last;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  throw new Error(`${opts?.label || "retry"}_timeout`);
}
