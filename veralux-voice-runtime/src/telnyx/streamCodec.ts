/**
 * WebSocket media-stream codec (Telnyx fork), not SIP/PSTN negotiation.
 * SIP inbound codecs stay on TELNYX_ACCEPT_CODECS.
 */
export const TELNYX_WS_STREAM_CODEC = 'L16';
export const TELNYX_WS_BIDIRECTIONAL_MODE = 'rtp';
export const TELNYX_WS_BIDIRECTIONAL_CODEC = 'L16';
export const TELNYX_WS_BIDIRECTIONAL_SAMPLE_RATE = 16000;

export function isL16Codec(codec: string | undefined | null): boolean {
  if (!codec) return false;
  const n = codec.trim().toUpperCase().replace(/[.\-]/g, '_');
  return (
    n === 'L16' ||
    n === 'LINEAR16' ||
    n === 'PCM16' ||
    n === 'PCM16LE' ||
    n === 'PCM_16' ||
    n === 'PCM_S16LE' ||
    n === 'S16LE' ||
    n === 'LINEAR_PCM'
  );
}

export function buildTelnyxStreamingStartBody(options: {
  streamUrl: string;
  streamTrack: string;
}): Record<string, unknown> {
  return {
    stream_url: options.streamUrl,
    stream_track: options.streamTrack,
    stream_codec: TELNYX_WS_STREAM_CODEC,
    stream_bidirectional_mode: TELNYX_WS_BIDIRECTIONAL_MODE,
    stream_bidirectional_codec: TELNYX_WS_BIDIRECTIONAL_CODEC,
    stream_bidirectional_sampling_rate: TELNYX_WS_BIDIRECTIONAL_SAMPLE_RATE,
  };
}
