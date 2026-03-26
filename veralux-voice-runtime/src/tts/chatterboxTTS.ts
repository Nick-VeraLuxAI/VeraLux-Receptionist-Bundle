import { log } from '../log';
import { TTSRequest, TTSResult } from './types';
import { fetchWithTimeoutRetry } from '../httpClient';

export type ChatterboxSynthesizeInput = {
  text: string;
  chatterboxUrl: string;
  speakerWavUrl?: string;
  language?: string;
};

/**
 * Chatterbox HTTP client — expects veralux-audio-stack/chatterbox_server.py (or compatible).
 */
export async function synthesizeSpeechChatterbox(
  request: ChatterboxSynthesizeInput,
): Promise<TTSResult> {
  const url = request.chatterboxUrl.replace(/\/$/, '');
  const endpoint = url.endsWith('/tts') ? url : `${url}/tts`;

  const body: Record<string, string | undefined> = {
    text: request.text,
    speaker_wav_url: request.speakerWavUrl,
    language_id: request.language,
  };

  log.info(
    {
      event: 'tts_request',
      provider: 'chatterbox_http',
      has_speaker: !!request.speakerWavUrl,
      language: request.language ?? null,
    },
    'chatterbox tts request',
  );

  const response = await fetchWithTimeoutRetry(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    timeoutMs: 120_000,
    retries: 0,
  });

  const contentType = response.headers.get('content-type') ?? '';
  const arrayBuffer = await response.arrayBuffer();
  const raw = Buffer.from(arrayBuffer);

  if (!response.ok) {
    const bodyText = raw.toString('utf8');
    log.error({ status: response.status, body: bodyText }, 'chatterbox tts error');
    throw new Error(`chatterbox tts error ${response.status}`);
  }

  if (contentType.includes('application/json')) {
    let errMsg: string;
    try {
      const json = JSON.parse(raw.toString('utf8')) as { error?: string; detail?: string };
      errMsg = json.error ?? json.detail ?? raw.toString('utf8');
    } catch {
      errMsg = raw.toString('utf8');
    }
    throw new Error(`chatterbox tts: ${errMsg}`);
  }

  return {
    audio: raw,
    contentType: contentType || 'audio/wav',
  };
}
