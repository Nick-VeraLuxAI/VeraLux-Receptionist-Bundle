import { env } from '../env';
import { log } from '../log';
import { fetchWithTimeoutRetry } from '../httpClient';
import type { TTSRequest } from './types';

export const KOKORO_VLX1_MAGIC = Buffer.from('VLX1', 'ascii');

export function kokoroStreamUrl(kokoroUrl: string): string {
  const base = kokoroUrl.replace(/\/$/, '');
  if (base.endsWith('/tts/stream')) return base;
  if (base.endsWith('/tts')) return `${base}/stream`;
  return `${base}/tts/stream`;
}

/**
 * Incremental VLX1 parser: magic + repeated [u32be len][wav].
 */
export async function* parseVlx1WavStream(
  reader: AsyncIterable<Uint8Array> | ReadableStream<Uint8Array>,
): AsyncGenerator<Buffer> {
  const iterator =
    Symbol.asyncIterator in reader
      ? (reader as AsyncIterable<Uint8Array>)[Symbol.asyncIterator]()
      : streamToAsyncIterator(reader as ReadableStream<Uint8Array>);

  let buf = Buffer.alloc(0);
  let magicOk = false;

  while (true) {
    const next = await iterator.next();
    if (!next.done && next.value) {
      buf = Buffer.concat([buf, Buffer.from(next.value)]);
    }

    if (!magicOk) {
      if (buf.length < 4) {
        if (next.done) throw new Error('kokoro_stream_empty');
        continue;
      }
      if (!buf.subarray(0, 4).equals(KOKORO_VLX1_MAGIC)) {
        throw new Error('kokoro_stream_bad_magic');
      }
      magicOk = true;
      buf = buf.subarray(4);
    }

    while (buf.length >= 4) {
      const segLen = buf.readUInt32BE(0);
      if (segLen <= 0 || segLen > 8_000_000) {
        throw new Error('kokoro_stream_bad_segment_len');
      }
      if (buf.length < 4 + segLen) break;
      yield Buffer.from(buf.subarray(4, 4 + segLen));
      buf = buf.subarray(4 + segLen);
    }

    if (next.done) {
      if (buf.length > 0) throw new Error('kokoro_stream_truncated');
      return;
    }
  }
}

function streamToAsyncIterator(
  stream: ReadableStream<Uint8Array>,
): AsyncIterator<Uint8Array> {
  const reader = stream.getReader();
  return {
    async next() {
      const result = await reader.read();
      if (result.done) {
        reader.releaseLock();
        return { done: true, value: undefined };
      }
      return { done: false, value: result.value };
    },
  };
}

export async function* streamKokoroSpeech(request: TTSRequest): AsyncGenerator<Buffer> {
  const kokoroUrl = request.kokoroUrl ?? env.KOKORO_URL;
  if (!kokoroUrl) {
    throw new Error('KOKORO_URL or request.kokoroUrl is required for Kokoro TTS');
  }

  const endpoint = kokoroStreamUrl(kokoroUrl);
  const payload: Record<string, unknown> = {
    text: request.text,
    voice: request.voice,
    format: request.format ?? 'wav',
    sampleRate: request.sampleRate ?? env.TTS_SAMPLE_RATE,
  };
  if (request.rate != null && Number.isFinite(request.rate)) {
    payload.rate = request.rate;
  }

  log.info(
    { event: 'tts_request', provider: 'kokoro_http', endpoint_kind: 'stream', voice: request.voice },
    'kokoro stream request',
  );

  const response = await fetchWithTimeoutRetry(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    timeoutMs: 60_000,
    retries: 0,
    retryOnStatuses: [],
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`kokoro stream error ${response.status} ${body.slice(0, 180)}`);
  }
  if (!response.body) {
    throw new Error('kokoro_stream_no_body');
  }

  yield* parseVlx1WavStream(response.body);
}
