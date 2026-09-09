import { env } from '../../env';
import { log } from '../../log';
import type { STTProvider } from '../provider';
import type { STTAudioInput, STTOptions, STTTranscript } from '../types';
import { pcm16leToWav } from '../pcmWav';

export class OpenAiWhisperProvider implements STTProvider {
  id = 'openai_whisper' as const;
  supportsPartials = false;

  async transcribe(audio: STTAudioInput, opts: STTOptions = {}): Promise<STTTranscript> {
    const key = env.OPENAI_API_KEY;
    if (!key) throw new Error('openai_api_key_missing');
    const model = opts.endpointUrl?.includes('whisper') ? 'whisper-1' : 'whisper-1';
    const wav = audio.encoding === 'wav' ? audio.audio : pcm16leToWav(audio.audio, audio.sampleRateHz);
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(wav)], { type: 'audio/wav' }), 'utterance.wav');
    form.append('model', model);
    if (opts.language) form.append('language', opts.language);
    const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}` },
      body: form,
      signal: opts.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      log.error({ status: res.status, body: body.slice(0, 200) }, 'openai whisper error');
      throw new Error(`openai_whisper_${res.status}`);
    }
    const json = (await res.json()) as { text?: string };
    return { text: (json.text || '').trim(), isFinal: true };
  }
}
