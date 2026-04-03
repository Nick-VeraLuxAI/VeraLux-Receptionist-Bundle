#!/usr/bin/env npx tsx
/**
 * True pipeline load test: Whisper (STT) + Brain (vLLM via OpenAI-compatible API).
 *
 * Does NOT exercise Telnyx/media — those are separate bottlenecks. With --mode full,
 * measures STT → LLM → TTS (same HTTP services the runtime uses).
 *
 * Usage:
 *   npx tsx scripts/pipeline-load-test.ts [options]
 *
 * Modes:
 *   brain     — POST /reply only (vLLM saturation)
 *   whisper   — POST transcribe only (Whisper saturation)
 *   pipeline  — whisper then brain per iteration (STT→LLM)
 *   full      — pipeline + TTS (STT→LLM→TTS; no Telnyx/media). Use --tts-backend kokoro|chatterbox
 *
 * Optional: --wav /path/to/file.wav  (default: short silence WAV for STT)
 */

import fs from 'node:fs';
import path from 'node:path';
import { config as loadEnv } from 'dotenv';

const scriptDir = __dirname;
loadEnv({ path: path.resolve(scriptDir, '../../.env') });
loadEnv({ path: path.resolve(scriptDir, '../.env'), override: true });

interface Options {
  mode: 'brain' | 'whisper' | 'pipeline' | 'full';
  whisperUrl: string;
  brainUrl: string;
  /** TTS base or full /tts URL (Kokoro: .../tts; Chatterbox: base e.g. http://127.0.0.1:7005) */
  ttsUrl: string;
  ttsVoiceId: string;
  /** Kokoro: voice_id. Chatterbox: not used (server uses CHATTERBOX_DEFAULT_AUDIO_PROMPT for turbo). */
  ttsBackend: 'kokoro' | 'chatterbox';
  concurrency: number;
  iterations: number;
  warmup: number;
  /** Extra delay between iterations (ms) — helps avoid Whisper 429 when many workers hit STT. */
  gapMs: number;
  /** When set, POST this WAV to Whisper instead of the built-in silence clip. */
  wavPath?: string;
  /** Log transcript, brain reply length, TTS bytes (useful for diagnosing “slow Kokoro”). */
  verbose: boolean;
}

function parseArgs(): Options {
  const args = process.argv.slice(2);
  const backendEnv = (process.env.E2E_TTS_BACKEND || 'kokoro').toLowerCase();
  const ttsBackend: Options['ttsBackend'] =
    backendEnv === 'chatterbox' ? 'chatterbox' : 'kokoro';
  const defaultChatterboxBase =
    process.env.E2E_TTS_URL ||
    (process.env.CHATTERBOX_URL
      ? process.env.CHATTERBOX_URL.replace('://chatterbox:', '://127.0.0.1:')
      : 'http://127.0.0.1:7005');
  const defaultKokoroTts =
    process.env.E2E_TTS_URL || process.env.KOKORO_URL || 'http://127.0.0.1:7001/tts';
  const o: Options = {
    mode: 'pipeline',
    whisperUrl: process.env.WHISPER_URL || 'http://127.0.0.1:9000/transcribe',
    brainUrl: process.env.BRAIN_URL || 'http://127.0.0.1:3001/reply',
    ttsUrl: ttsBackend === 'chatterbox' ? defaultChatterboxBase : defaultKokoroTts,
    ttsVoiceId: process.env.KOKORO_VOICE_ID || 'bf_emma',
    ttsBackend,
    concurrency: 4,
    iterations: 10,
    warmup: 1,
    gapMs: 0,
    verbose: false,
  };
  let explicitTtsUrl = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const n = args[i + 1];
    switch (a) {
      case '--mode':
        if (n === 'brain' || n === 'whisper' || n === 'pipeline' || n === 'full') o.mode = n;
        i++;
        break;
      case '--whisper-url':
        o.whisperUrl = n;
        i++;
        break;
      case '--brain-url':
        o.brainUrl = n;
        i++;
        break;
      case '--tts-url':
        o.ttsUrl = n;
        explicitTtsUrl = true;
        i++;
        break;
      case '--tts-voice':
        o.ttsVoiceId = n;
        i++;
        break;
      case '--tts-backend':
        if (n === 'chatterbox' || n === 'kokoro') {
          o.ttsBackend = n;
          if (!explicitTtsUrl) {
            o.ttsUrl = n === 'chatterbox' ? defaultChatterboxBase : defaultKokoroTts;
          }
        }
        i++;
        break;
      case '--concurrency':
        o.concurrency = parseInt(n, 10);
        i++;
        break;
      case '--iterations':
        o.iterations = parseInt(n, 10);
        i++;
        break;
      case '--warmup':
        o.warmup = parseInt(n, 10);
        i++;
        break;
      case '--gap-ms':
        o.gapMs = parseInt(n, 10);
        i++;
        break;
      case '--wav':
        o.wavPath = n;
        i++;
        break;
      case '--verbose':
      case '-v':
        o.verbose = true;
        break;
      case '--help':
        console.log(`
Usage: npx tsx scripts/pipeline-load-test.ts [options]

Options:
  --mode brain|whisper|pipeline|full   (default: pipeline; full = STT+LLM+TTS)
  --tts-backend kokoro|chatterbox (default: kokoro; use chatterbox for E2E without Kokoro)
  --tts-url <url>                 (Chatterbox: base http://host:7005; Kokoro: .../tts)
  --whisper-url <url>             (default: WHISPER_URL or http://127.0.0.1:9000/transcribe)
  --brain-url <url>               (default: BRAIN_URL or http://127.0.0.1:3001/reply)
  --concurrency <n>               parallel workers (default: 4)
  --iterations <n>                loops per worker (default: 10)
  --warmup <n>                    discarded iterations per worker at start (default: 1)
  --gap-ms <n>                    pause between each iteration per worker (default: 0; use ~50–150 for Whisper-heavy runs)
  --wav <path>                    WAV file for Whisper (otherwise ~0.5s silence)
  --verbose, -v                   After each pipeline/full iteration: transcript, brain chars, TTS WAV bytes

Examples:
  npx tsx scripts/pipeline-load-test.ts --mode brain --concurrency 8 --iterations 20
  npx tsx scripts/pipeline-load-test.ts --mode pipeline --concurrency 6 --iterations 15
`);
        process.exit(0);
    }
  }
  return o;
}

/** ~0.5s 16kHz mono PCM16 silence WAV */
function makeSilenceWav(): Buffer {
  const sampleRate = 16000;
  const seconds = 0.5;
  const numSamples = Math.floor(sampleRate * seconds);
  const dataSize = numSamples * 2;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataSize, 40);
  return buf;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

function stats(ms: number[]): { min: number; max: number; avg: number; p50: number; p95: number; p99: number } {
  if (ms.length === 0) {
    return { min: 0, max: 0, avg: 0, p50: 0, p95: 0, p99: 0 };
  }
  const s = [...ms].sort((a, b) => a - b);
  const sum = ms.reduce((a, b) => a + b, 0);
  return {
    min: s[0],
    max: s[s.length - 1],
    avg: sum / ms.length,
    p50: percentile(s, 50),
    p95: percentile(s, 95),
    p99: percentile(s, 99),
  };
}

async function postWhisper(url: string, wav: Buffer): Promise<{ ms: number; text: string }> {
  const t0 = Date.now();
  let lastStatus = 0;
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'audio/wav' },
      body: wav,
    });
    lastStatus = res.status;
    if (res.status === 429) {
      await new Promise((r) => setTimeout(r, 80 * (attempt + 1)));
      continue;
    }
    const j = (await res.json()) as { text?: string };
    const ms = Date.now() - t0;
    if (!res.ok) {
      throw new Error(`whisper HTTP ${res.status}`);
    }
    return { ms, text: typeof j.text === 'string' ? j.text : '' };
  }
  throw new Error(`whisper HTTP ${lastStatus} (rate limited after retries)`);
}

async function postBrain(
  url: string,
  transcript: string,
  idx: number,
  iter: number
): Promise<{ ms: number; text: string }> {
  const body = {
    callControlId: `plt-${idx}-${iter}-${Date.now()}`,
    transcript,
    history: [] as { role: string; content: string; timestamp: string }[],
  };
  const t0 = Date.now();
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`brain HTTP ${res.status}: ${t.slice(0, 200)}`);
  }
  const j = (await res.json()) as { text?: string };
  const ms = Date.now() - t0;
  if (typeof j.text !== 'string' || !j.text.trim()) {
    throw new Error('brain returned empty text');
  }
  return { ms, text: j.text.trim() };
}

async function postKokoroTts(url: string, text: string, voiceId: string): Promise<{ ms: number; wavBytes: number }> {
  const trimmed = text.trim().slice(0, 1000);
  if (!trimmed) {
    throw new Error('empty text for TTS');
  }
  const vid = voiceId === 'default' ? 'bf_emma' : voiceId;
  const t0 = Date.now();
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: trimmed, voice_id: vid }),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`tts HTTP ${res.status}: ${t.slice(0, 200)}`);
  }
  const buf = await res.arrayBuffer();
  const ms = Date.now() - t0;
  return { ms, wavBytes: buf.byteLength };
}

async function postChatterboxTts(baseUrl: string, text: string): Promise<{ ms: number; wavBytes: number }> {
  const trimmed = text.trim().slice(0, 1500);
  if (!trimmed) {
    throw new Error('empty text for TTS');
  }
  const root = baseUrl.replace(/\/$/, '');
  const endpoint = root.endsWith('/tts') ? root : `${root}/tts`;
  const t0 = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 180_000);
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: trimmed, language_id: 'en' }),
      signal: controller.signal,
    });
    const buf = await res.arrayBuffer();
    const ms = Date.now() - t0;
    if (!res.ok) {
      const t = new TextDecoder().decode(buf.slice(0, 500));
      throw new Error(`chatterbox HTTP ${res.status}: ${t}`);
    }
    return { ms, wavBytes: buf.byteLength };
  } finally {
    clearTimeout(timer);
  }
}

/** Vary prompts slightly to reduce identical-prefix caching effects. */
const BRAIN_PROMPTS = [
  'What are your hours this week?',
  'Do you offer emergency service?',
  'I need to leave a message for the owner.',
  'What forms of payment do you accept?',
  'Can someone call me back tomorrow morning?',
  'Where are you located?',
  'Is there a warranty on your work?',
  'I would like to schedule an estimate.',
];

async function worker(
  workerId: number,
  opts: Options,
  wav: Buffer,
  whisperMs: number[],
  brainMs: number[],
  ttsMs: number[],
  totalMs: number[],
  errors: string[]
): Promise<void> {
  const brainUrl = opts.brainUrl.replace(/\/$/, '');
  const replyUrl = brainUrl.endsWith('/reply') ? brainUrl : `${brainUrl}/reply`;

  for (let i = 0; i < opts.warmup + opts.iterations; i++) {
    const isWarmup = i < opts.warmup;
    try {
      if (opts.mode === 'brain') {
        const prompt = BRAIN_PROMPTS[(workerId + i) % BRAIN_PROMPTS.length];
        const r = await postBrain(replyUrl, prompt, workerId, i);
        if (!isWarmup) brainMs.push(r.ms);
        continue;
      }

      if (opts.mode === 'whisper') {
        const { ms } = await postWhisper(opts.whisperUrl, wav);
        if (!isWarmup) whisperMs.push(ms);
        continue;
      }

      // pipeline or full (STT → LLM [→ TTS])
      const tPipe0 = Date.now();
      const w = await postWhisper(opts.whisperUrl, wav);
      if (!isWarmup) whisperMs.push(w.ms);
      const transcript =
        w.text.trim() ||
        BRAIN_PROMPTS[(workerId + i) % BRAIN_PROMPTS.length];
      const b = await postBrain(replyUrl, transcript, workerId, i);
      if (!isWarmup) {
        brainMs.push(b.ms);
      }

      if (opts.mode === 'full') {
        const t =
          opts.ttsBackend === 'chatterbox'
            ? await postChatterboxTts(opts.ttsUrl, b.text)
            : await postKokoroTts(opts.ttsUrl, b.text, opts.ttsVoiceId);
        if (!isWarmup) {
          ttsMs.push(t.ms);
          totalMs.push(Date.now() - tPipe0);
        }
        if (opts.verbose && !isWarmup) {
          const preview = (s: string, max = 120) =>
            s.length <= max ? s : `${s.slice(0, max - 3)}...`;
          console.log(
            `\n[verbose] transcript (${w.text.length} chars): ${preview(w.text)}\n` +
              `[verbose] brain reply (${b.text.length} chars): ${preview(b.text)}\n` +
              `[verbose] TTS WAV ${t.wavBytes} bytes (longer replies → longer synthesis + larger download)`,
          );
        }
      } else if (!isWarmup) {
        totalMs.push(Date.now() - tPipe0);
      }
    } catch (e) {
      errors.push(`${workerId}:${i} ${e instanceof Error ? e.message : String(e)}`);
    }
    if (opts.gapMs > 0 && i < opts.warmup + opts.iterations - 1) {
      await new Promise((r) => setTimeout(r, opts.gapMs));
    }
  }
}

async function main(): Promise<void> {
  const opts = parseArgs();
  let wav: Buffer;
  if (opts.wavPath) {
    const resolved = path.resolve(opts.wavPath);
    if (!fs.existsSync(resolved)) {
      console.error(`WAV not found: ${resolved}`);
      process.exit(2);
    }
    wav = fs.readFileSync(resolved);
    console.log(`Using WAV: ${resolved} (${wav.length} bytes)`);
  } else {
    wav = makeSilenceWav();
  }

  console.log('\n=== Pipeline load test (Whisper + Brain / vLLM) ===\n');
  console.log(`Mode:          ${opts.mode}`);
  console.log(`Whisper URL:   ${opts.whisperUrl}`);
  console.log(`Brain URL:     ${opts.brainUrl}`);
  if (opts.mode === 'full') {
    console.log(`TTS backend:   ${opts.ttsBackend}`);
    console.log(`TTS URL:       ${opts.ttsUrl}`);
    if (opts.ttsBackend === 'kokoro') console.log(`TTS voice:     ${opts.ttsVoiceId}`);
  }
  console.log(`Concurrency:   ${opts.concurrency}`);
  console.log(`Iterations:    ${opts.iterations} per worker (warmup ${opts.warmup} discarded)`);
  if (opts.gapMs > 0) console.log(`Gap:           ${opts.gapMs} ms between iterations`);
  console.log(`Total samples: ~${opts.concurrency * opts.iterations} per tier (after warmup)\n`);

  const whisperMs: number[] = [];
  const brainMs: number[] = [];
  const ttsMs: number[] = [];
  const totalMs: number[] = [];
  const errors: string[] = [];

  const t0 = Date.now();
  const workers: Promise<void>[] = [];
  for (let w = 0; w < opts.concurrency; w++) {
    workers.push(worker(w, opts, wav, whisperMs, brainMs, ttsMs, totalMs, errors));
  }
  await Promise.all(workers);
  const wallMs = Date.now() - t0;

  console.log(`Wall time:     ${(wallMs / 1000).toFixed(2)}s`);
  console.log(`Errors:        ${errors.length}`);
  if (errors.length > 0 && errors.length <= 15) {
    errors.forEach((e) => console.log(`  - ${e}`));
  } else if (errors.length > 15) {
    errors.slice(0, 10).forEach((e) => console.log(`  - ${e}`));
    console.log(`  ... and ${errors.length - 10} more`);
  }

  if (opts.mode === 'whisper' || opts.mode === 'pipeline' || opts.mode === 'full') {
    console.log('\n--- Whisper (STT) latency (ms) ---');
    const s = stats(whisperMs);
    console.log(`  n=${whisperMs.length}  min=${s.min.toFixed(0)}  p50=${s.p50.toFixed(0)}  p95=${s.p95.toFixed(0)}  p99=${s.p99.toFixed(0)}  max=${s.max.toFixed(0)}  avg=${s.avg.toFixed(0)}`);
  }
  if (opts.mode === 'brain' || opts.mode === 'pipeline' || opts.mode === 'full') {
    console.log('\n--- Brain (vLLM) latency (ms) ---');
    const s = stats(brainMs);
    console.log(`  n=${brainMs.length}  min=${s.min.toFixed(0)}  p50=${s.p50.toFixed(0)}  p95=${s.p95.toFixed(0)}  p99=${s.p99.toFixed(0)}  max=${s.max.toFixed(0)}  avg=${s.avg.toFixed(0)}`);
  }
  if (opts.mode === 'full') {
    const ttsLabel = opts.ttsBackend === 'chatterbox' ? 'Chatterbox' : 'Kokoro';
    console.log(`\n--- ${ttsLabel} TTS latency (ms) ---`);
    const s = stats(ttsMs);
    console.log(`  n=${ttsMs.length}  min=${s.min.toFixed(0)}  p50=${s.p50.toFixed(0)}  p95=${s.p95.toFixed(0)}  p99=${s.p99.toFixed(0)}  max=${s.max.toFixed(0)}  avg=${s.avg.toFixed(0)}`);
  }
  if (opts.mode === 'pipeline') {
    console.log('\n--- Pipeline (Whisper + Brain sequential, ms) ---');
    const s = stats(totalMs);
    console.log(`  n=${totalMs.length}  min=${s.min.toFixed(0)}  p50=${s.p50.toFixed(0)}  p95=${s.p95.toFixed(0)}  p99=${s.p99.toFixed(0)}  max=${s.max.toFixed(0)}  avg=${s.avg.toFixed(0)}`);
  }
  if (opts.mode === 'full') {
    console.log('\n--- End-to-end (Whisper + Brain + TTS sequential, ms) ---');
    const s = stats(totalMs);
    console.log(`  n=${totalMs.length}  min=${s.min.toFixed(0)}  p50=${s.p50.toFixed(0)}  p95=${s.p95.toFixed(0)}  p99=${s.p99.toFixed(0)}  max=${s.max.toFixed(0)}  avg=${s.avg.toFixed(0)}`);
  }

  console.log('\nInterpretation: compare p95/p99 under rising --concurrency. When latency spikes or errors grow, you are past "good quality" for that tier.\n');

  if (errors.length > 0) {
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
