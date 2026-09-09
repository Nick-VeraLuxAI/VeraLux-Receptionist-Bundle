"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TELNYX_WS_BIDIRECTIONAL_SAMPLE_RATE = exports.TELNYX_WS_BIDIRECTIONAL_CODEC = exports.TELNYX_WS_BIDIRECTIONAL_MODE = exports.TELNYX_WS_STREAM_CODEC = void 0;
exports.isL16Codec = isL16Codec;
exports.buildTelnyxStreamingStartBody = buildTelnyxStreamingStartBody;
/**
 * WebSocket media-stream codec (Telnyx fork), not SIP/PSTN negotiation.
 * SIP inbound codecs stay on TELNYX_ACCEPT_CODECS.
 */
exports.TELNYX_WS_STREAM_CODEC = 'L16';
exports.TELNYX_WS_BIDIRECTIONAL_MODE = 'rtp';
exports.TELNYX_WS_BIDIRECTIONAL_CODEC = 'L16';
exports.TELNYX_WS_BIDIRECTIONAL_SAMPLE_RATE = 16000;
function isL16Codec(codec) {
    if (!codec)
        return false;
    const n = codec.trim().toUpperCase().replace(/[.\-]/g, '_');
    return (n === 'L16' ||
        n === 'LINEAR16' ||
        n === 'PCM16' ||
        n === 'PCM16LE' ||
        n === 'PCM_16' ||
        n === 'PCM_S16LE' ||
        n === 'S16LE' ||
        n === 'LINEAR_PCM');
}
function buildTelnyxStreamingStartBody(options) {
    return {
        stream_url: options.streamUrl,
        stream_track: options.streamTrack,
        stream_codec: exports.TELNYX_WS_STREAM_CODEC,
        stream_bidirectional_mode: exports.TELNYX_WS_BIDIRECTIONAL_MODE,
        stream_bidirectional_codec: exports.TELNYX_WS_BIDIRECTIONAL_CODEC,
        stream_bidirectional_sampling_rate: exports.TELNYX_WS_BIDIRECTIONAL_SAMPLE_RATE,
    };
}
//# sourceMappingURL=streamCodec.js.map