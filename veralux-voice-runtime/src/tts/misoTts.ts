import { fetchWithTimeoutRetry } from '../httpClient';
import { log } from '../log';
import type { TTSResult } from './types';

export type MisoTtsInput = {
  text: string;
  misoTtsUrl: string;
  speaker?: string;
  speakerWavUrl?: string;
  speakerText?: string;
  maxAudioLengthMs?: number;
  temperature?: number;
  topK?: number;
};

function parseSpeakerId(speaker: string | undefined): number | undefined {
  if (!speaker?.trim()) return undefined;
  const n = Number.parseInt(speaker.trim(), 10);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

/**
 * Miso TTS HTTP client — expects veralux-audio-stack/miso_tts_server.py.
 */
export async function synthesizeSpeechMiso(request: MisoTtsInput): Promise<TTSResult> {
  const root = request.misoTtsUrl.replace(/\/$/, '');
  const endpoint = root.endsWith('/tts') ? root : `${root}/tts`;
  const speaker = parseSpeakerId(request.speaker);

  log.info(
    {
      event: 'tts_request',
      provider: 'miso_tts_http',
      speaker: speaker ?? null,
      has_prompt_audio: Boolean(request.speakerWavUrl),
    },
    'miso tts request',
  );

  const body: Record<string, string | number | undefined> = {
    text: request.text,
    speaker,
    speaker_wav_url: request.speakerWavUrl,
    speaker_text: request.speakerText,
    max_audio_length_ms: request.maxAudioLengthMs,
    temperature: request.temperature,
    top_k: request.topK,
  };

  const response = await fetchWithTimeoutRetry(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    timeoutMs: 180_000,
    retries: 0,
  });

  const contentType = response.headers.get('content-type') ?? '';
  const arrayBuffer = await response.arrayBuffer();
  const raw = Buffer.from(arrayBuffer);

  if (!response.ok) {
    const bodyText = raw.toString('utf8');
    log.error({ status: response.status, body: bodyText.slice(0, 500) }, 'miso tts error');
    throw new Error(`miso tts error ${response.status}`);
  }

  if (contentType.includes('application/json')) {
    let errMsg: string;
    try {
      const json = JSON.parse(raw.toString('utf8')) as { error?: string; detail?: string };
      errMsg = json.error ?? json.detail ?? raw.toString('utf8');
    } catch {
      errMsg = raw.toString('utf8');
    }
    throw new Error(`miso tts: ${errMsg}`);
  }

  return {
    audio: raw,
    contentType: contentType || 'audio/wav',
  };
}
