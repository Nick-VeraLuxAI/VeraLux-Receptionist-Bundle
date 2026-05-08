import { log } from '../log';

type State = 'closed' | 'open' | 'half_open';

interface BreakerState {
  state: State;
  failures: number;
  openedAtMs: number;
}

const states = new Map<string, BreakerState>();

function now(): number {
  return Date.now();
}

function getState(key: string): BreakerState {
  const existing = states.get(key);
  if (existing) return existing;
  const initial: BreakerState = { state: 'closed', failures: 0, openedAtMs: 0 };
  states.set(key, initial);
  return initial;
}

export function resetCircuitBreakersForTests(): void {
  states.clear();
}

export function withCircuitBreaker<T>(opts: {
  key: string;
  failureThreshold: number;
  openMs: number;
  action: () => Promise<T>;
  onOpen?: (key: string) => void;
}): Promise<T> {
  const st = getState(opts.key);
  const current = now();

  if (st.state === 'open') {
    if (current - st.openedAtMs < opts.openMs) {
      const err = new Error(`circuit_open:${opts.key}`);
      (err as Error & { code?: string }).code = 'CIRCUIT_OPEN';
      return Promise.reject(err);
    }
    st.state = 'half_open';
  }

  return opts.action()
    .then((result) => {
      st.state = 'closed';
      st.failures = 0;
      st.openedAtMs = 0;
      return result;
    })
    .catch((error) => {
      st.failures += 1;
      if (st.failures >= opts.failureThreshold) {
        st.state = 'open';
        st.openedAtMs = now();
        opts.onOpen?.(opts.key);
        log.warn({ event: 'provider_circuit_open', circuit_key: opts.key }, 'provider circuit breaker opened');
      }
      throw error;
    });
}
