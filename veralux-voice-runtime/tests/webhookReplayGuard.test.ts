import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { setTestEnv } from './testEnv';
import { setRedisClient } from '../src/redis/client';

setTestEnv();

class FakeRedis {
  private readonly keys = new Map<string, number>();

  async set(key: string, _value: string, _ex: 'EX', ttlSeconds: number, _nx: 'NX'): Promise<'OK' | null> {
    const now = Date.now();
    const expiresAt = this.keys.get(key);
    if (expiresAt && expiresAt > now) {
      return null;
    }
    this.keys.set(key, now + ttlSeconds * 1000);
    return 'OK';
  }
}

afterEach(() => {
  setRedisClient(null);
});

test('rejects webhook signature replay attempts', async () => {
  const { claimWebhookSignature } = await import('../src/telnyx/webhookReplayGuard');
  setRedisClient(new FakeRedis() as any);

  const first = await claimWebhookSignature('abc123', '1710000000');
  const second = await claimWebhookSignature('abc123', '1710000000');

  assert.equal(first, true);
  assert.equal(second, false);
});

test('dedupes webhook event ids across retries', async () => {
  const { claimWebhookEventId } = await import('../src/telnyx/webhookReplayGuard');
  setRedisClient(new FakeRedis() as any);

  const first = await claimWebhookEventId('evt_123');
  const second = await claimWebhookEventId('evt_123');
  const other = await claimWebhookEventId('evt_456');

  assert.equal(first, true);
  assert.equal(second, false);
  assert.equal(other, true);
});
