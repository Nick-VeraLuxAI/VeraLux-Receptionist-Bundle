export interface WavInfo {
  audioFormat: number;
  channels: number;
  sampleRateHz: number;
  bitsPerSample: number;
  dataBytes: number;
  durationMs: number;
}

export interface WavHeaderSummary {
  riff: boolean;
  wave: boolean;
  first16Hex: string;
}

function isRiffWav(buffer: Buffer): boolean {
  return (
    buffer.length >= 12 &&
    buffer.toString('ascii', 0, 4) === 'RIFF' &&
    buffer.toString('ascii', 8, 12) === 'WAVE'
  );
}

export function describeWavHeader(buffer: Buffer): WavHeaderSummary {
  const riff = buffer.length >= 4 && buffer.toString('ascii', 0, 4) === 'RIFF';
  const wave = buffer.length >= 12 && buffer.toString('ascii', 8, 12) === 'WAVE';
  const max = Math.min(buffer.length, 16);
  let hex = '';
  for (let i = 0; i < max; i += 1) {
    hex += buffer[i]!.toString(16).padStart(2, '0');
  }
  return { riff, wave, first16Hex: hex };
}

export function parseWavInfo(buffer: Buffer): WavInfo {
  if (!isRiffWav(buffer)) {
    throw new Error('invalid_riff_header');
  }

  let offset = 12;
  let audioFormat: number | null = null;
  let channels: number | null = null;
  let sampleRateHz: number | null = null;
  let bitsPerSample: number | null = null;
  let dataBytes: number | null = null;

  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.toString('ascii', offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);
    const chunkStart = offset + 8;

    if (chunkId === 'fmt ') {
      if (chunkStart + 16 > buffer.length) {
        throw new Error('fmt_chunk_truncated');
      }
      audioFormat = buffer.readUInt16LE(chunkStart);
      channels = buffer.readUInt16LE(chunkStart + 2);
      sampleRateHz = buffer.readUInt32LE(chunkStart + 4);
      bitsPerSample = buffer.readUInt16LE(chunkStart + 14);
    } else if (chunkId === 'data') {
      dataBytes = chunkSize;
    }

    const paddedSize = chunkSize + (chunkSize % 2);
    const nextOffset = chunkStart + paddedSize;
    if (nextOffset <= offset) {
      break;
    }
    offset = nextOffset;
  }

  if (audioFormat === null || channels === null || sampleRateHz === null || bitsPerSample === null) {
    throw new Error('missing_fmt_chunk');
  }
  if (dataBytes === null) {
    throw new Error('missing_data_chunk');
  }
  if (channels <= 0 || sampleRateHz <= 0 || bitsPerSample <= 0) {
    throw new Error('invalid_format_values');
  }

  const bytesPerSample = bitsPerSample / 8;
  const durationMs = (dataBytes / (sampleRateHz * channels * bytesPerSample)) * 1000;

  return {
    audioFormat,
    channels,
    sampleRateHz,
    bitsPerSample,
    dataBytes,
    durationMs,
  };
}

/** PCM WAV payload after walking chunk list (for merging segment WAVs). */
export type WavPcmPayload = {
  format: Pick<WavInfo, 'audioFormat' | 'channels' | 'sampleRateHz' | 'bitsPerSample'>;
  pcm: Buffer;
};

/**
 * Extract raw PCM bytes and format from a RIFF/WAVE buffer (fmt + data chunks).
 * Used to concatenate Chatterbox stream segments into one WAV for PSTN playback.
 */
export function extractWavPcmPayload(buffer: Buffer): WavPcmPayload {
  if (!isRiffWav(buffer)) {
    throw new Error('invalid_riff_header');
  }

  let offset = 12;
  let audioFormat: number | null = null;
  let channels: number | null = null;
  let sampleRateHz: number | null = null;
  let bitsPerSample: number | null = null;
  let pcm: Buffer | null = null;

  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.toString('ascii', offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);
    const chunkStart = offset + 8;

    if (chunkId === 'fmt ') {
      if (chunkStart + 16 > buffer.length) {
        throw new Error('fmt_chunk_truncated');
      }
      audioFormat = buffer.readUInt16LE(chunkStart);
      channels = buffer.readUInt16LE(chunkStart + 2);
      sampleRateHz = buffer.readUInt32LE(chunkStart + 4);
      bitsPerSample = buffer.readUInt16LE(chunkStart + 14);
    } else if (chunkId === 'data') {
      const end = chunkStart + chunkSize;
      if (end > buffer.length) {
        throw new Error('data_chunk_truncated');
      }
      pcm = Buffer.from(buffer.subarray(chunkStart, end));
    }

    const paddedSize = chunkSize + (chunkSize % 2);
    const nextOffset = chunkStart + paddedSize;
    if (nextOffset <= offset) {
      break;
    }
    offset = nextOffset;
  }

  if (audioFormat === null || channels === null || sampleRateHz === null || bitsPerSample === null) {
    throw new Error('missing_fmt_chunk');
  }
  if (pcm === null) {
    throw new Error('missing_data_chunk');
  }
  if (audioFormat !== 1) {
    throw new Error('merge_wav_only_linear_pcm');
  }

  return {
    format: { audioFormat, channels, sampleRateHz, bitsPerSample },
    pcm,
  };
}

function buildLinearPcmWav(format: WavPcmPayload['format'], pcm: Buffer): Buffer {
  const { channels, sampleRateHz, bitsPerSample } = format;
  const bytesPerSample = bitsPerSample / 8;
  const blockAlign = channels * bytesPerSample;
  const byteRate = sampleRateHz * blockAlign;
  const fmtChunkSize = 16;
  const dataChunkSize = pcm.length;
  const pad = dataChunkSize % 2;
  // RIFF chunk size = file length minus 8 (excludes "RIFF" + this u32).
  const riffChunkSize = 4 + (8 + fmtChunkSize) + (8 + dataChunkSize + pad);

  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(riffChunkSize, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(fmtChunkSize, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRateHz, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(dataChunkSize, 40);

  return pad ? Buffer.concat([header, pcm, Buffer.alloc(1)]) : Buffer.concat([header, pcm]);
}

/**
 * Concatenate multiple WAV files that share the same linear PCM format (e.g. Chatterbox segments).
 */
export function mergeCompatibleWavBuffers(buffers: Buffer[]): Buffer {
  if (buffers.length === 0) {
    throw new Error('merge_wav_empty');
  }
  if (buffers.length === 1) {
    return Buffer.from(buffers[0]!);
  }
  const first = extractWavPcmPayload(buffers[0]!);
  const pcmParts: Buffer[] = [first.pcm];
  for (let i = 1; i < buffers.length; i += 1) {
    const next = extractWavPcmPayload(buffers[i]!);
    const a = first.format;
    const b = next.format;
    if (
      a.audioFormat !== b.audioFormat ||
      a.channels !== b.channels ||
      a.sampleRateHz !== b.sampleRateHz ||
      a.bitsPerSample !== b.bitsPerSample
    ) {
      throw new Error('merge_wav_format_mismatch');
    }
    pcmParts.push(next.pcm);
  }
  return buildLinearPcmWav(first.format, Buffer.concat(pcmParts));
}