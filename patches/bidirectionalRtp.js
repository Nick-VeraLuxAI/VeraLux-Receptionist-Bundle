"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.encodeL16PayloadBase64 = encodeL16PayloadBase64;
exports.buildRtpMediaEvent = buildRtpMediaEvent;
exports.buildRtpClearEvent = buildRtpClearEvent;
exports.buildRtpMarkEvent = buildRtpMarkEvent;
exports.wavToL16Pcm16k = wavToL16Pcm16k;
exports.localWavPathFromPublicUrl = localWavPathFromPublicUrl;
const path_1 = __importDefault(require("path"));
const codecDecode_1 = require("../audio/codecDecode");
const wavInfo_1 = require("../audio/wavInfo");
const env_1 = require("../env");
const log_1 = require("../log");
const streamCodec_1 = require("../telnyx/streamCodec");
/** Telnyx allows 20ms–30s chunks. Cap a single media event at 30s of 16 kHz mono L16. */
const MAX_CHUNK_MS = 30000;
const MAX_CHUNK_BYTES = (streamCodec_1.TELNYX_WS_BIDIRECTIONAL_SAMPLE_RATE * 2 * MAX_CHUNK_MS) / 1000;
/**
 * Telnyx WebSocket L16 is little-endian PCM16 (empirically), not RFC 3551 big-endian.
 * See team-telnyx/realtime-ai-demo L16 path.
 */
function encodeL16PayloadBase64(pcmLe) {
    return pcmLe.toString('base64');
}
function buildRtpMediaEvent(pcmLe) {
    return JSON.stringify({
        event: 'media',
        media: { payload: encodeL16PayloadBase64(pcmLe) },
    });
}
function buildRtpClearEvent() {
    return JSON.stringify({ event: 'clear' });
}
function buildRtpMarkEvent(name) {
    return JSON.stringify({
        event: 'mark',
        mark: { name },
    });
}
function wavToL16Pcm16k(wav) {
    const extracted = (0, wavInfo_1.extractWavPcmPayload)(wav);
    if (extracted.format.bitsPerSample !== 16) {
        throw new Error(`l16_tts_bits_${extracted.format.bitsPerSample}`);
    }
    if (extracted.format.channels !== 1) {
        throw new Error(`l16_tts_channels_${extracted.format.channels}`);
    }
    let pcm = extracted.pcm;
    if (pcm.length % 2 === 1) {
        pcm = pcm.subarray(0, pcm.length - 1);
    }
    const inputRate = extracted.format.sampleRateHz;
    if (inputRate !== streamCodec_1.TELNYX_WS_BIDIRECTIONAL_SAMPLE_RATE) {
        const samples = new Int16Array(pcm.length / 2);
        for (let i = 0; i < samples.length; i += 1) {
            samples[i] = pcm.readInt16LE(i * 2);
        }
        const resampled = (0, codecDecode_1.resamplePcm16)(samples, inputRate, streamCodec_1.TELNYX_WS_BIDIRECTIONAL_SAMPLE_RATE);
        const out = Buffer.alloc(resampled.length * 2);
        for (let i = 0; i < resampled.length; i += 1) {
            out.writeInt16LE(resampled[i] ?? 0, i * 2);
        }
        log_1.log.info({
            event: 'tts_l16_resampled',
            from_hz: inputRate,
            to_hz: streamCodec_1.TELNYX_WS_BIDIRECTIONAL_SAMPLE_RATE,
            in_samples: samples.length,
            out_samples: resampled.length,
        }, 'TTS WAV resampled to L16 16 kHz');
        pcm = out;
    }
    if (pcm.length > MAX_CHUNK_BYTES) {
        log_1.log.warn({
            event: 'tts_l16_truncated',
            bytes: pcm.length,
            max_bytes: MAX_CHUNK_BYTES,
        }, 'TTS L16 longer than Telnyx 30s RTP chunk; truncating');
        pcm = pcm.subarray(0, MAX_CHUNK_BYTES - (MAX_CHUNK_BYTES % 2));
    }
    return pcm;
}
function localWavPathFromPublicUrl(audioUrl) {
    try {
        const fileName = path_1.default.basename(new URL(audioUrl).pathname);
        if (!fileName || fileName === '.' || fileName === '..')
            return null;
        return path_1.default.join(env_1.env.AUDIO_STORAGE_DIR, fileName);
    }
    catch {
        return null;
    }
}
//# sourceMappingURL=bidirectionalRtp.js.map