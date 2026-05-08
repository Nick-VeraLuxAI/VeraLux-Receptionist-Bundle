import assert from 'node:assert/strict';
import { test } from 'node:test';
import './testEnv';
import { checkTenantUsageBeforeCall, recordTenantUsageCallEnd } from '../src/limits/tenantUsage';

class FakeRedis {
  private data = new Map<string, number>();
  private suffixData = new Map<string, number>();
  async get(key: string): Promise<string | null> {
    for (const [suffix, value] of this.suffixData.entries()) {
      if (key.endsWith(suffix)) return String(value);
    }
    const v = this.data.get(key);
    return typeof v === 'number' ? String(v) : null;
  }
  async incrby(key: string, by: number): Promise<number> {
    const next = (this.data.get(key) ?? 0) + by;
    this.data.set(key, next);
    return next;
  }
  async expire(_key: string, _ttl: number): Promise<number> {
    return 1;
  }
  async set(key: string, value: string, a?: string, b?: string | number, c?: string | number): Promise<string | null> {
    const _ = { value, a, b, c };
    const hasNx = a === 'NX' || b === 'NX' || c === 'NX';
    if (hasNx && this.data.has(key)) return null;
    this.data.set(key, 1);
    return 'OK';
  }
  setNum(key: string, n: number): void {
    this.data.set(key, n);
  }
  setNumBySuffix(suffix: string, n: number): void {
    this.suffixData.set(suffix, n);
  }
}

function cfg(overrides: Record<string, unknown> = {}): any {
  return {
    usageLimits: {
      billingStatus: 'active',
      maxDailyCalls: 10,
      maxMonthlyCalls: 100,
      maxMonthlyMinutesHardCap: 1000,
      includedMonthlyMinutes: 100,
      overageMode: 'allow_and_bill',
      ...overrides,
    },
  };
}

test('blocks suspended billing tenants', async () => {
  const redis = new FakeRedis() as any;
  const result = await checkTenantUsageBeforeCall({
    tenantId: 't1',
    tenantConfig: cfg({ billingStatus: 'suspended' }),
    redis,
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, 'tenant_billing_suspended');
});

test('allows soft overage with allow_and_bill', async () => {
  const redis = new FakeRedis();
  redis.setNumBySuffix(':month:' + new Date().toISOString().slice(0, 7) + ':minutes', 150);
  const result = await checkTenantUsageBeforeCall({
    tenantId: 't2',
    tenantConfig: cfg({ includedMonthlyMinutes: 100, overageMode: 'allow_and_bill' }),
    redis: redis as any,
  });
  assert.equal(result.ok, true);
});

test('blocks overage when mode is hard_stop', async () => {
  const redis = new FakeRedis();
  redis.setNumBySuffix(':month:' + new Date().toISOString().slice(0, 7) + ':minutes', 150);
  const result = await checkTenantUsageBeforeCall({
    tenantId: 't3',
    tenantConfig: cfg({ includedMonthlyMinutes: 100, overageMode: 'hard_stop' }),
    redis: redis as any,
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, 'overage_hard_stop');
});

test('dedupes duplicate call end billing updates', async () => {
  const redis = new FakeRedis() as any;
  await recordTenantUsageCallEnd('t4', 'call-1', 120_000, redis);
  await recordTenantUsageCallEnd('t4', 'call-1', 120_000, redis);
  const month = new Date().toISOString().slice(0, 7);
  const minutes = Number(await redis.get(`cap:usage:t4:month:${month}:minutes`));
  assert.equal(minutes, 2);
});
