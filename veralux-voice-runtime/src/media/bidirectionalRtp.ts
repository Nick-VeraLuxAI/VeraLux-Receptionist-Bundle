import path from 'path';

import { resamplePcm16 } from '../audio/codecDecode';
import { extractWavPcmPayload } from '../audio/wavInfo';
import { env } from '../env';
import { log } from '../log';
import { TELNYX_WS_BIDIRECTIONAL_SAMPLE_RATE } from '../telnyx/streamCodec';

/** Telnyx allows 20ms–30s chunks. Cap a single media event at 30s of 16 kHz mono L16. */
const MAX_CHUNK_MS = 30_000;
const MAX_CHUNK_BYTES = (TELNYX_WS_BIDIRECTIONAL_SAMPLE_RATE * 2 * MAX_CHUNK_MS) / 1000;

/**
 * Telnyx WebSocket L16 is little-endian PCM16 (empirically), not RFC 3551 big-endian.
 * See team-telnyx/realtime-ai-demo L16 path.
 */
export function encodeL16PayloadBase64(pcmLe: Buffer): string {
  return pcmLe.toString('base64');
}

export function buildRtpMediaEvent(pcmLe: Buffer): string {
  return JSON.stringify({
    event: 'media',
    media: { payload: encodeL16PayloadBase64(pcmLe) },
  });
}

export function buildRtpClearEvent(): string {
  return JSON.stringify({ event: 'clear' });
}

export function buildRtpMarkEvent(name: string): string {
  return JSON.stringify({
    event: 'mark',
    mark: { name },
  });
}

export function wavToL16Pcm16k(wav: Buffer): Buffer {
  const extracted = extractWavPcmPayload(wav);
  if (extracted.format.bitsPerSample !== 16) {
    throw new Error(`l16_tts_bits_${extracted.format.bitsPerSample}`);
  }
  if (extracted.format.channels !== 1) {
    throw new Error(`l16_tts_channels_${extracted.format.channels}`);
  }

  let pcm = extracted.pcm;
  if (pcm.length % 2 === 1) {
    pcm = pcm.subarray(0, pcm.length - 1);
  }

  const inputRate = extracted.format.sampleRateHz;
  if (inputRate !== TELNYX_WS_BIDIRECTIONAL_SAMPLE_RATE) {
    const samples = new Int16Array(pcm.length / 2);
    for (let i = 0; i < samples.length; i += 1) {
      samples[i] = pcm.readInt16LE(i * 2);
    }
    const resampled = resamplePcm16(samples, inputRate, TELNYX_WS_BIDIRECTIONAL_SAMPLE_RATE);
    const out = Buffer.alloc(resampled.length * 2);
    for (let i = 0; i < resampled.length; i += 1) {
      out.writeInt16LE(resampled[i] ?? 0, i * 2);
    }
    log.info(
      {
        event: 'tts_l16_resampled',
        from_hz: inputRate,
        to_hz: TELNYX_WS_BIDIRECTIONAL_SAMPLE_RATE,
        in_samples: samples.length,
        out_samples: resampled.length,
      },
      'TTS WAV resampled to L16 16 kHz',
    );
    pcm = out;
  }

  if (pcm.length > MAX_CHUNK_BYTES) {
    log.warn(
      {
        event: 'tts_l16_truncated',
        bytes: pcm.length,
        max_bytes: MAX_CHUNK_BYTES,
      },
      'TTS L16 longer than Telnyx 30s RTP chunk; truncating',
    );
    pcm = pcm.subarray(0, MAX_CHUNK_BYTES - (MAX_CHUNK_BYTES % 2));
  }

  return pcm;
}

export function localWavPathFromPublicUrl(audioUrl: string): string | null {
  try {
    const fileName = path.basename(new URL(audioUrl).pathname);
    if (!fileName || fileName === '.' || fileName === '..') return null;
    return path.join(env.AUDIO_STORAGE_DIR, fileName);
  } catch {
    return null;
  }
}
