const RATE_MARK = /\[\[vl-rate:([0-9.]+)\]\]\s*$/;

export function splitSpeakingRateInstruct(instruct: string | undefined): {
  instruct?: string;
  rate?: number;
} {
  const raw = String(instruct || "");
  const match = raw.match(RATE_MARK);
  const parsed = match ? Number(match[1]) : NaN;
  const text = raw.replace(RATE_MARK, "").trim();
  const rate = Number.isFinite(parsed) ? Math.min(1.2, Math.max(0.8, parsed)) : undefined;
  return { instruct: text || undefined, rate };
}

/** Change WAV duration so 0.8x is slower and 1.2x is faster. PCM 16-bit only. */
export function applyWavSpeakingRate(wav: Buffer, rate: number | undefined): Buffer {
  if (!rate || !Number.isFinite(rate) || Math.abs(rate - 1) < 0.02) return wav;
  if (wav.length < 44 || wav.toString("ascii", 0, 4) !== "RIFF" || wav.toString("ascii", 8, 12) !== "WAVE") {
    return wav;
  }

  let offset = 12;
  let channels = 0;
  let bits = 0;
  let dataStart = -1;
  let dataBytes = 0;
  while (offset + 8 <= wav.length) {
    const id = wav.toString("ascii", offset, offset + 4);
    const size = wav.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (id === "fmt ") {
      channels = wav.readUInt16LE(start + 2);
      bits = wav.readUInt16LE(start + 14);
    } else if (id === "data") {
      dataStart = start;
      dataBytes = size;
      break;
    }
    const padded = size + (size % 2);
    const next = start + padded;
    if (next <= offset) break;
    offset = next;
  }
  if (dataStart < 0 || channels !== 1 || bits !== 16) return wav;
  const frameBytes = 2;
  const frames = Math.floor(Math.min(dataBytes, wav.length - dataStart) / frameBytes);
  if (frames < 2) return wav;

  const outFrames = Math.max(2, Math.round(frames / rate));
  const pcm = Buffer.alloc(outFrames * frameBytes);
  for (let i = 0; i < outFrames; i += 1) {
    const src = (i * rate);
    const i0 = Math.min(frames - 1, Math.floor(src));
    const i1 = Math.min(frames - 1, i0 + 1);
    const frac = src - i0;
    const s0 = wav.readInt16LE(dataStart + i0 * frameBytes);
    const s1 = wav.readInt16LE(dataStart + i1 * frameBytes);
    const sample = Math.round(s0 + (s1 - s0) * frac);
    pcm.writeInt16LE(Math.max(-32768, Math.min(32767, sample)), i * frameBytes);
  }

  const header = Buffer.from(wav.subarray(0, dataStart));
  header.writeUInt32LE(pcm.length, dataStart - 4);
  const riffSize = 4 + (header.length - 12) + pcm.length;
  header.writeUInt32LE(riffSize, 4);
  return Buffer.concat([header, pcm]);
}
