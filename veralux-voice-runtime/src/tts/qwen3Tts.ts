import { log } from '../log';
import { fetchWithTimeoutRetry } from '../httpClient';
import type { TTSResult } from './types';

/**
 * Qwen3-TTS HTTP client — expects veralux-audio-stack/qwen3_tts_server.py (CustomVoice).
 */
export async function synthesizeSpeechQwen3(request: {
  text: string;
  qwen3TtsUrl: string;
  speaker?: string;
  language?: string;
  instruct?: string;
}): Promise<TTSResult> {
  const root = request.qwen3TtsUrl.replace(/\/$/, '');
  const endpoint = root.endsWith('/tts') ? root : `${root}/tts`;

  log.info(
    {
      event: 'tts_request',
      provider: 'qwen3_tts_http',
      speaker: request.speaker ?? null,
      language: request.language ?? null,
    },
    'qwen3 tts request',
  );

  const response = await fetchWithTimeoutRetry(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text: request.text,
      speaker: request.speaker,
      language: request.language,
      instruct: request.instruct,
    }),
    timeoutMs: 180_000,
    retries: 0,
  });

  const contentType = response.headers.get('content-type') ?? '';
  const arrayBuffer = await response.arrayBuffer();
  const raw = Buffer.from(arrayBuffer);

  if (!response.ok) {
    const bodyText = raw.toString('utf8');
    log.error({ status: response.status, body: bodyText.slice(0, 500) }, 'qwen3 tts error');
    throw new Error(`qwen3 tts error ${response.status}`);
  }

  return {
    audio: raw,
    contentType: contentType || 'audio/wav',
  };
}
