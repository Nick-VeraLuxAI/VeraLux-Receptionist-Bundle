#!/usr/bin/env npx tsx
/**
 * One STT + one brain call, then time each TTS backend with the same reply text.
 * Skips backends whose URL env vars are unset (after localhost defaults).
 *
 * Usage:
 *   npx tsx scripts/benchmark-tts-backends.ts /path/to/utterance.wav
 *
 * Chatterbox Turbo optional voice reference (URL reachable from the Chatterbox container):
 *   CHATTERBOX_BENCH_SPEAKER_URL=http://172.17.0.1:8766/your.wav
 * (Host a folder with: python3 -m http.server 8766 --directory /path/to/dir)
 *
 * Host URLs (when services run in Docker): set in shell or .env, e.g.
 *   WHISPER_URL=http://127.0.0.1:9000/transcribe
 *   BRAIN_URL=http://127.0.0.1:3001
 *   KOKORO_URL=http://127.0.0.1:7001/tts
 *   CHATTERBOX_URL=http://127.0.0.1:7005
 *   COQUI_XTTS_URL=http://127.0.0.1:7002/tts
 *   QWEN3_TTS_URL=http://127.0.0.1:7010
 *
 * GPU verification (fail if any *configured* TTS backend is not on GPU):
 *   TTS_BENCH_REQUIRE_GPU=true npx tsx scripts/benchmark-tts-backends.ts /path/to.wav
 * Or: npm run benchmark:tts-gpu -- /path/to.wav
 * Uses GET /health (kokoro: device=cuda, chatterbox/qwen3: device, xtts: gpu=true). Whisper line is FYI only.
 * Stack: docker compose --profile gpu up -d kokoro-gpu xtts-gpu whisper-gpu chatterbox-gpu qwen3-tts-gpu
 * Point URLs at localhost published ports. Split GPU IDs if one card is tight (see .env.example).
 * Skip preflight: TTS_BENCH_SKIP_GPU_PREFLIGHT=true
 */

import fs from 'node:fs';
import path from 'node:path';
import { config as loadEnv } from 'dotenv';

const scriptDir = __dirname;
loadEnv({ path: path.resolve(scriptDir, '../../.env') });
loadEnv({ path: path.resolve(scriptDir, '../.env'), override: true });

function hostifyDockerUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  return url
    .replace('://kokoro:', '://127.0.0.1:')
    .replace('://xtts:', '://127.0.0.1:')
    .replace('://chatterbox:', '://127.0.0.1:')
    .replace('://veralux-qwen3-tts:', '://127.0.0.1:')
    .replace('://qwen3-tts:', '://127.0.0.1:');
}

/** e.g. http://127.0.0.1:7001/tts -> http://127.0.0.1:7001 */
function originFromAnyServiceUrl(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url.replace(/\/$/, '').replace(/\/tts\/?$/i, '');
  }
}

async function fetchHealthJson(origin: string, timeoutMs: number): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch(`${origin.replace(/\/$/, '')}/health`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function envTruth(name: string): boolean {
  const v = process.env[name]?.trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

type PreflightRow = { service: string; gpuOk: boolean; detail: string };

/**
 * TTS backends: Kokoro health.device must be cuda (CPU image uses "default").
 * Chatterbox / Qwen3: device mentions cuda. XTTS: gpu === true.
 * Whisper is printed for context only — not enforced by TTS_BENCH_REQUIRE_GPU.
 */
async function runGpuPreflight(opts: {
  whisperUrl: string;
  kokoroUrl: string;
  chatterboxUrl: string;
  coquiUrl: string;
  qwen3Url: string;
}): Promise<{ whisperLine: string; ttsRows: PreflightRow[] }> {
  const timeoutMs = Math.min(15_000, Number(process.env.TTS_BENCH_HEALTH_TIMEOUT_MS) || 8_000);

  const whisperOrigin = originFromAnyServiceUrl(opts.whisperUrl);
  const wj = await fetchHealthJson(whisperOrigin, timeoutMs);
  const wDev = wj?.device;
  const wGpuOk = typeof wDev === 'string' && wDev.toLowerCase().includes('cuda');
  const whisperTag = (wGpuOk ? 'GPU ok' : 'CPU or unknown').padEnd(14);
  const whisperDetail = wj ? `device=${String(wDev)}` : `no health at ${whisperOrigin}/health`;
  const whisperLine = `whisper (STT)   ${whisperTag} ${whisperDetail}`;

  const rows: PreflightRow[] = [];

  const kj = await fetchHealthJson(originFromAnyServiceUrl(opts.kokoroUrl), timeoutMs);
  const kDev = kj?.device;
  const kOk = kDev === 'cuda' || (typeof kDev === 'string' && kDev.toLowerCase().includes('cuda'));
  rows.push({
    service: 'kokoro',
    gpuOk: kOk,
    detail: kj ? `device=${String(kDev)}` : 'no health',
  });

  if (opts.chatterboxUrl) {
    const cj = await fetchHealthJson(originFromAnyServiceUrl(opts.chatterboxUrl), timeoutMs);
    const cDev = cj?.device;
    const cOk = typeof cDev === 'string' && cDev.toLowerCase().includes('cuda');
    rows.push({
      service: 'chatterbox',
      gpuOk: cOk,
      detail: cj ? `device=${String(cDev)}` : 'no health',
    });
  }

  if (opts.coquiUrl) {
    const xj = await fetchHealthJson(originFromAnyServiceUrl(opts.coquiUrl), timeoutMs);
    const xGpu = xj?.gpu;
    const xOk = xGpu === true;
    rows.push({
      service: 'coqui_xtts',
      gpuOk: xOk,
      detail: xj ? `gpu=${String(xGpu)}` : 'no health',
    });
  }

  if (opts.qwen3Url) {
    const qj = await fetchHealthJson(originFromAnyServiceUrl(opts.qwen3Url), timeoutMs);
    const qDev = qj?.device;
    const qOk = typeof qDev === 'string' && qDev.toLowerCase().includes('cuda');
    rows.push({
      service: 'qwen3_tts',
      gpuOk: qOk,
      detail: qj ? `device=${String(qDev)}` : 'no health',
    });
  }

  return { whisperLine, ttsRows: rows };
}

function printGpuPreflight(whisperLine: string, ttsRows: PreflightRow[]): void {
  console.log('--- GPU preflight (/health) ---\n');
  console.log(whisperLine);
  for (const r of ttsRows) {
    const tag = r.gpuOk ? 'GPU ok' : 'CPU or unknown';
    console.log(`${r.service.padEnd(14)} ${tag.padEnd(14)} ${r.detail}`);
  }
  console.log('');
}

async function postWhisper(url: string, wav: Buffer): Promise<{ ms: number; text: string }> {
  const t0 = Date.now();
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'audio/wav' },
    body: wav,
  });
  const j = (await res.json()) as { text?: string };
  const ms = Date.now() - t0;
  if (!res.ok) throw new Error(`whisper HTTP ${res.status}`);
  return { ms, text: typeof j.text === 'string' ? j.text : '' };
}

async function postBrain(
  replyUrl: string,
  transcript: string,
): Promise<{ ms: number; text: string }> {
  const t0 = Date.now();
  const res = await fetch(replyUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      callControlId: `bench-tts-${Date.now()}`,
      transcript,
      history: [],
    }),
  });
  const j = (await res.json()) as { text?: string };
  const ms = Date.now() - t0;
  if (!res.ok) throw new Error(`brain HTTP ${res.status}`);
  if (typeof j.text !== 'string' || !j.text.trim()) throw new Error('brain empty text');
  return { ms, text: j.text.trim() };
}

async function postKokoro(url: string, text: string, voiceId: string): Promise<{ ms: number; bytes: number }> {
  const t0 = Date.now();
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: text.slice(0, 1000), voice_id: voiceId }),
  });
  const buf = await res.arrayBuffer();
  const ms = Date.now() - t0;
  if (!res.ok) throw new Error(`kokoro HTTP ${res.status}`);
  return { ms, bytes: buf.byteLength };
}

async function postChatterbox(
  baseUrl: string,
  text: string,
  speakerWavUrl?: string,
): Promise<{ ms: number; bytes: number }> {
  const root = baseUrl.replace(/\/$/, '');
  const endpoint = root.endsWith('/tts') ? root : `${root}/tts`;
  const body: Record<string, string> = {
    text: text.slice(0, 1500),
    language_id: 'en',
  };
  if (speakerWavUrl?.trim()) {
    body.speaker_wav_url = speakerWavUrl.trim();
  }
  const t0 = Date.now();
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const buf = await res.arrayBuffer();
  const ms = Date.now() - t0;
  if (!res.ok) throw new Error(`chatterbox HTTP ${res.status}`);
  return { ms, bytes: buf.byteLength };
}

async function postCoquiXtts(url: string, text: string, voiceId: string): Promise<{ ms: number; bytes: number }> {
  const single = process.env.COQUI_SINGLE_SPEAKER === 'true';
  const body: Record<string, string> = {
    text: text.slice(0, 2000),
    language: 'en',
  };
  if (!single) {
    body.voice_id = voiceId;
    body.speaker = voiceId;
  }
  const t0 = Date.now();
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const buf = await res.arrayBuffer();
  const ms = Date.now() - t0;
  if (!res.ok) throw new Error(`xtts HTTP ${res.status}`);
  const ct = res.headers.get('content-type') ?? '';
  if (ct.includes('application/json')) {
    throw new Error(`xtts returned JSON: ${new TextDecoder().decode(buf.slice(0, 400))}`);
  }
  return { ms, bytes: buf.byteLength };
}

async function postQwen3(
  baseUrl: string,
  text: string,
  speaker: string,
  language: string,
): Promise<{ ms: number; bytes: number }> {
  const root = baseUrl.replace(/\/$/, '');
  const endpoint = root.endsWith('/tts') ? root : `${root}/tts`;
  const t0 = Date.now();
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text: text.slice(0, 2000),
      speaker,
      language,
    }),
  });
  const buf = await res.arrayBuffer();
  const ms = Date.now() - t0;
  if (!res.ok) throw new Error(`qwen3 HTTP ${res.status}`);
  return { ms, bytes: buf.byteLength };
}

async function main(): Promise<void> {
  const wavArg = process.argv[2];
  if (!wavArg) {
    console.error('Usage: npx tsx scripts/benchmark-tts-backends.ts <file.wav>');
    process.exit(2);
  }
  const wavPath = path.resolve(wavArg);
  if (!fs.existsSync(wavPath)) {
    console.error(`File not found: ${wavPath}`);
    process.exit(2);
  }
  const wav = fs.readFileSync(wavPath);

  const whisperUrl = process.env.WHISPER_URL || 'http://127.0.0.1:9000/transcribe';
  let brainBase = process.env.BRAIN_URL || 'http://127.0.0.1:3001';
  brainBase = brainBase.replace(/\/$/, '');
  const replyUrl = brainBase.endsWith('/reply') ? brainBase : `${brainBase}/reply`;

  const kokoroUrl = hostifyDockerUrl(process.env.KOKORO_URL) || 'http://127.0.0.1:7001/tts';
  const chatterboxUrl =
    hostifyDockerUrl(process.env.CHATTERBOX_URL || process.env.E2E_CHATTERBOX_URL) || '';
  const coquiUrl =
    hostifyDockerUrl(process.env.COQUI_XTTS_URL || process.env.XTTS_URL) || '';
  const qwen3Url = hostifyDockerUrl(process.env.QWEN3_TTS_URL) || '';

  let kokoroVoice = process.env.KOKORO_VOICE_ID || 'bf_emma';
  if (kokoroVoice.toLowerCase() === 'default') kokoroVoice = 'bf_emma';
  const coquiVoice = process.env.COQUI_VOICE_ID || 'en_sample';
  const qwenSpeaker = process.env.QWEN3_TTS_SPEAKER || 'Ryan';
  const qwenLang = process.env.QWEN3_TTS_LANGUAGE || 'English';
  const chatterboxSpeakerUrl = process.env.CHATTERBOX_BENCH_SPEAKER_URL?.trim();

  console.log(`\nWAV: ${wavPath} (${wav.length} bytes)`);
  console.log(`Whisper: ${whisperUrl}`);
  console.log(`Brain:   ${replyUrl}`);
  if (chatterboxSpeakerUrl) {
    console.log(`Chatterbox speaker_wav_url: ${chatterboxSpeakerUrl}`);
  }
  console.log('');

  const skipPreflight = envTruth('TTS_BENCH_SKIP_GPU_PREFLIGHT');
  if (!skipPreflight) {
    const { whisperLine, ttsRows } = await runGpuPreflight({
      whisperUrl,
      kokoroUrl,
      chatterboxUrl,
      coquiUrl,
      qwen3Url,
    });
    printGpuPreflight(whisperLine, ttsRows);

    if (envTruth('TTS_BENCH_REQUIRE_GPU')) {
      const bad = ttsRows.filter((r) => !r.gpuOk);
      if (bad.length > 0) {
        console.error('TTS_BENCH_REQUIRE_GPU: these TTS services are not on GPU (fix compose / image, then retry):\n');
        for (const r of bad) {
          console.error(`  - ${r.service}: ${r.detail}`);
        }
        console.error(
          '\nTip: docker compose --profile gpu up -d kokoro-gpu xtts-gpu whisper-gpu chatterbox-gpu qwen3-tts-gpu',
        );
        console.error('Match localhost URLs (see script header). CPU Kokoro shows health device=default; GPU uses cuda.\n');
        process.exit(3);
      }
    }
  }

  console.log('Running Whisper…');
  const w = await postWhisper(whisperUrl, wav);
  console.log(`  STT ${w.ms} ms — "${w.text.slice(0, 120)}${w.text.length > 120 ? '…' : ''}"`);

  const transcript = w.text.trim() || 'What time do you close?';
  console.log('Running brain…');
  const b = await postBrain(replyUrl, transcript);
  console.log(`  LLM ${b.ms} ms — ${b.text.length} chars — "${b.text.slice(0, 100)}${b.text.length > 100 ? '…' : ''}"\n`);

  const reply = b.text;
  const rows: { backend: string; ms: number; bytes: number; note?: string }[] = [];

  const tryBackend = async (name: string, fn: () => Promise<{ ms: number; bytes: number }>) => {
    try {
      const r = await fn();
      rows.push({ backend: name, ...r });
      console.log(`${name.padEnd(14)} TTS  ${String(r.ms).padStart(5)} ms   ${r.bytes} bytes WAV`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      rows.push({ backend: name, ms: -1, bytes: 0, note: msg });
      console.log(`${name.padEnd(14)} SKIP ${msg}`);
    }
  };

  console.log('--- TTS only (same text for each) ---\n');
  await tryBackend('kokoro', () => postKokoro(kokoroUrl, reply, kokoroVoice));

  if (chatterboxUrl) {
    await tryBackend('chatterbox', () => postChatterbox(chatterboxUrl, reply, chatterboxSpeakerUrl));
  } else {
    console.log(`${'chatterbox'.padEnd(14)} SKIP (set CHATTERBOX_URL)`);
  }

  if (coquiUrl) {
    await tryBackend('coqui_xtts', () => postCoquiXtts(coquiUrl, reply, coquiVoice));
  } else {
    console.log(`${'coqui_xtts'.padEnd(14)} SKIP (set COQUI_XTTS_URL or XTTS_URL)`);
  }

  if (qwen3Url) {
    await tryBackend('qwen3_tts', () => postQwen3(qwen3Url, reply, qwenSpeaker, qwenLang));
  } else {
    console.log(`${'qwen3_tts'.padEnd(14)} SKIP (set QWEN3_TTS_URL)`);
  }

  const sttLlm = w.ms + b.ms;
  console.log('\n--- Full pipeline estimate (STT + LLM + TTS) ---\n');
  for (const r of rows) {
    if (r.ms < 0) continue;
    console.log(`${r.backend.padEnd(14)} total ~${sttLlm + r.ms} ms (STT+LLM ${sttLlm} + TTS ${r.ms})`);
  }
  console.log('');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
