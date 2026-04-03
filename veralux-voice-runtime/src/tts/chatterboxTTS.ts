import { randomUUID } from 'crypto';
import { mergeCompatibleWavBuffers } from '../audio/wavInfo';
import { env } from '../env';
import { fetchWithTimeoutRetry } from '../httpClient';
import { log } from '../log';
import type { TTSResult } from './types';

export type ChatterboxSynthesizeInput = {
  text: string;
  chatterboxUrl: string;
  speakerWavUrl?: string;
  language?: string;
  /** Logged by the server; reserved for a future multi-worker priority router. */
  priority?: number;
};

const STREAM_MAGIC = Buffer.from('VLX1', 'ascii');

async function readAllFromResponseBody(response: Response): Promise<Buffer> {
  const ab = await response.arrayBuffer();
  return Buffer.from(ab);
}

/**
 * Parse `VLX1` + repeated [u32be len][wav] into WAV segment buffers.
 */
function parseVlx1ChatterboxStream(buf: Buffer): Buffer[] {
  if (buf.length < 4 || !buf.subarray(0, 4).equals(STREAM_MAGIC)) {
    throw new Error('chatterbox_stream_bad_magic');
  }
  let o = 4;
  const wavs: Buffer[] = [];
  while (o + 4 <= buf.length) {
    const segLen = buf.readUInt32BE(o);
    o += 4;
    if (segLen <= 0 || o + segLen > buf.length) {
      throw new Error('chatterbox_stream_truncated');
    }
    wavs.push(buf.subarray(o, o + segLen));
    o += segLen;
  }
  if (o !== buf.length) {
    throw new Error('chatterbox_stream_trailing_bytes');
  }
  return wavs;
}

/**
 * Chatterbox HTTP client — expects veralux-audio-stack/chatterbox_server.py (or compatible).
 * When `CHATTERBOX_STREAMING=true` and variant is turbo, uses `POST .../tts/stream` and merges
 * segment WAVs into one buffer for the existing PSTN playback path.
 */
export async function synthesizeSpeechChatterbox(
  request: ChatterboxSynthesizeInput,
): Promise<TTSResult> {
  const base = request.chatterboxUrl.replace(/\/$/, '');
  const useStream =
    env.CHATTERBOX_STREAMING &&
    env.CHATTERBOX_VARIANT === 'turbo' &&
    !base.endsWith('/tts/stream');

  const endpoint = useStream
    ? base.endsWith('/tts')
      ? base.replace(/\/tts$/, '/tts/stream')
      : `${base}/tts/stream`
    : base.endsWith('/tts')
      ? base
      : `${base}/tts`;

  const body: Record<string, string | number | undefined> = {
    text: request.text,
    speaker_wav_url: request.speakerWavUrl,
    language_id: request.language,
    priority: request.priority,
  };

  const requestId = randomUUID();
  const t0 = performance.now();

  log.info(
    {
      event: 'tts_request',
      provider: 'chatterbox_http',
      endpoint_kind: useStream ? 'stream' : 'full',
      has_speaker: !!request.speakerWavUrl,
      language: request.language ?? null,
      request_id: requestId,
    },
    'chatterbox tts request',
  );

  const response = await fetchWithTimeoutRetry(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Request-Id': requestId,
    },
    body: JSON.stringify(body),
    timeoutMs: 120_000,
    retries: 0,
  });

  const serverRid = response.headers.get('x-tts-request-id') ?? requestId;
  const workerPid = response.headers.get('x-tts-worker-pid');
  const queueWait = response.headers.get('x-tts-queue-wait-ms');
  const synthMs = response.headers.get('x-tts-synthesize-ms');
  const totalHdr = response.headers.get('x-tts-total-ms');
  const segHdr = response.headers.get('x-tts-stream-segments');

  const contentType = response.headers.get('content-type') ?? '';
  const raw = await readAllFromResponseBody(response);
  const totalMs = performance.now() - t0;

  if (!response.ok) {
    const bodyText = raw.toString('utf8');
    log.error(
      {
        status: response.status,
        body: bodyText,
        request_id: serverRid,
        client_total_ms: Math.round(totalMs),
      },
      'chatterbox tts error',
    );
    throw new Error(`chatterbox tts error ${response.status}`);
  }

  if (contentType.includes('application/json')) {
    let errMsg: string;
    try {
      const json = raw.toString('utf8').length
        ? (JSON.parse(raw.toString('utf8')) as { error?: string; detail?: string })
        : {};
      errMsg = json.error ?? json.detail ?? raw.toString('utf8');
    } catch {
      errMsg = raw.toString('utf8');
    }
    throw new Error(`chatterbox tts: ${errMsg}`);
  }

  let audio: Buffer;
  if (useStream) {
    const segments = parseVlx1ChatterboxStream(raw);
    audio =
      segments.length === 1 ? segments[0]! : mergeCompatibleWavBuffers(segments);
    log.info(
      {
        event: 'chatterbox_tts_done',
        request_id: serverRid,
        worker_pid: workerPid ?? null,
        stream_segments: segments.length,
        stream_segments_header: segHdr ?? null,
        client_total_ms: Math.round(totalMs),
      },
      'chatterbox tts stream merged',
    );
  } else {
    audio = raw;
    log.info(
      {
        event: 'chatterbox_tts_done',
        request_id: serverRid,
        worker_pid: workerPid ?? null,
        queue_wait_ms: queueWait ?? null,
        synthesize_ms: synthMs ?? null,
        server_total_ms: totalHdr ?? null,
        client_total_ms: Math.round(totalMs),
      },
      'chatterbox tts response',
    );
  }

  return {
    audio,
    contentType: 'audio/wav',
  };
}
