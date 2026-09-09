import { fetchWithTimeoutRetry } from '../httpClient';
import { log } from '../log';
import type { TTSResult } from './types';

export type MeloTtsInput = {
  text: string;
  meloTtsUrl: string;
  speaker?: string;
  language?: string;
  speed?: number;
  sdpRatio?: number;
  noiseScale?: number;
  noiseScaleW?: number;
};

function meloBaseUrl(url: string): string {
  return url.replace(/\/$/, '').replace(/\/tts$/i, '');
}

/**
 * MeloTTS HTTP client — expects veralux-audio-stack/melo_tts_server.py.
 * Speed is native; do not also apply WAV speaking-rate.
 */
export async function synthesizeSpeechMelo(request: MeloTtsInput): Promise<TTSResult> {
  const endpoint = `${meloBaseUrl(request.meloTtsUrl)}/tts`;
  const speaker = (request.speaker || 'EN-US').trim() || 'EN-US';
  const language = (request.language || 'EN').trim() || 'EN';

  log.info(
    {
      event: 'tts_request',
      provider: 'melo_tts_http',
      speaker,
      language,
      speed: request.speed ?? null,
    },
    'melo tts request',
  );

  const body: Record<string, string | number> = {
    text: request.text,
    speaker,
    language,
  };
  if (request.speed !== undefined) body.speed = request.speed;
  if (request.sdpRatio !== undefined) body.sdp_ratio = request.sdpRatio;
  if (request.noiseScale !== undefined) body.noise_scale = request.noiseScale;
  if (request.noiseScaleW !== undefined) body.noise_scale_w = request.noiseScaleW;

  const response = await fetchWithTimeoutRetry(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    timeoutMs: 60_000,
    retries: 0,
  });

  const contentType = response.headers.get('content-type') ?? '';
  const raw = Buffer.from(await response.arrayBuffer());

  if (!response.ok) {
    log.error({ status: response.status, body: raw.toString('utf8').slice(0, 500) }, 'melo tts error');
    throw new Error(`melo tts error ${response.status}`);
  }
  if (contentType.includes('application/json')) {
    throw new Error(`melo tts: ${raw.toString('utf8').slice(0, 400)}`);
  }

  return { audio: raw, contentType: contentType || 'audio/wav' };
}
