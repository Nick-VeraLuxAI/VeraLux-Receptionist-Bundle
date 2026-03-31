import { env } from '../env';
import { log } from '../log';
import { TTSRequest, TTSResult } from './types';
import { fetchWithTimeoutRetry } from '../httpClient';

export async function synthesizeSpeech(request: TTSRequest): Promise<TTSResult> {
  const kokoroUrl = request.kokoroUrl ?? env.KOKORO_URL;
  if (!kokoroUrl) {
    throw new Error('KOKORO_URL or request.kokoroUrl is required for Kokoro TTS');
  }
  const sampleRate = request.sampleRate ?? env.TTS_SAMPLE_RATE;
  const format = request.format ?? 'wav';
  log.info(
    { event: 'tts_request', sample_rate: sampleRate, voice: request.voice, format },
    'tts request',
  );
  const payload: Record<string, unknown> = {
    text: request.text,
    voice: request.voice,
    format,
    sampleRate,
  };
  if (request.rate != null && Number.isFinite(request.rate)) {
    payload.rate = request.rate;
  }

  const response = await fetchWithTimeoutRetry(kokoroUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
    timeoutMs: 15_000,
    retries: 1,
  });

  if (!response.ok) {
    const body = await response.text();
    log.error({ status: response.status, body }, 'kokoro tts error');
    throw new Error(`kokoro tts error ${response.status}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  return {
    audio: Buffer.from(arrayBuffer),
    contentType: response.headers.get('content-type') ?? 'audio/wav',
  };
}