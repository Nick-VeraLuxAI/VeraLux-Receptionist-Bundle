"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.tryPlayKokoroStreamToTelnyx = tryPlayKokoroStreamToTelnyx;
const crypto_1 = require("crypto");
const playbackPipeline_1 = require("../audio/playbackPipeline");
const farEndReference_1 = require("../audio/farEndReference");
const wavInfo_1 = require("../audio/wavInfo");
const env_1 = require("../env");
const log_1 = require("../log");
const bidirectionalRtp_1 = require("../media/bidirectionalRtp");
const mediaWsBridge_1 = require("../media/mediaWsBridge");
const kokoroStream_1 = require("./kokoroStream");
const KOKORO_VOICE = /^(a[fm]_|b[fm]_)[a-z]+$/i;
async function tryPlayKokoroStreamToTelnyx(options) {
    const empty = {
        ok: false,
        chunks: 0,
        firstAudioMs: null,
        durationMs: 0,
        aborted: false,
    };
    const text = (options.text ?? '').trim();
    if (!text)
        return empty;
    const connected = await (0, mediaWsBridge_1.waitForMediaWs)(options.callControlId, 2500);
    if (!connected) {
        log_1.log.info({ event: 'tts_kokoro_stream_skipped_no_ws', ...options.logContext }, 'kokoro stream skipped; media ws not ready');
        return empty;
    }
    const cfg = options.ttsConfig && options.ttsConfig.mode === 'kokoro_http' ? options.ttsConfig : undefined;
    const voiceRaw = cfg?.voice || env_1.env.KOKORO_VOICE_ID || 'af_bella';
    const voice = KOKORO_VOICE.test(String(voiceRaw).trim()) ? voiceRaw : env_1.env.KOKORO_VOICE_ID || 'af_bella';
    const kokoroUrl = (cfg?.kokoroUrl || env_1.env.KOKORO_URL || 'http://kokoro:7001/tts').trim();
    const rate = cfg?.rate;
    const sampleRate = cfg?.sampleRate;
    const startedAt = Date.now();
    let chunks = 0;
    let durationMs = 0;
    let firstAudioMs = null;
    let sentAny = false;
    try {
        for await (const wav of (0, kokoroStream_1.streamKokoroSpeech)({
            text,
            voice,
            format: 'wav',
            sampleRate,
            kokoroUrl,
            rate,
        })) {
            if (options.shouldAbort?.()) {
                if (sentAny)
                    (0, mediaWsBridge_1.sendMediaWsJson)(options.callControlId, (0, bidirectionalRtp_1.buildRtpClearEvent)());
                return { ok: sentAny, chunks, firstAudioMs, durationMs, aborted: true };
            }
            const applyPipeline = env_1.env.PLAYBACK_PROFILE === 'pstn';
            const prepared = applyPipeline
                ? (0, playbackPipeline_1.runPlaybackPipeline)(wav, {
                    targetSampleRateHz: env_1.env.PLAYBACK_PSTN_SAMPLE_RATE,
                    enableHighpass: env_1.env.PLAYBACK_ENABLE_HIGHPASS,
                    logContext: options.logContext,
                }).audio
                : wav;
            (0, farEndReference_1.pushFarEndFrames)(options.callControlId, prepared, options.logContext);
            const pcm = (0, bidirectionalRtp_1.wavToL16Pcm16k)(prepared);
            if (pcm.length < 2)
                continue;
            const sent = (0, mediaWsBridge_1.sendMediaWsJson)(options.callControlId, (0, bidirectionalRtp_1.buildRtpMediaEvent)(pcm));
            if (!sent) {
                if (sentAny) {
                    (0, mediaWsBridge_1.sendMediaWsJson)(options.callControlId, (0, bidirectionalRtp_1.buildRtpMarkEvent)(`tts-stream-${(0, crypto_1.randomUUID)()}`));
                    return { ok: true, chunks, firstAudioMs, durationMs, aborted: false };
                }
                return empty;
            }
            sentAny = true;
            chunks += 1;
            try {
                durationMs += (0, wavInfo_1.parseWavInfo)(prepared).durationMs;
            }
            catch {
                durationMs += Math.round((pcm.length / 2 / 16000) * 1000);
            }
            options.onDurationMs?.(durationMs);
            if (firstAudioMs == null) {
                firstAudioMs = Date.now() - startedAt;
                options.onFirstAudio?.({ firstAudioMs, durationMs });
                log_1.log.info({
                    event: 'tts_kokoro_stream_first_audio',
                    first_audio_ms: firstAudioMs,
                    chunk_pcm_bytes: pcm.length,
                    ...options.logContext,
                }, 'kokoro stream first audio sent as L16 RTP');
            }
        }
        if (!sentAny)
            return empty;
        const markName = `tts-stream-${(0, crypto_1.randomUUID)()}`;
        (0, mediaWsBridge_1.sendMediaWsJson)(options.callControlId, (0, bidirectionalRtp_1.buildRtpMarkEvent)(markName));
        log_1.log.info({
            event: 'tts_kokoro_stream_played',
            chunks,
            first_audio_ms: firstAudioMs,
            duration_ms: durationMs,
            mark_name: markName,
            ...options.logContext,
        }, 'kokoro stream finished; L16 RTP mark sent');
        return { ok: true, chunks, firstAudioMs, durationMs, aborted: false };
    }
    catch (error) {
        log_1.log.warn({
            event: 'tts_kokoro_stream_failed',
            err: error instanceof Error ? error.message : String(error),
            chunks,
            ...options.logContext,
        }, 'kokoro stream failed; caller may fall back to full WAV');
        if (sentAny) {
            (0, mediaWsBridge_1.sendMediaWsJson)(options.callControlId, (0, bidirectionalRtp_1.buildRtpMarkEvent)(`tts-stream-${(0, crypto_1.randomUUID)()}`));
            return { ok: true, chunks, firstAudioMs, durationMs, aborted: false };
        }
        return empty;
    }
}
//# sourceMappingURL=kokoroStreamPlay.js.map