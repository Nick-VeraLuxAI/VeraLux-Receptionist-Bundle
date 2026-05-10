import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { STTAudioInput, STTProvider } from '../src/stt/chunkedSTT';
import { setTestEnv } from './testEnv';

setTestEnv();

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** One STT frame at 8 kHz mono (20 ms). */
function sineFrame8k(freqHz: number, amp: number): Int16Array {
  const sampleRate = 8000;
  const n = 160;
  const a = new Int16Array(n);
  for (let i = 0; i < n; i += 1) {
    a[i] = Math.round(amp * Math.sin((2 * Math.PI * freqHz * i) / sampleRate));
  }
  return a;
}

async function loadChunkedSTT() {
  return import('../src/stt/chunkedSTT');
}

test('steady caller speech finalizes and reaches Whisper', async () => {
  const prevVad = process.env.STT_VAD_ENABLED;
  const prevNoise = process.env.STT_NOISE_FLOOR_ENABLED;
  const prevMin = process.env.STT_MIN_SECONDS;
  process.env.STT_VAD_ENABLED = 'false';
  process.env.STT_NOISE_FLOOR_ENABLED = 'false';
  process.env.STT_MIN_SECONDS = '0.2';
  try {
    const { ChunkedSTT } = await loadChunkedSTT();
    let transcribeCalls = 0;
    const provider: STTProvider = {
      id: 'http_pcm16',
      transcribe: async (_input: STTAudioInput) => {
        transcribeCalls += 1;
        return { text: 'what time do you close' };
      },
    };

    const stt = new ChunkedSTT({
      provider,
      whisperUrl: 'http://localhost/whisper',
      inputCodec: 'pcm16le',
      sampleRate: 8000,
      frameMs: 20,
      speechFramesRequired: 3,
      speechRmsFloor: 0.012,
      speechPeakFloor: 0.035,
      silenceEndMs: 350,
      onTranscript: () => undefined,
      isCallActive: () => true,
      isListening: () => true,
      isPlaybackActive: () => false,
    });

    const strong = sineFrame8k(440, 9000);
    for (let i = 0; i < 25; i += 1) stt.ingestPcm16(strong, 8000);
    for (let i = 0; i < 40; i += 1) stt.ingestPcm16(new Int16Array(160), 8000);
    await sleep(80);
    await stt.stop({ allowFinal: true });
    assert.ok(transcribeCalls >= 1, 'expected at least one Whisper transcribe');
  } finally {
    if (prevVad === undefined) delete process.env.STT_VAD_ENABLED;
    else process.env.STT_VAD_ENABLED = prevVad;
    if (prevNoise === undefined) delete process.env.STT_NOISE_FLOOR_ENABLED;
    else process.env.STT_NOISE_FLOOR_ENABLED = prevNoise;
    if (prevMin === undefined) delete process.env.STT_MIN_SECONDS;
    else process.env.STT_MIN_SECONDS = prevMin;
  }
});

test('speech streak tolerates a brief non-speech frame when gate still shows partial energy', async () => {
  const prevVad = process.env.STT_VAD_ENABLED;
  const prevNoise = process.env.STT_NOISE_FLOOR_ENABLED;
  const prevMin = process.env.STT_MIN_SECONDS;
  process.env.STT_VAD_ENABLED = 'false';
  process.env.STT_NOISE_FLOOR_ENABLED = 'false';
  process.env.STT_MIN_SECONDS = '0.2';
  try {
    const { ChunkedSTT } = await loadChunkedSTT();
    let transcribeCalls = 0;
    const provider: STTProvider = {
      id: 'http_pcm16',
      transcribe: async () => {
        transcribeCalls += 1;
        return { text: 'ok' };
      },
    };

    const stt = new ChunkedSTT({
      provider,
      whisperUrl: 'http://localhost/whisper',
      inputCodec: 'pcm16le',
      sampleRate: 8000,
      frameMs: 20,
      speechFramesRequired: 5,
      speechRmsFloor: 0.014,
      speechPeakFloor: 0.04,
      silenceEndMs: 350,
      onTranscript: () => undefined,
      isCallActive: () => true,
      isListening: () => true,
      isPlaybackActive: () => false,
    });

    const strong = sineFrame8k(380, 9500);
    const weak = sineFrame8k(380, 2200);
    for (let i = 0; i < 4; i += 1) stt.ingestPcm16(strong, 8000);
    stt.ingestPcm16(weak, 8000);
    for (let i = 0; i < 18; i += 1) stt.ingestPcm16(strong, 8000);
    for (let i = 0; i < 40; i += 1) stt.ingestPcm16(new Int16Array(160), 8000);
    await sleep(80);
    await stt.stop({ allowFinal: true });
    assert.ok(transcribeCalls >= 1, 'expected Whisper after streak recovery');
  } finally {
    if (prevVad === undefined) delete process.env.STT_VAD_ENABLED;
    else process.env.STT_VAD_ENABLED = prevVad;
    if (prevNoise === undefined) delete process.env.STT_NOISE_FLOOR_ENABLED;
    else process.env.STT_NOISE_FLOOR_ENABLED = prevNoise;
    if (prevMin === undefined) delete process.env.STT_MIN_SECONDS;
    else process.env.STT_MIN_SECONDS = prevMin;
  }
});

test('near-silence PCM does not enqueue Whisper', async () => {
  const prevVad = process.env.STT_VAD_ENABLED;
  process.env.STT_VAD_ENABLED = 'false';
  try {
    const { ChunkedSTT } = await loadChunkedSTT();
    let transcribeCalls = 0;
    const provider: STTProvider = {
      id: 'http_pcm16',
      transcribe: async () => {
        transcribeCalls += 1;
        return { text: 'noise' };
      },
    };

    const stt = new ChunkedSTT({
      provider,
      whisperUrl: 'http://localhost/whisper',
      inputCodec: 'pcm16le',
      sampleRate: 8000,
      speechFramesRequired: 2,
      speechRmsFloor: 0.02,
      speechPeakFloor: 0.05,
      onTranscript: () => undefined,
      isCallActive: () => true,
      isListening: () => true,
      isPlaybackActive: () => false,
    });

    const quiet = new Int16Array(160);
    for (let i = 0; i < 80; i += 1) {
      quiet[0] = 40;
      stt.ingestPcm16(quiet, 8000);
    }
    await sleep(40);
    await stt.stop({ allowFinal: false });
    assert.equal(transcribeCalls, 0);
  } finally {
    if (prevVad === undefined) delete process.env.STT_VAD_ENABLED;
    else process.env.STT_VAD_ENABLED = prevVad;
  }
});

test('playback active blocks Whisper even with loud inbound', async () => {
  const prevVad = process.env.STT_VAD_ENABLED;
  process.env.STT_VAD_ENABLED = 'false';
  try {
    const { ChunkedSTT } = await loadChunkedSTT();
    let transcribeCalls = 0;
    const provider: STTProvider = {
      id: 'http_pcm16',
      transcribe: async () => {
        transcribeCalls += 1;
        return { text: 'echo' };
      },
    };

    const stt = new ChunkedSTT({
      provider,
      whisperUrl: 'http://localhost/whisper',
      inputCodec: 'pcm16le',
      sampleRate: 8000,
      speechFramesRequired: 1,
      speechRmsFloor: 0.001,
      speechPeakFloor: 0.001,
      onTranscript: () => undefined,
      isCallActive: () => true,
      isListening: () => true,
      isPlaybackActive: () => true,
    });

    const strong = sineFrame8k(300, 12000);
    for (let i = 0; i < 30; i += 1) stt.ingestPcm16(strong, 8000);
    await sleep(40);
    await stt.stop({ allowFinal: false });
    assert.equal(transcribeCalls, 0);
  } finally {
    if (prevVad === undefined) delete process.env.STT_VAD_ENABLED;
    else process.env.STT_VAD_ENABLED = prevVad;
  }
});

test('onSttListeningGateActivity fires when listening and inbound shows gate energy', async () => {
  const prevVad = process.env.STT_VAD_ENABLED;
  process.env.STT_VAD_ENABLED = 'false';
  try {
    const { ChunkedSTT } = await loadChunkedSTT();
    const provider: STTProvider = {
      id: 'http_pcm16',
      transcribe: async () => ({ text: '' }),
    };
    let hits = 0;
    const stt = new ChunkedSTT({
      provider,
      whisperUrl: 'http://localhost/whisper',
      inputCodec: 'pcm16le',
      sampleRate: 8000,
      speechFramesRequired: 8,
      speechRmsFloor: 0.02,
      speechPeakFloor: 0.055,
      onTranscript: () => undefined,
      isCallActive: () => true,
      isListening: () => true,
      isPlaybackActive: () => false,
      onSttListeningGateActivity: () => {
        hits += 1;
      },
    });

    const med = sineFrame8k(500, 7000);
    for (let i = 0; i < 12; i += 1) stt.ingestPcm16(med, 8000);
    await sleep(30);
    await stt.stop({ allowFinal: false });
    assert.ok(hits >= 1, 'expected gate activity callback');
  } finally {
    if (prevVad === undefined) delete process.env.STT_VAD_ENABLED;
    else process.env.STT_VAD_ENABLED = prevVad;
  }
});
