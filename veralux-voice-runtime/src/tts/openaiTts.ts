import { hasUsableApiKey } from '@veralux/shared';
import { env } from '../env';
import { log } from '../log';
import { fetchTenantOpenAiApiKey } from '../controlPlaneTenantSecrets';
import { fetchWithTimeoutRetry } from '../httpClient';
import type { TTSResult } from './types';

export async function synthesizeSpeechOpenAiTts(args: {
  text: string;
  voice?: string;
  model?: string;
  tenantId?: string;
}): Promise<TTSResult> {
  let apiKey = env.OPENAI_API_KEY;
  if (!hasUsableApiKey(apiKey) && args.tenantId) {
    apiKey = (await fetchTenantOpenAiApiKey(args.tenantId)) ?? undefined;
  }
  if (!hasUsableApiKey(apiKey)) {
    throw new Error('OpenAI TTS requires OPENAI_API_KEY or a tenant OpenAI BYOK key');
  }
  const voice = (args.voice || 'alloy').trim() || 'alloy';
  const model = (args.model || 'tts-1').trim() || 'tts-1';
  log.info({ event: 'tts_request', provider: 'openai_tts', voice, model }, 'tts request');
  const response = await fetchWithTimeoutRetry('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      voice,
      input: args.text,
      response_format: 'wav',
    }),
    timeoutMs: 20_000,
    retries: 1,
  });
  if (!response.ok) {
    const body = await response.text();
    log.error({ status: response.status, body }, 'openai tts error');
    throw new Error(`openai tts error ${response.status}`);
  }
  return {
    audio: Buffer.from(await response.arrayBuffer()),
    contentType: response.headers.get('content-type') ?? 'audio/wav',
  };
}
