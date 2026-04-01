/**
 * Measure Qwen3-TTS latency: single full-text /tts vs chunked /tts (qwen3Streaming behavior).
 * Usage: QWEN3_TTS_URL=http://127.0.0.1:7010 npx tsx scripts/benchmark-qwen3-tts-latency.ts
 */
import { splitQwenStreamingChunks } from '../src/tts/qwen3Chunking';

const DEFAULT_URL = 'http://127.0.0.1:7010';

const SAMPLE =
  'Hello, thanks for calling. ' +
  'Our office hours are nine to five Monday through Friday. ' +
  'I can help you schedule an appointment or transfer you to the front desk. ' +
  'Would you prefer morning or afternoon?';

async function ttsOnce(
  root: string,
  text: string,
  speaker: string,
  language: string,
): Promise<{ ms: number; bytes: number }> {
  const base = root.replace(/\/$/, '');
  const endpoint = base.endsWith('/tts') ? base : `${base}/tts`;
  const t0 = performance.now();
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, speaker, language }),
  });
  const buf = Buffer.from(await res.arrayBuffer());
  const ms = performance.now() - t0;
  if (!res.ok) {
    throw new Error(`TTS ${res.status}: ${buf.toString('utf8').slice(0, 200)}`);
  }
  return { ms, bytes: buf.length };
}

function median(nums: number[]): number {
  const s = [...nums].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

async function main() {
  const root = (process.env.QWEN3_TTS_URL || DEFAULT_URL).trim();
  const speaker = process.env.QWEN3_TTS_SPEAKER || 'Ryan';
  const language = process.env.QWEN3_TTS_LANGUAGE || 'English';
  const rounds = Math.max(1, parseInt(process.env.BENCH_ROUNDS || '3', 10));

  console.log(`Qwen3 TTS latency benchmark`);
  console.log(`  URL: ${root}`);
  console.log(`  speaker=${speaker} language=${language}`);
  console.log(`  rounds=${rounds}`);
  console.log(`  sample chars=${SAMPLE.length}`);

  const chunks = splitQwenStreamingChunks(SAMPLE);
  console.log(`  chunks (${chunks.length}): ${chunks.map((c) => `[${c.length}]`).join(' ')}`);
  console.log('');

  // Warmup
  await ttsOnce(root, 'Hi.', speaker, language);

  const singleMs: number[] = [];
  const ttfaMs: number[] = [];
  const chunkedTotalMs: number[] = [];

  for (let r = 0; r < rounds; r++) {
    const s = await ttsOnce(root, SAMPLE, speaker, language);
    singleMs.push(s.ms);

    const tChunk0 = performance.now();
    let firstDone = 0;
    let total = 0;
    for (let i = 0; i < chunks.length; i++) {
      const c = chunks[i]!;
      const { ms } = await ttsOnce(root, c, speaker, language);
      total += ms;
      if (i === 0) {
        firstDone = performance.now() - tChunk0;
      }
    }
    ttfaMs.push(firstDone);
    chunkedTotalMs.push(total);
  }

  console.log('Results (ms):');
  console.log(`  Single-shot (full text, one /tts):     median=${median(singleMs).toFixed(0)}  all=[${singleMs.map((x) => x.toFixed(0)).join(', ')}]`);
  console.log(`  Chunked TTFA (first chunk complete):   median=${median(ttfaMs).toFixed(0)}  all=[${ttfaMs.map((x) => x.toFixed(0)).join(', ')}]`);
  console.log(`  Chunked total (sum of chunk requests): median=${median(chunkedTotalMs).toFixed(0)}  all=[${chunkedTotalMs.map((x) => x.toFixed(0)).join(', ')}]`);
  const medSingle = median(singleMs);
  const medTtfa = median(ttfaMs);
  const delta = medSingle - medTtfa;
  console.log('');
  console.log(`  Estimated time-to-first-audio improvement (median single − median first chunk): ${delta.toFixed(0)} ms (${delta > 0 ? 'chunked faster to first audio' : 'no improvement or noise'})`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
