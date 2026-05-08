import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resetCircuitBreakersForTests, withCircuitBreaker } from '../src/providers/circuitBreaker';

test('circuit breaker opens after threshold and recovers after open window', async () => {
  resetCircuitBreakersForTests();
  let attempts = 0;

  await assert.rejects(
    () =>
      withCircuitBreaker({
        key: 'brain_test',
        failureThreshold: 2,
        openMs: 30,
        action: async () => {
          attempts += 1;
          throw new Error('boom');
        },
      }),
  );

  await assert.rejects(
    () =>
      withCircuitBreaker({
        key: 'brain_test',
        failureThreshold: 2,
        openMs: 30,
        action: async () => {
          attempts += 1;
          throw new Error('boom');
        },
      }),
  );

  await assert.rejects(
    () =>
      withCircuitBreaker({
        key: 'brain_test',
        failureThreshold: 2,
        openMs: 30,
        action: async () => 'ok',
      }),
    /circuit_open/,
  );

  await new Promise((r) => setTimeout(r, 35));

  const ok = await withCircuitBreaker({
    key: 'brain_test',
    failureThreshold: 2,
    openMs: 30,
    action: async () => 'ok',
  });
  assert.equal(ok, 'ok');
  assert.equal(attempts, 2);
});
