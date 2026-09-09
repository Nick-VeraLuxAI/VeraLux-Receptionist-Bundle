import { randomUUID } from 'crypto';

import { runPlaybackPipeline } from '../audio/playbackPipeline';
import { pushFarEndFrames } from '../audio/farEndReference';
import { parseWavInfo } from '../audio/wavInfo';
import { env } from '../env';
import { log } from '../log';
import {
  buildRtpClearEvent,
  buildRtpMarkEvent,
  buildRtpMediaEvent,
  wavToL16Pcm16k,
} from '../media/bidirectionalRtp';
import { sendMediaWsJson, waitForMediaWs } from '../media/mediaWsBridge';
import type { RuntimeTenantConfig } from '../tenants/tenantConfig';
import { streamKokoroSpeech } from './kokoroStream';

const KOKORO_VOICE = /^(a[fm]_|b[fm]_)[a-z]+$/i;

export type KokoroStreamPlayResult = {
  ok: boolean;
  chunks: number;
  firstAudioMs: number | null;
  durationMs: number;
  aborted: boolean;
};

export async function tryPlayKokoroStreamToTelnyx(options: {
  callControlId: string;
  text: string;
  ttsConfig?: RuntimeTenantConfig['tts'] | null;
  logContext?: Record<string, unknown>;
  shouldAbort?: () => boolean;
  onFirstAudio?: (info: { firstAudioMs: number; durationMs: number }) => void;
  onDurationMs?: (durationMs: number) => void;
}): Promise<KokoroStreamPlayResult> {
  const empty: KokoroStreamPlayResult = {
    ok: false,
    chunks: 0,
    firstAudioMs: null,
    durationMs: 0,
    aborted: false,
  };

  const text = (options.text ?? '').trim();
  if (!text) return empty;

  const connected = await waitForMediaWs(options.callControlId, 2500);
  if (!connected) {
    log.info(
      { event: 'tts_kokoro_stream_skipped_no_ws', ...options.logContext },
      'kokoro stream skipped; media ws not ready',
    );
    return empty;
  }

  const cfg = options.ttsConfig && options.ttsConfig.mode === 'kokoro_http' ? options.ttsConfig : undefined;
  const voiceRaw = cfg?.voice || env.KOKORO_VOICE_ID || 'af_bella';
  const voice = KOKORO_VOICE.test(String(voiceRaw).trim()) ? voiceRaw : env.KOKORO_VOICE_ID || 'af_bella';
  const kokoroUrl = (cfg?.kokoroUrl || env.KOKORO_URL || 'http://kokoro:7001/tts').trim();
  const rate = cfg?.rate;
  const sampleRate = cfg?.sampleRate;
  const startedAt = Date.now();
  let chunks = 0;
  let durationMs = 0;
  let firstAudioMs: number | null = null;
  let sentAny = false;

  try {
    for await (const wav of streamKokoroSpeech({
      text,
      voice,
      format: 'wav',
      sampleRate,
      kokoroUrl,
      rate,
    })) {
      if (options.shouldAbort?.()) {
        if (sentAny) sendMediaWsJson(options.callControlId, buildRtpClearEvent());
        return { ok: sentAny, chunks, firstAudioMs, durationMs, aborted: true };
      }

      const applyPipeline = env.PLAYBACK_PROFILE === 'pstn';
      const prepared = applyPipeline
        ? runPlaybackPipeline(wav, {
            targetSampleRateHz: env.PLAYBACK_PSTN_SAMPLE_RATE,
            enableHighpass: env.PLAYBACK_ENABLE_HIGHPASS,
            logContext: options.logContext,
          }).audio
        : wav;

      pushFarEndFrames(options.callControlId, prepared, options.logContext);
      const pcm = wavToL16Pcm16k(prepared);
      if (pcm.length < 2) continue;

      const sent = sendMediaWsJson(options.callControlId, buildRtpMediaEvent(pcm));
      if (!sent) {
        if (sentAny) {
          sendMediaWsJson(
            options.callControlId,
            buildRtpMarkEvent(`tts-stream-${randomUUID()}`),
          );
          return { ok: true, chunks, firstAudioMs, durationMs, aborted: false };
        }
        return empty;
      }

      sentAny = true;
      chunks += 1;
      try {
        durationMs += parseWavInfo(prepared).durationMs;
      } catch {
        durationMs += Math.round((pcm.length / 2 / 16000) * 1000);
      }
      options.onDurationMs?.(durationMs);

      if (firstAudioMs == null) {
        firstAudioMs = Date.now() - startedAt;
        options.onFirstAudio?.({ firstAudioMs, durationMs });
        log.info(
          {
            event: 'tts_kokoro_stream_first_audio',
            first_audio_ms: firstAudioMs,
            chunk_pcm_bytes: pcm.length,
            ...options.logContext,
          },
          'kokoro stream first audio sent as L16 RTP',
        );
      }
    }

    if (!sentAny) return empty;

    const markName = `tts-stream-${randomUUID()}`;
    sendMediaWsJson(options.callControlId, buildRtpMarkEvent(markName));
    log.info(
      {
        event: 'tts_kokoro_stream_played',
        chunks,
        first_audio_ms: firstAudioMs,
        duration_ms: durationMs,
        mark_name: markName,
        ...options.logContext,
      },
      'kokoro stream finished; L16 RTP mark sent',
    );
    return { ok: true, chunks, firstAudioMs, durationMs, aborted: false };
  } catch (error) {
    log.warn(
      {
        event: 'tts_kokoro_stream_failed',
        err: error instanceof Error ? error.message : String(error),
        chunks,
        ...options.logContext,
      },
      'kokoro stream failed; caller may fall back to full WAV',
    );
    if (sentAny) {
      sendMediaWsJson(options.callControlId, buildRtpMarkEvent(`tts-stream-${randomUUID()}`));
      return { ok: true, chunks, firstAudioMs, durationMs, aborted: false };
    }
    return empty;
  }
}
