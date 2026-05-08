import crypto from 'crypto';
import { env } from '../env';
import { log } from '../log';
import { getRedisClient } from '../redis/client';

function digest(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

async function claimKey(key: string, ttlSeconds: number): Promise<boolean> {
  const redis = getRedisClient();
  const claimed = await redis.set(key, '1', 'EX', ttlSeconds, 'NX');
  return claimed === 'OK';
}

export async function claimWebhookEventId(eventId: string): Promise<boolean> {
  const normalized = eventId.trim();
  if (!normalized) return true;
  const key = `${env.TELNYX_WEBHOOK_REPLAY_PREFIX}:evt:${digest(normalized)}`;
  return claimKey(key, env.TELNYX_WEBHOOK_IDEMPOTENCY_TTL_SECONDS);
}

export async function claimWebhookSignature(signature: string, timestamp: string): Promise<boolean> {
  const sig = signature.trim();
  const ts = timestamp.trim();
  if (!sig || !ts) return true;
  const key = `${env.TELNYX_WEBHOOK_REPLAY_PREFIX}:sig:${digest(`${ts}.${sig}`)}`;
  return claimKey(key, env.TELNYX_SIGNATURE_REPLAY_TTL_SECONDS);
}

export async function guardedClaim(
  fn: () => Promise<boolean>,
  context: Record<string, unknown>,
): Promise<boolean> {
  try {
    return await fn();
  } catch (error) {
    log.error({ err: error, ...context }, 'webhook replay guard check failed');
    throw error;
  }
}
