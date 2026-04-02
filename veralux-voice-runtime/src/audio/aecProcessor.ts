// src/audio/aecProcessor.ts
//
// Tier 4: AEC Processor
// Buffers inbound PCM to 20ms frames, pulls far-end reference, runs Speex AEC,
// and emits cleaned frames. When AEC is unavailable or no far-end, passthrough.
//
// Debug: STT_DEBUG_AEC_NEAR_OUT_WAV=true records aligned near vs AEC-out as stereo
// (L=near, R=out), flushed when the call releases AEC state. See scripts/analyze_stt_wav.py.

import fs from 'fs/promises';
import path from 'path';
import { log } from '../log';
import { pullFarEndFrame } from './farEndReference';
import {
  speexAecAvailable,
  createSpeexAecState,
  destroySpeexAecState,
  resetSpeexAecState,
  speexEchoCancel,
  AEC_FRAME_SAMPLES,
} from './speexAec';

const BYTES_PER_FRAME = AEC_FRAME_SAMPLES * 2; // 640

interface CallState {
  aecState: ReturnType<typeof createSpeexAecState>;
  buffer: Buffer;
  bufferSamples: number;
}

const stateByCall = new Map<string, CallState>();

/** Ring of interleaved stereo s16le chunks (L=near, R=out), 320 samples per channel per chunk. */
const aecTapChunksByCall = new Map<string, Buffer[]>();

function parseBoolEnv(value: string | undefined): boolean {
  if (!value) return false;
  const n = value.trim().toLowerCase();
  return n === '1' || n === 'true' || n === 'yes';
}

function aecNearOutTapEnabled(): boolean {
  return parseBoolEnv(process.env.STT_DEBUG_AEC_NEAR_OUT_WAV);
}

function aecTapMaxFrames(): number {
  const raw = process.env.STT_DEBUG_AEC_TAP_MAX_MS;
  const ms = raw ? Number.parseInt(raw, 10) : 8000;
  const clamped = Math.min(120_000, Math.max(500, Number.isFinite(ms) ? ms : 8000));
  return Math.max(1, Math.floor(clamped / 20));
}

function resolveSttDebugDir(): string {
  const d = process.env.STT_DEBUG_DIR?.trim();
  return d && d !== '' ? d : '/tmp/veralux-stt-debug';
}

function wavHeaderStereo(pcmDataBytes: number, sampleRate: number): Buffer {
  const channels = 2;
  const bytesPerSample = 2;
  const blockAlign = channels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + pcmDataBytes, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(pcmDataBytes, 40);
  return header;
}

function appendAecStereoTap(callControlId: string, nearFrame: Buffer, output: Buffer): void {
  if (!aecNearOutTapEnabled()) return;
  if (nearFrame.length !== BYTES_PER_FRAME || output.length < BYTES_PER_FRAME) return;

  const chunk = Buffer.alloc(BYTES_PER_FRAME * 2);
  for (let i = 0; i < AEC_FRAME_SAMPLES; i += 1) {
    const ni = nearFrame.readInt16LE(i * 2);
    const oi = output.readInt16LE(i * 2);
    chunk.writeInt16LE(ni, i * 4);
    chunk.writeInt16LE(oi, i * 4 + 2);
  }

  let q = aecTapChunksByCall.get(callControlId);
  if (!q) {
    q = [];
    aecTapChunksByCall.set(callControlId, q);
  }
  q.push(chunk);
  const cap = aecTapMaxFrames();
  while (q.length > cap) q.shift();
}

async function flushAecStereoTap(callControlId: string): Promise<void> {
  const q = aecTapChunksByCall.get(callControlId);
  aecTapChunksByCall.delete(callControlId);
  if (!q || q.length === 0) return;

  const pcm = Buffer.concat(q);
  const dir = resolveSttDebugDir();
  const filePath = path.join(dir, `aec_near_out_${callControlId}_${Date.now()}.wav`);
  const wav = Buffer.concat([wavHeaderStereo(pcm.length, 16000), pcm]);
  try {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(filePath, wav);
    log.info(
      { event: 'stt_debug_aec_near_out_wav_written', file_path: filePath, frames: q.length, bytes: wav.length },
      'stt debug AEC near/out stereo wav written',
    );
  } catch (err) {
    log.warn({ err, file_path: filePath }, 'stt debug AEC near/out wav write failed');
  }
}

function getOrCreateState(callControlId: string): CallState {
  let st = stateByCall.get(callControlId);
  if (!st) {
    st = {
      aecState: createSpeexAecState(),
      buffer: Buffer.alloc(0),
      bufferSamples: 0,
    };
    stateByCall.set(callControlId, st);
  }
  return st;
}

export function releaseAecProcessor(callControlId: string): void {
  void flushAecStereoTap(callControlId);
  const st = stateByCall.get(callControlId);
  if (st) {
    if (st.aecState) destroySpeexAecState(st.aecState);
    stateByCall.delete(callControlId);
  }
}

export function resetAecProcessor(callControlId: string): void {
  const st = stateByCall.get(callControlId);
  if (st?.aecState) {
    resetSpeexAecState(st.aecState);
  }
  // Clear buffer on playback transition
  if (st) {
    st.buffer = Buffer.alloc(0);
    st.bufferSamples = 0;
  }
}

export type AecFrameCallback = (pcm16: Int16Array, sampleRateHz: number) => void;

/**
 * Process inbound PCM through AEC (when available) and emit cleaned frames.
 * Callback is invoked for each 20ms frame.
 */
export function processAec(
  callControlId: string,
  pcm16: Int16Array,
  sampleRateHz: number,
  onFrame: AecFrameCallback,
  logContext?: Record<string, unknown>,
): void {
  if (sampleRateHz !== 16000) {
    onFrame(pcm16, sampleRateHz);
    return;
  }

  const st = getOrCreateState(callControlId);

  // Append to buffer
  const newBytes = pcm16.length * 2;
  st.buffer = Buffer.concat([st.buffer, Buffer.from(pcm16.buffer, pcm16.byteOffset, pcm16.byteLength)]);
  st.bufferSamples += pcm16.length;

  // Process complete 20ms frames
  while (st.bufferSamples >= AEC_FRAME_SAMPLES) {
    const nearFrame = st.buffer.subarray(0, BYTES_PER_FRAME);
    const farFrame = pullFarEndFrame(callControlId);

    let output: Buffer;

    if (speexAecAvailable && st.aecState && farFrame && farFrame.length >= BYTES_PER_FRAME) {
      output = Buffer.alloc(BYTES_PER_FRAME);
      speexEchoCancel(st.aecState, nearFrame, farFrame, output);
    } else {
      output = nearFrame;
    }

    appendAecStereoTap(callControlId, nearFrame, output);

    const outSamples = new Int16Array(AEC_FRAME_SAMPLES);
    outSamples.set(new Int16Array(output.buffer, output.byteOffset, AEC_FRAME_SAMPLES));
    onFrame(outSamples, sampleRateHz);

    st.buffer = st.buffer.subarray(BYTES_PER_FRAME);
    st.bufferSamples -= AEC_FRAME_SAMPLES;
  }
}

/** Flush any remaining buffered samples (passthrough). */
export function flushAecProcessor(
  callControlId: string,
  onFrame: AecFrameCallback,
  sampleRateHz: number,
): void {
  const st = stateByCall.get(callControlId);
  if (!st || st.bufferSamples === 0) return;

  const samples = Math.floor(st.buffer.length / 2);
  if (samples > 0) {
    const pcm16 = new Int16Array(st.buffer.buffer, st.buffer.byteOffset, samples);
    onFrame(pcm16, sampleRateHz);
  }
  st.buffer = Buffer.alloc(0);
  st.bufferSamples = 0;
}

export { speexAecAvailable };
