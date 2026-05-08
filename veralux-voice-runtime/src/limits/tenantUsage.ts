import { env } from '../env';
import { log } from '../log';
import { getRedisClient, type RedisClient } from '../redis/client';
import type { RuntimeTenantConfig } from '../tenants/tenantConfig';
import {
  incTenantBillingSuspended,
  incUsageHardCapReached,
  incUsageLimitAllowed,
  incUsageLimitBlocked,
  incUsageLimitChecked,
  incUsageSoftOverage,
} from '../metrics';

function dayKey(now = new Date()): string {
  return now.toISOString().slice(0, 10).replace(/-/g, '');
}
function monthKey(now = new Date()): string {
  return now.toISOString().slice(0, 7);
}

function callsDayCounterKey(tenantId: string, now = new Date()): string {
  return `${env.CAP_PREFIX}:usage:${tenantId}:day:${dayKey(now)}:calls`;
}
function callsMonthCounterKey(tenantId: string, now = new Date()): string {
  return `${env.CAP_PREFIX}:usage:${tenantId}:month:${monthKey(now)}:calls`;
}
function minutesMonthCounterKey(tenantId: string, now = new Date()): string {
  return `${env.CAP_PREFIX}:usage:${tenantId}:month:${monthKey(now)}:minutes`;
}
function endSeenKey(tenantId: string, callControlId: string): string {
  return `${env.CAP_PREFIX}:usage:${tenantId}:ended:${callControlId}`;
}

async function readInt(redis: RedisClient, key: string): Promise<number> {
  const raw = await redis.get(key);
  const parsed = Number(raw ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

async function incrWithTtl(redis: RedisClient, key: string, ttlSec: number, by = 1): Promise<void> {
  const n = await redis.incrby(key, by);
  if (n === by) {
    await redis.expire(key, ttlSec);
  }
}

export async function checkTenantUsageBeforeCall(params: {
  tenantId: string;
  tenantConfig: RuntimeTenantConfig;
  redis?: RedisClient;
}): Promise<{ ok: true; softOverage: boolean } | { ok: false; reason: string; message: string }> {
  const { tenantId, tenantConfig } = params;
  const limits = (tenantConfig as any).usageLimits as any;
  if (!limits) return { ok: true, softOverage: false };
  incUsageLimitChecked(tenantId);

  if (limits.billingStatus === 'suspended' || limits.billingStatus === 'canceled') {
    incTenantBillingSuspended(tenantId);
    incUsageLimitBlocked(tenantId, 'tenant_billing_suspended');
    return { ok: false, reason: 'tenant_billing_suspended', message: 'This business account is not active right now.' };
  }

  const redis = params.redis ?? getRedisClient();
  const now = new Date();
  const [dailyCalls, monthlyCalls, monthlyMinutes] = await Promise.all([
    readInt(redis, callsDayCounterKey(tenantId, now)),
    readInt(redis, callsMonthCounterKey(tenantId, now)),
    readInt(redis, minutesMonthCounterKey(tenantId, now)),
  ]);

  if (dailyCalls >= Number(limits.maxDailyCalls ?? 0)) {
    incUsageLimitBlocked(tenantId, 'max_daily_calls');
    return { ok: false, reason: 'max_daily_calls', message: 'Daily call limit reached for this business.' };
  }
  if (monthlyCalls >= Number(limits.maxMonthlyCalls ?? 0)) {
    incUsageLimitBlocked(tenantId, 'max_monthly_calls');
    return { ok: false, reason: 'max_monthly_calls', message: 'Monthly call limit reached for this business.' };
  }
  if (monthlyMinutes >= Number(limits.maxMonthlyMinutesHardCap ?? 0)) {
    incUsageHardCapReached(tenantId);
    incUsageLimitBlocked(tenantId, 'max_monthly_minutes_hard_cap');
    return { ok: false, reason: 'max_monthly_minutes_hard_cap', message: 'Monthly usage cap reached for this business.' };
  }

  if (monthlyMinutes > Number(limits.includedMonthlyMinutes ?? 0)) {
    if (limits.overageMode === 'hard_stop') {
      incUsageHardCapReached(tenantId);
      incUsageLimitBlocked(tenantId, 'overage_hard_stop');
      return { ok: false, reason: 'overage_hard_stop', message: 'Included minutes exceeded for this business.' };
    }
    if (limits.overageMode === 'throttle') {
      incUsageLimitBlocked(tenantId, 'overage_throttle');
      return { ok: false, reason: 'overage_throttle', message: 'This business is temporarily throttled due to usage.' };
    }
    incUsageSoftOverage(tenantId);
    incUsageLimitAllowed(tenantId);
    return { ok: true, softOverage: true };
  }

  incUsageLimitAllowed(tenantId);
  return { ok: true, softOverage: false };
}

export async function recordTenantUsageCallStart(tenantId: string, redis: RedisClient = getRedisClient()): Promise<void> {
  const now = new Date();
  await Promise.all([
    incrWithTtl(redis, callsDayCounterKey(tenantId, now), 60 * 60 * 48),
    incrWithTtl(redis, callsMonthCounterKey(tenantId, now), 60 * 60 * 24 * 62),
  ]).catch((error) => {
    log.warn({ err: error, tenant_id: tenantId }, 'failed to record usage call start');
  });
}

export async function recordTenantUsageCallEnd(
  tenantId: string,
  callControlId: string,
  durationMs: number,
  redis: RedisClient = getRedisClient(),
): Promise<void> {
  const seen = await redis
    .set(endSeenKey(tenantId, callControlId), '1', 'EX', 60 * 60 * 24 * 7, 'NX')
    .catch(() => null);
  if (seen !== 'OK') {
    return;
  }
  const minutes = Math.max(0, Math.ceil(durationMs / 60000));
  const now = new Date();
  await incrWithTtl(redis, minutesMonthCounterKey(tenantId, now), 60 * 60 * 24 * 62, minutes).catch((error) => {
    log.warn({ err: error, tenant_id: tenantId }, 'failed to record usage call end');
  });
}
