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
import { synthesizeSpeechCoquiXtts } from './coquiXtts';
import { synthesizeSpeechChatterbox } from './chatterboxTTS';
import { synthesizeSpeechQwen3 } from './qwen3Tts';
import type { TTSRequest, TTSResult } from './types';

/** Build TTS config from .env when no tenant config is set. Kokoro and Coqui use separate voice defaults. */
function ttsConfigFromEnv(): RuntimeTenantConfig['tts'] {
  if (env.TTS_MODE === 'coqui_xtts') {
    return {
      mode: 'coqui_xtts',
      coquiXttsUrl: env.COQUI_XTTS_URL!,
      voice: env.COQUI_VOICE_ID ?? 'en_sample',
      language: 'en',
      coquiTemperature: env.COQUI_TEMPERATURE,
      coquiLengthPenalty: env.COQUI_LENGTH_PENALTY,
      coquiRepetitionPenalty: env.COQUI_REPETITION_PENALTY,
      coquiTopK: env.COQUI_TOP_K,
      coquiTopP: env.COQUI_TOP_P,
      coquiSpeed: env.COQUI_SPEED,
      coquiSplitSentences: env.COQUI_SPLIT_SENTENCES,
    };
  }
  if (env.TTS_MODE === 'chatterbox_http') {
    return {
      mode: 'chatterbox_http',
      chatterboxUrl: env.CHATTERBOX_URL!,
      chatterboxVariant: env.CHATTERBOX_VARIANT,
      voice: env.CHATTERBOX_VOICE_ID,
      language: env.CHATTERBOX_LANGUAGE ?? 'en',
      format: 'wav',
      sampleRate: env.TTS_SAMPLE_RATE,
    };
  }
  if (env.TTS_MODE === 'qwen3_tts_http') {
    return {
      mode: 'qwen3_tts_http',
      qwen3TtsUrl: env.QWEN3_TTS_URL!,
      speaker: env.QWEN3_TTS_SPEAKER ?? 'Ryan',
      language: env.QWEN3_TTS_LANGUAGE ?? 'English',
      instruct: env.QWEN3_TTS_INSTRUCT,
      format: 'wav',
      sampleRate: env.TTS_SAMPLE_RATE,
    };
  }
  return {
    mode: 'kokoro_http',
    kokoroUrl: env.KOKORO_URL!,
    voice: env.KOKORO_VOICE_ID ?? 'af_bella',
    format: 'wav',
    sampleRate: env.TTS_SAMPLE_RATE,
  };
}

/**
 * Synthesize speech using the TTS backend selected by tenant config or .env.
 * When ttsConfig is provided, uses it; otherwise uses TTS_MODE, KOKORO_URL, and COQUI_XTTS_URL from .env.
 */
export async function synthesizeSpeech(
  request: TTSRequest,
  ttsConfig?: RuntimeTenantConfig['tts'] | null,
): Promise<TTSResult> {
  const config = ttsConfig ?? ttsConfigFromEnv();

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

  let result: TTSResult;
  if (config.mode === 'chatterbox_http') {
    result = await synthesizeSpeechChatterbox({
      text: request.text,
      chatterboxUrl: request.chatterboxUrl ?? config.chatterboxUrl,
      speakerWavUrl: request.speakerWavUrl,
      language: request.language ?? config.language,
    });
  } else if (config.mode === 'coqui_xtts') {
    result = await synthesizeSpeechCoquiXtts({
      text: request.text,
      voice: request.voice ?? config.voice,
      coquiXttsUrl: config.coquiXttsUrl,
      speakerWavUrl: request.speakerWavUrl ?? config.speakerWavUrl,
      language: request.language ?? config.language,
      format: request.format ?? config.format,
      sampleRate: request.sampleRate ?? config.sampleRate,
      coquiTemperature: request.coquiTemperature ?? config.coquiTemperature,
      coquiLengthPenalty: request.coquiLengthPenalty ?? config.coquiLengthPenalty,
      coquiRepetitionPenalty: request.coquiRepetitionPenalty ?? config.coquiRepetitionPenalty,
      coquiTopK: request.coquiTopK ?? config.coquiTopK,
      coquiTopP: request.coquiTopP ?? config.coquiTopP,
      coquiSpeed: request.coquiSpeed ?? config.coquiSpeed,
      coquiSplitSentences: request.coquiSplitSentences ?? config.coquiSplitSentences,
    });
  } else if (config.mode === 'qwen3_tts_http') {
    result = await synthesizeSpeechQwen3({
      text: request.text,
      qwen3TtsUrl: request.qwen3TtsUrl ?? config.qwen3TtsUrl,
      speaker: request.voice ?? config.speaker,
      language: request.language ?? config.language,
      instruct: request.instruct ?? config.instruct,
    });
  } else {
    const kokoroConfig = config.mode === 'kokoro_http' ? config : undefined;
    result = await synthesizeKokoro({
      text: request.text,
      voice: request.voice ?? kokoroConfig?.voice,
      format: request.format ?? kokoroConfig?.format,
      sampleRate: request.sampleRate ?? kokoroConfig?.sampleRate,
      kokoroUrl: kokoroConfig?.kokoroUrl ?? request.kokoroUrl,
    });
  }

  if (result.contentType?.toLowerCase().includes('wav') && result.audio.length >= 44) {
    try {
      const wavInfo = parseWavInfo(result.audio);
      log.info(
        { event: 'tts_sample_rate', sample_rate_hz: wavInfo.sampleRateHz, provider: config.mode },
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
