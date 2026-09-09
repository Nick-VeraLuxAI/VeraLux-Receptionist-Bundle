import { env } from '../env';
import type { RuntimeTenantConfig } from '@veralux/shared';

const KOKORO_VOICE = /^(a[fm]_|b[fm]_)[a-z]+$/i;

export type KokoroRuntimeTts = Extract<RuntimeTenantConfig['tts'], { mode: 'kokoro_http' }>;

export function isKokoroVoiceId(voice: string | undefined | null): boolean {
  return KOKORO_VOICE.test(String(voice || '').trim());
}

/** Kokoro is the only live TTS path. Any other tenant/env mode is coerced. */
export function forceKokoroTtsConfig(
  input?: RuntimeTenantConfig['tts'] | null,
): KokoroRuntimeTts {
  const fromKokoro = input && input.mode === 'kokoro_http' ? input : undefined;
  const kokoroUrl = (
    fromKokoro?.kokoroUrl ||
    env.KOKORO_URL ||
    'http://kokoro:7001/tts'
  ).trim();
  const candidate =
    fromKokoro?.voice ||
    env.KOKORO_VOICE_ID ||
    'af_bella';
  return {
    mode: 'kokoro_http',
    kokoroUrl,
    voice: isKokoroVoiceId(candidate) ? candidate : env.KOKORO_VOICE_ID || 'af_bella',
    format: 'wav',
    sampleRate: fromKokoro?.sampleRate ?? env.TTS_SAMPLE_RATE,
    rate: fromKokoro?.rate ?? env.KOKORO_RATE,
  };
}

export function forceKokoroTenantConfig<T extends { tts: RuntimeTenantConfig['tts'] }>(config: T): T {
  return { ...config, tts: forceKokoroTtsConfig(config.tts) };
}
