import { createHash } from 'node:crypto';
import type { RuntimeTenantConfig } from '@veralux/shared';
import { env } from '../env';
import { log } from '../log';
import { incTtsCacheLookup } from '../metrics';
import { getRedisClient, type RedisClient } from '../redis/client';
import type { TTSRequest, TTSResult } from './types';

const CACHE_SCHEMA = 1;
const REDIS_VALUE_MAGIC = Buffer.from('VT1');

function stableStringify(obj: Record<string, unknown>): string {
  const keys = Object.keys(obj).sort();
  const ordered: Record<string, unknown> = {};
  for (const k of keys) {
    ordered[k] = obj[k];
  }
  return JSON.stringify(ordered);
}

/**
 * Canonical synthesis parameters — must match effective inputs to Kokoro / XTTS / Chatterbox.
 */
export function buildTtsCacheDescriptor(
  request: TTSRequest,
  config: RuntimeTenantConfig['tts'],
): Record<string, unknown> {
  const text = (request.text ?? '').trim();
  if (config.mode === 'chatterbox_http') {
    return {
      s: CACHE_SCHEMA,
      m: 'chatterbox_http',
      t: text,
      u: request.chatterboxUrl ?? config.chatterboxUrl,
      sp: request.speakerWavUrl ?? null,
      l: request.language ?? config.language ?? null,
      v: config.chatterboxVariant ?? null,
      stream: env.CHATTERBOX_STREAMING && env.CHATTERBOX_VARIANT === 'turbo',
    };
  }
  if (config.mode === 'coqui_xtts') {
    return {
      s: CACHE_SCHEMA,
      m: 'coqui_xtts',
      t: text,
      u: config.coquiXttsUrl,
      vo: request.voice ?? config.voice ?? null,
      sp: request.speakerWavUrl ?? config.speakerWavUrl ?? null,
      l: request.language ?? config.language ?? 'en',
      f: request.format ?? config.format ?? null,
      r: request.sampleRate ?? config.sampleRate ?? null,
      ct: request.coquiTemperature ?? config.coquiTemperature ?? null,
      cl: request.coquiLengthPenalty ?? config.coquiLengthPenalty ?? null,
      cr: request.coquiRepetitionPenalty ?? config.coquiRepetitionPenalty ?? null,
      ck: request.coquiTopK ?? config.coquiTopK ?? null,
      cp: request.coquiTopP ?? config.coquiTopP ?? null,
      cs:
        request.coquiSpeed ??
        config.coquiSpeed ??
        (config.mode === 'coqui_xtts' ? config.rate : undefined) ??
        null,
      cx: request.coquiSplitSentences ?? config.coquiSplitSentences ?? null,
      ss: env.COQUI_SINGLE_SPEAKER,
    };
  }
  if (config.mode === 'qwen3_tts_http') {
    const gen = {
      ds: request.qwen3DoSample ?? config.qwen3DoSample ?? null,
      temp: request.qwen3Temperature ?? config.qwen3Temperature ?? null,
      tp: request.qwen3TopP ?? config.qwen3TopP ?? null,
      tk: request.qwen3TopK ?? config.qwen3TopK ?? null,
      rp: request.qwen3RepetitionPenalty ?? config.qwen3RepetitionPenalty ?? null,
      mnt: request.qwen3MaxNewTokens ?? config.qwen3MaxNewTokens ?? null,
      nsm: request.qwen3NonStreamingMode ?? config.qwen3NonStreamingMode ?? null,
      sds: request.qwen3SubtalkerDoSample ?? config.qwen3SubtalkerDoSample ?? null,
      stk: request.qwen3SubtalkerTopK ?? config.qwen3SubtalkerTopK ?? null,
      stp: request.qwen3SubtalkerTopP ?? config.qwen3SubtalkerTopP ?? null,
      stt: request.qwen3SubtalkerTemperature ?? config.qwen3SubtalkerTemperature ?? null,
    };
    return {
      s: CACHE_SCHEMA,
      m: 'qwen3_tts_http',
      t: text,
      u: request.qwen3TtsUrl ?? config.qwen3TtsUrl,
      spk: request.voice ?? config.speaker ?? null,
      l: request.language ?? config.language ?? null,
      i: request.instruct ?? config.instruct ?? null,
      ...gen,
    };
  }
  const kokoro = config.mode === 'kokoro_http' ? config : undefined;
  return {
    s: CACHE_SCHEMA,
    m: 'kokoro_http',
    t: text,
    u: request.kokoroUrl ?? kokoro?.kokoroUrl ?? env.KOKORO_URL,
    v: request.voice ?? kokoro?.voice ?? null,
    f: request.format ?? kokoro?.format ?? 'wav',
    sr: request.sampleRate ?? kokoro?.sampleRate ?? env.TTS_SAMPLE_RATE,
    spd: request.rate ?? kokoro?.rate ?? null,
  };
}

export function ttsCacheKeyHash(descriptor: Record<string, unknown>): string {
  return createHash('sha256').update(stableStringify(descriptor)).digest('hex');
}

/** Binary Redis value: magic + u16 content-type length + UTF-8 content-type + raw audio. */
export function encodeTtsRedisCachePayload(contentType: string, audio: Buffer): Buffer {
  const ct = Buffer.from(contentType, 'utf8');
  if (ct.length > 65535) {
    throw new Error('tts cache: content-type too long');
  }
  const len = Buffer.allocUnsafe(2);
  len.writeUInt16BE(ct.length, 0);
  return Buffer.concat([REDIS_VALUE_MAGIC, len, ct, audio]);
}

export function decodeTtsRedisCachePayload(raw: Buffer): TTSResult | null {
  if (raw.length < REDIS_VALUE_MAGIC.length + 2) {
    return null;
  }
  if (!raw.subarray(0, REDIS_VALUE_MAGIC.length).equals(REDIS_VALUE_MAGIC)) {
    return null;
  }
  const ctLen = raw.readUInt16BE(REDIS_VALUE_MAGIC.length);
  const ctStart = REDIS_VALUE_MAGIC.length + 2;
  const audioStart = ctStart + ctLen;
  if (audioStart > raw.length) {
    return null;
  }
  const contentType = raw.subarray(ctStart, audioStart).toString('utf8');
  const audio = Buffer.from(raw.subarray(audioStart));
  return { contentType, audio };
}

class LruTtsCache {
  private readonly map = new Map<string, TTSResult>();
  private bytes = 0;

  constructor(
    private readonly maxEntries: number,
    private readonly maxBytes: number,
  ) {}

  get(key: string): TTSResult | undefined {
    const hit = this.map.get(key);
    if (!hit) {
      return undefined;
    }
    this.map.delete(key);
    this.map.set(key, hit);
    return {
      contentType: hit.contentType,
      audio: Buffer.from(hit.audio),
    };
  }

  set(key: string, value: TTSResult, entryMaxBytes: number): void {
    const size = value.audio.length;
    if (size > entryMaxBytes) {
      return;
    }
    const existing = this.map.get(key);
    if (existing) {
      this.map.delete(key);
      this.bytes -= existing.audio.length;
    }
    const stored: TTSResult = {
      contentType: value.contentType,
      audio: Buffer.from(value.audio),
    };
    this.map.set(key, stored);
    this.bytes += stored.audio.length;
    this.evict(entryMaxBytes);
  }

  private evict(entryMaxBytes: number): void {
    while (this.map.size > this.maxEntries || this.bytes > this.maxBytes) {
      const first = this.map.keys().next().value as string | undefined;
      if (first === undefined) {
        break;
      }
      const v = this.map.get(first);
      this.map.delete(first);
      if (v) {
        this.bytes -= v.audio.length;
      }
    }
  }
}

let lruSingleton: LruTtsCache | null = null;

function getLru(): LruTtsCache {
  if (!lruSingleton) {
    lruSingleton = new LruTtsCache(env.TTS_CACHE_LRU_MAX_ENTRIES, env.TTS_CACHE_LRU_MAX_BYTES);
  }
  return lruSingleton;
}

function redisKey(hash: string): string {
  return `${env.TTS_CACHE_PREFIX}:${hash}`;
}

async function readRedis(redis: RedisClient, hash: string): Promise<TTSResult | null> {
  const key = redisKey(hash);
  const raw = await redis.getBuffer(key);
  if (!raw || raw.length === 0) {
    return null;
  }
  return decodeTtsRedisCachePayload(raw);
}

async function writeRedis(redis: RedisClient, hash: string, result: TTSResult): Promise<void> {
  const payload = encodeTtsRedisCachePayload(result.contentType, result.audio);
  const key = redisKey(hash);
  await redis.set(key, payload, 'EX', env.TTS_CACHE_REDIS_TTL_SECONDS);
}

export async function getCachedTts(
  hash: string,
  redis: RedisClient | null,
): Promise<TTSResult | null> {
  if (!env.TTS_CACHE_ENABLED) {
    return null;
  }
  const lruHit = env.TTS_CACHE_LRU_ENABLED ? getLru().get(hash) : undefined;
  if (lruHit) {
    incTtsCacheLookup('lru_hit');
    log.debug({ event: 'tts_cache_hit', layer: 'lru' }, 'tts cache hit');
    return lruHit;
  }
  if (env.TTS_CACHE_REDIS_ENABLED && redis) {
    try {
      const fromRedis = await readRedis(redis, hash);
      if (fromRedis) {
        incTtsCacheLookup('redis_hit');
        log.debug({ event: 'tts_cache_hit', layer: 'redis' }, 'tts cache hit');
        if (env.TTS_CACHE_LRU_ENABLED) {
          getLru().set(hash, fromRedis, env.TTS_CACHE_MAX_ENTRY_BYTES);
        }
        return {
          contentType: fromRedis.contentType,
          audio: Buffer.from(fromRedis.audio),
        };
      }
    } catch (err) {
      log.warn({ err, event: 'tts_cache_redis_get_error' }, 'tts cache redis get failed');
    }
  }
  incTtsCacheLookup('miss');
  return null;
}

export async function setCachedTts(
  hash: string,
  result: TTSResult,
  redis: RedisClient | null,
): Promise<void> {
  if (!env.TTS_CACHE_ENABLED) {
    return;
  }
  if (result.audio.length > env.TTS_CACHE_MAX_ENTRY_BYTES) {
    return;
  }
  if (env.TTS_CACHE_LRU_ENABLED) {
    getLru().set(hash, result, env.TTS_CACHE_MAX_ENTRY_BYTES);
  }
  if (env.TTS_CACHE_REDIS_ENABLED && redis) {
    try {
      await writeRedis(redis, hash, result);
    } catch (err) {
      log.warn({ err, event: 'tts_cache_redis_set_error' }, 'tts cache redis set failed');
    }
  }
}

export function getTtsCacheRedisClient(): RedisClient | null {
  if (!env.TTS_CACHE_ENABLED || !env.TTS_CACHE_REDIS_ENABLED) {
    return null;
  }
  return getRedisClient();
}
