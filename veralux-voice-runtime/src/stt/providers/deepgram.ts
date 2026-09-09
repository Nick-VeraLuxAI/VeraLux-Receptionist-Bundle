import { env } from '../../env';
import { log } from '../../log';
import type { STTProvider } from '../provider';
import type { STTAudioInput, STTOptions, STTTranscript } from '../types';
import { pcm16leToWav } from '../pcmWav';

export class DeepgramProvider implements STTProvider {
  id = 'deepgram' as const;
  supportsPartials = false;

  async transcribe(audio: STTAudioInput, opts: STTOptions = {}): Promise<STTTranscript> {
    const key = env.DEEPGRAM_API_KEY;
    if (!key) throw new Error('deepgram_api_key_missing');
    const wav = audio.encoding === 'wav' ? audio.audio : pcm16leToWav(audio.audio, audio.sampleRateHz);
    const model = 'nova-2';
    const lang = opts.language ? `&language=${encodeURIComponent(opts.language)}` : '';
    const res = await fetch(`https://api.deepgram.com/v1/listen?model=${model}${lang}`, {
      method: 'POST',
      headers: {
        Authorization: `Token ${key}`,
        'Content-Type': 'audio/wav',
      },
      body: new Uint8Array(wav),
      signal: opts.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      log.error({ status: res.status, body: body.slice(0, 200) }, 'deepgram stt error');
      throw new Error(`deepgram_${res.status}`);
    }
    const json = (await res.json()) as { results?: { channels?: Array<{ alternatives?: Array<{ transcript?: string }> }> } };
    const text = json.results?.channels?.[0]?.alternatives?.[0]?.transcript || '';
    return { text: text.trim(), isFinal: true };
  }
}
