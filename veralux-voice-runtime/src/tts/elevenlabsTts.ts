import { hasUsableApiKey } from '@veralux/shared';
import { env } from '../env';
import { log } from '../log';
import { fetchWithTimeoutRetry } from '../httpClient';
import type { TTSResult } from './types';

function pcm16ToWav(pcm: Buffer, sampleRate: number): Buffer {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

export async function synthesizeSpeechElevenLabs(args: {
  text: string;
  voice?: string;
  model?: string;
  sampleRate?: number;
}): Promise<TTSResult> {
  const apiKey = env.ELEVENLABS_API_KEY;
  if (!hasUsableApiKey(apiKey)) {
    throw new Error('ElevenLabs TTS requires ELEVENLABS_API_KEY');
  }
  const voice = encodeURIComponent((args.voice || 'EXAVITQu4vr4xnSDxMaL').trim() || 'EXAVITQu4vr4xnSDxMaL');
  const model = (args.model || 'eleven_turbo_v2_5').trim() || 'eleven_turbo_v2_5';
  const sampleRate = args.sampleRate && args.sampleRate > 0 ? args.sampleRate : 24000;
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${voice}?output_format=pcm_${sampleRate}`;
  log.info({ event: 'tts_request', provider: 'elevenlabs', voice, model, sampleRate }, 'tts request');
  const response = await fetchWithTimeoutRetry(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'xi-api-key': apiKey as string,
      Accept: 'application/octet-stream',
    },
    body: JSON.stringify({ text: args.text, model_id: model }),
    timeoutMs: 20_000,
    retries: 1,
  });
  if (!response.ok) {
    const body = await response.text();
    log.error({ status: response.status, body }, 'elevenlabs tts error');
    throw new Error(`elevenlabs tts error ${response.status}`);
  }
  const pcm = Buffer.from(await response.arrayBuffer());
  return {
    audio: pcm16ToWav(pcm, sampleRate),
    contentType: 'audio/wav',
  };
}
