import { log } from '../log';
import { fetchWithTimeoutRetry } from '../httpClient';
import type { TTSResult } from './types';

/** Optional generation kwargs for Qwen3 CustomVoice (HTTP JSON uses snake_case). */
export type Qwen3GenParams = {
  qwen3DoSample?: boolean;
  qwen3Temperature?: number;
  qwen3TopP?: number;
  qwen3TopK?: number;
  qwen3RepetitionPenalty?: number;
  qwen3MaxNewTokens?: number;
  qwen3NonStreamingMode?: boolean;
  qwen3SubtalkerDoSample?: boolean;
  qwen3SubtalkerTopK?: number;
  qwen3SubtalkerTopP?: number;
  qwen3SubtalkerTemperature?: number;
};

const QWEN3_GEN_KEYS = [
  'qwen3DoSample',
  'qwen3Temperature',
  'qwen3TopP',
  'qwen3TopK',
  'qwen3RepetitionPenalty',
  'qwen3MaxNewTokens',
  'qwen3NonStreamingMode',
  'qwen3SubtalkerDoSample',
  'qwen3SubtalkerTopK',
  'qwen3SubtalkerTopP',
  'qwen3SubtalkerTemperature',
] as const;

/** Request wins over tenant defaults when set. */
export function mergeQwen3TenantAndRequest(
  request: Partial<Qwen3GenParams>,
  tenant: Partial<Qwen3GenParams>,
): Qwen3GenParams {
  const o: Qwen3GenParams = {};
  for (const k of QWEN3_GEN_KEYS) {
    const rv = request[k];
    const tv = tenant[k];
    const v = rv !== undefined ? rv : tv;
    if (v !== undefined) (o as Record<string, unknown>)[k] = v;
  }
  return o;
}

/**
 * Qwen3 CustomVoice uses sampling when `do_sample` is true (typical model defaults). Each HTTP
 * `/tts` call re-rolls independently. With chunked synthesis (`qwen3Streaming`), that is once per
 * sentence chunk — so stochastic decoding sounds like a different speaker per sentence.
 * Default to deterministic decoding when the tenant did not choose (consistent voice; set
 * `qwen3DoSample: true` for variety).
 */
export function applyQwen3VoiceConsistencyDefaults(gen: Qwen3GenParams): Qwen3GenParams {
  const o: Qwen3GenParams = { ...gen };
  if (o.qwen3DoSample === undefined) {
    o.qwen3DoSample = false;
  }
  return o;
}

function qwen3GenToJsonBody(g: Qwen3GenParams): Record<string, boolean | number> {
  const out: Record<string, boolean | number> = {};
  if (g.qwen3DoSample !== undefined) out.do_sample = g.qwen3DoSample;
  if (g.qwen3Temperature !== undefined) out.temperature = g.qwen3Temperature;
  if (g.qwen3TopP !== undefined) out.top_p = g.qwen3TopP;
  if (g.qwen3TopK !== undefined) out.top_k = g.qwen3TopK;
  if (g.qwen3RepetitionPenalty !== undefined) out.repetition_penalty = g.qwen3RepetitionPenalty;
  if (g.qwen3MaxNewTokens !== undefined) out.max_new_tokens = g.qwen3MaxNewTokens;
  if (g.qwen3NonStreamingMode !== undefined) out.non_streaming_mode = g.qwen3NonStreamingMode;
  if (g.qwen3SubtalkerDoSample !== undefined) out.subtalker_dosample = g.qwen3SubtalkerDoSample;
  if (g.qwen3SubtalkerTopK !== undefined) out.subtalker_top_k = g.qwen3SubtalkerTopK;
  if (g.qwen3SubtalkerTopP !== undefined) out.subtalker_top_p = g.qwen3SubtalkerTopP;
  if (g.qwen3SubtalkerTemperature !== undefined) out.subtalker_temperature = g.qwen3SubtalkerTemperature;
  return out;
}

/**
 * Qwen3-TTS HTTP client — expects veralux-audio-stack/qwen3_tts_server.py (CustomVoice).
 */
export async function synthesizeSpeechQwen3(request: {
  text: string;
  qwen3TtsUrl: string;
  speaker?: string;
  language?: string;
  instruct?: string;
  gen?: Qwen3GenParams;
}): Promise<TTSResult> {
  const root = request.qwen3TtsUrl.replace(/\/$/, '');
  const endpoint = root.endsWith('/tts') ? root : `${root}/tts`;

  const genJson = request.gen ? qwen3GenToJsonBody(request.gen) : {};

  log.info(
    {
      event: 'tts_request',
      provider: 'qwen3_tts_http',
      speaker: request.speaker ?? null,
      language: request.language ?? null,
      gen: Object.keys(genJson).length ? genJson : null,
    },
    'qwen3 tts request',
  );

  const body: Record<string, unknown> = {
    text: request.text,
    speaker: request.speaker,
    language: request.language,
    instruct: request.instruct,
    ...genJson,
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
    log.error({ status: response.status, body: bodyText.slice(0, 500) }, 'qwen3 tts error');
    throw new Error(`qwen3 tts error ${response.status}`);
  }

  return {
    audio: raw,
    contentType: contentType || 'audio/wav',
  };
}
