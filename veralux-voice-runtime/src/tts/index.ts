import { parseWavInfo } from '../audio/wavInfo';
import { env } from '../env';
import { log } from '../log';
import type { RuntimeTenantConfig } from '../tenants/tenantConfig';
import {
  buildTtsCacheDescriptor,
  getCachedTts,
  getTtsCacheRedisClient,
  setCachedTts,
  ttsCacheKeyHash,
} from './cache';
import { synthesizeSpeech as synthesizeKokoro } from './kokoroTTS';
import { forceKokoroTtsConfig, isKokoroVoiceId } from './forceKokoro';
import type { TTSRequest, TTSResult } from './types';
export { tryPlayKokoroStreamToTelnyx } from './kokoroStreamPlay';
export type { KokoroStreamPlayResult } from './kokoroStreamPlay';

/** Build TTS config from .env when no tenant config is set. Kokoro is the only live path. */
function ttsConfigFromEnv(): RuntimeTenantConfig['tts'] {
  return forceKokoroTtsConfig(null);
}

/**
 * Synthesize speech. Kokoro is the only live TTS path; other tenant/env modes are coerced.
 */
export async function synthesizeSpeech(
  request: TTSRequest,
  ttsConfig?: RuntimeTenantConfig['tts'] | null,
): Promise<TTSResult> {
  const config = forceKokoroTtsConfig(ttsConfig ?? ttsConfigFromEnv());

  const trimmedText = (request.text ?? '').trim();
  const cacheEligible = env.TTS_CACHE_ENABLED && trimmedText.length > 0;
  const cacheRedis = cacheEligible ? getTtsCacheRedisClient() : null;
  const cacheHash = cacheEligible ? ttsCacheKeyHash(buildTtsCacheDescriptor(request, config)) : '';

  if (cacheEligible) {
    const cached = await getCachedTts(cacheHash, cacheRedis);
    if (cached) {
      return cached;
    }
  }

  const voice = isKokoroVoiceId(request.voice) ? request.voice! : config.voice;
  const result = await synthesizeKokoro({
    text: request.text,
    voice,
    format: request.format ?? config.format,
    sampleRate: request.sampleRate ?? config.sampleRate,
    kokoroUrl: config.kokoroUrl ?? request.kokoroUrl,
    rate: request.rate ?? config.rate,
  });

  if (result.contentType?.toLowerCase().includes('wav') && result.audio.length >= 44) {
    try {
      const wavInfo = parseWavInfo(result.audio);
      log.info(
        { event: 'tts_sample_rate', sample_rate_hz: wavInfo.sampleRateHz, provider: 'kokoro_http' },
        'TTS output sample rate',
      );
    } catch {
      // ignore parse errors; log is best-effort
    }
  }

  if (cacheEligible) {
    await setCachedTts(cacheHash, result, cacheRedis);
  }

  return result;
}

export type { TTSRequest, TTSResult } from './types';
