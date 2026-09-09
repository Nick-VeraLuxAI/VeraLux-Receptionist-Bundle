"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.env = void 0;
exports.preprocessHealthVoiceDependencies = preprocessHealthVoiceDependencies;
// src/env.ts
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const dotenv_1 = __importDefault(require("dotenv"));
const zod_1 = require("zod");
/**
 * Single env file per process. Default `.env`.
 * Local dev: `npm run dev` sets `VERALUX_DOTENV=.env.development` (see package.json).
 */
const dotenvPath = process.env.VERALUX_DOTENV?.trim() || '.env';
const dotenvResolved = path_1.default.resolve(process.cwd(), dotenvPath);
if (dotenvPath === '.env.development' && !fs_1.default.existsSync(dotenvResolved)) {
    throw new Error('Missing .env.development. Create it from your production voice env file:\n' +
        '  npm run init:dev-env -w veralux-voice-runtime -- /etc/veralux/voice-runtime.env');
}
// When loading `.env.development`, replace existing process.env keys so a stale
// shell (e.g. AUDIO_STORAGE_DIR=/app/audio from Docker) cannot mask file values.
const dotenvOverride = dotenvPath === '.env.development';
dotenv_1.default.config({ path: dotenvResolved, override: dotenvOverride });
// `tsx --test` does not set NODE_ENV=test; readiness scripts set VERALUX_TEST_HOST_PATHS=1 so a
// Docker-oriented `.env` (paths under /app/...) still mkdirs under /tmp on the host.
if (process.env.VERALUX_TEST_HOST_PATHS === '1' || process.env.NODE_ENV === 'test') {
    const tmpRoot = '/tmp/veralux-runtime-test';
    const mapIfApp = (key, leaf) => {
        const v = process.env[key];
        if (v && v.startsWith('/app/')) {
            process.env[key] = `${tmpRoot}/${leaf}`;
        }
    };
    mapIfApp('STT_DEBUG_DIR', 'stt-debug');
    mapIfApp('AMRWB_DEBUG_DIR', 'amrwb-debug');
    mapIfApp('CALL_TRANSCRIPT_DIR', 'call-transcripts');
    if (process.env.AUDIO_STORAGE_DIR?.startsWith('/app/')) {
        process.env.AUDIO_STORAGE_DIR = `${tmpRoot}/audio`;
    }
}
// ───────────────────────── helpers ─────────────────────────
const emptyToUndefined = (value) => {
    if (typeof value === 'string' && value.trim() === '')
        return undefined;
    return value;
};
const stringToBoolean = (value) => {
    if (typeof value === 'string') {
        const normalized = value.trim().toLowerCase();
        if (normalized === '')
            return undefined;
        if (normalized === 'true')
            return true;
        if (normalized === 'false')
            return false;
    }
    return value;
};
/** Exported for unit tests (`tests/healthVoiceDependencyMode.test.ts`). */
function preprocessHealthVoiceDependencies(value) {
    if (value === undefined || value === null)
        return 'strict';
    if (typeof value === 'boolean')
        return value ? 'strict' : 'disabled';
    if (typeof value === 'string') {
        const s = value.trim().toLowerCase();
        if (s === '')
            return 'strict';
        if (s === '1' || s === 'true' || s === 'yes' || s === 'on')
            return 'strict';
        if (s === '0' || s === 'false' || s === 'no' || s === 'off')
            return 'disabled';
        if (s === 'strict' || s === 'configured' || s === 'disabled')
            return s;
    }
    return 'strict';
}
const numberFromEnv = (value) => {
    // prevent z.coerce.number from treating booleans as 1/0
    if (typeof value === 'boolean')
        return NaN;
    if (typeof value === 'string') {
        const trimmed = value.trim();
        if (trimmed === '')
            return undefined;
        // prevent 'true'/'false' from becoming NaN later in confusing ways
        const normalized = trimmed.toLowerCase();
        if (normalized === 'true' || normalized === 'false')
            return NaN;
        return trimmed; // allow z.coerce.number to do the conversion
    }
    return value;
};
// Back-compat: STT_RMS_THRESHOLD → STT_SPEECH_RMS_FLOOR
const sttRmsFloorFallback = (value) => {
    const normalized = emptyToUndefined(value);
    if (normalized !== undefined)
        return normalized;
    return emptyToUndefined(process.env.STT_RMS_THRESHOLD);
};
// ✅ Back-compat / aliasing for frames-required
// Prefer the actual knob: STT_SPEECH_FRAMES_REQUIRED
// Allow legacy: STT_FRAMES_REQUIRED
const sttFramesRequiredFallback = (value) => {
    const normalized = numberFromEnv(value);
    if (normalized !== undefined)
        return normalized;
    const fromSpeech = numberFromEnv(process.env.STT_SPEECH_FRAMES_REQUIRED);
    if (fromSpeech !== undefined)
        return fromSpeech;
    return numberFromEnv(process.env.STT_FRAMES_REQUIRED);
};
// ✅ Make STT_SILENCE_END_MS default to STT_SILENCE_MS when not set
// (So your CLI `STT_SILENCE_MS=900` actually drives endpointing if END_MS is missing.)
const sttSilenceEndFallback = (value) => {
    const normalized = numberFromEnv(value);
    if (normalized !== undefined)
        return normalized;
    const fromEnd = numberFromEnv(process.env.STT_SILENCE_END_MS);
    if (fromEnd !== undefined)
        return fromEnd;
    return numberFromEnv(process.env.STT_SILENCE_MS);
};
// Back-compat: KOKORO_SAMPLE_RATE → TTS_SAMPLE_RATE
const ttsSampleRateFallback = (value) => {
    const normalized = emptyToUndefined(value);
    if (normalized !== undefined)
        return normalized;
    return emptyToUndefined(process.env.KOKORO_SAMPLE_RATE);
};
// ───────────────────────── schema ─────────────────────────
const EnvSchema = zod_1.z.object({
    /* ───────────────────────── Core ───────────────────────── */
    PORT: zod_1.z.coerce.number().int().positive(),
    NODE_ENV: zod_1.z.preprocess(emptyToUndefined, zod_1.z.string().default('development')),
    TRANSPORT_MODE: zod_1.z.preprocess(emptyToUndefined, zod_1.z.enum(['pstn', 'webrtc_hd']).default('pstn')),
    WEBRTC_PORT: zod_1.z.preprocess(emptyToUndefined, zod_1.z.coerce.number().int().positive().optional()),
    WEBRTC_ALLOWED_ORIGINS: zod_1.z.preprocess(emptyToUndefined, zod_1.z.string().optional()),
    AUDIO_DIAGNOSTICS: zod_1.z.preprocess(stringToBoolean, zod_1.z.boolean().default(false)),
    ALLOW_PROD_DEBUG_CAPTURE: zod_1.z.preprocess(stringToBoolean, zod_1.z.boolean().default(false)),
    /**
     * Voice dependency checks for `/health/voice`, `/health/ready`, and `/health`.
     * - strict (default): legacy behavior — HTTP GET derived `/health` for STT/TTS (and optional brain).
     * - configured: require env/contract presence only; optional explicit `*_HEALTH_URL` probes when set.
     * - disabled: Redis-only for readiness-style gates (legacy `HEALTH_VOICE_DEPENDENCIES=false`).
     */
    HEALTH_VOICE_DEPENDENCIES: zod_1.z.preprocess(preprocessHealthVoiceDependencies, zod_1.z.enum(['strict', 'configured', 'disabled']).default('strict')),
    /** Optional operator hint for observability (does not change call logic). */
    DEPLOYMENT_PROFILE: zod_1.z.preprocess(emptyToUndefined, zod_1.z.enum(['local-gpu', 'cloud-api', 'hybrid']).optional()),
    /** When set in strict mode, probe this URL instead of deriving `/health` from `WHISPER_URL`. */
    STT_HEALTH_URL: zod_1.z.preprocess(emptyToUndefined, zod_1.z.string().url().optional()),
    /** When set in strict mode, probe this URL instead of deriving TTS `/health` from mode URLs. */
    TTS_HEALTH_URL: zod_1.z.preprocess(emptyToUndefined, zod_1.z.string().url().optional()),
    /**
     * When set in strict mode, probe this URL instead of deriving brain `/health` from `BRAIN_URL`.
     * When `BRAIN_HEALTH_REQUIRED=true`, strict mode probes `LLM_HEALTH_URL` if set, else derived brain `/health`.
     */
    LLM_HEALTH_URL: zod_1.z.preprocess(emptyToUndefined, zod_1.z.string().url().optional()),
    /* ───────────────────────── Telnyx ───────────────────────── */
    TELNYX_API_KEY: zod_1.z.string().min(1),
    TELNYX_PUBLIC_KEY: zod_1.z.string().min(1),
    TELNYX_STREAM_TRACK: zod_1.z.enum(['inbound_track', 'outbound_track', 'both_tracks']).default('inbound_track'),
    /** WebSocket fork codec only. SIP/PSTN negotiation uses TELNYX_ACCEPT_CODECS. */
    TELNYX_STREAM_CODEC: zod_1.z.preprocess(emptyToUndefined, zod_1.z.string().default('L16')),
    TELNYX_STREAM_BIDIRECTIONAL_MODE: zod_1.z.enum(['rtp', 'mp3']).default('rtp'),
    TELNYX_STREAM_BIDIRECTIONAL_CODEC: zod_1.z.preprocess(emptyToUndefined, zod_1.z.string().default('L16')),
    TELNYX_STREAM_BIDIRECTIONAL_SAMPLING_RATE: zod_1.z.preprocess(emptyToUndefined, zod_1.z.coerce.number().int().positive().default(16000)),
    TELNYX_SKIP_SIGNATURE: zod_1.z.preprocess(stringToBoolean, zod_1.z.boolean().default(false)),
    TELNYX_SIGNATURE_MAX_SKEW_SECONDS: zod_1.z.preprocess(emptyToUndefined, zod_1.z.coerce.number().int().positive().max(3600).default(300)),
    TELNYX_SIGNATURE_REPLAY_TTL_SECONDS: zod_1.z.preprocess(emptyToUndefined, zod_1.z.coerce.number().int().positive().max(86400).default(600)),
    TELNYX_WEBHOOK_IDEMPOTENCY_TTL_SECONDS: zod_1.z.preprocess(emptyToUndefined, zod_1.z.coerce.number().int().positive().max(86400).default(3600)),
    TELNYX_WEBHOOK_REPLAY_PREFIX: zod_1.z.preprocess(emptyToUndefined, zod_1.z.string().default('telnyxreplay')),
    TELNYX_ACCEPT_CODECS: zod_1.z.preprocess(emptyToUndefined, zod_1.z.string().default('PCMU')),
    TELNYX_STREAM_RESTART_MAX: zod_1.z.preprocess(emptyToUndefined, zod_1.z.coerce.number().int().nonnegative().default(1)),
    TELNYX_INGEST_HEALTH_GRACE_MS: zod_1.z.preprocess(emptyToUndefined, zod_1.z.coerce.number().int().nonnegative().default(1200)),
    TELNYX_INGEST_HEALTH_ENABLED: zod_1.z.preprocess(stringToBoolean, zod_1.z.boolean().default(true)),
    TELNYX_INGEST_HEALTH_RESTART_ENABLED: zod_1.z.preprocess(stringToBoolean, zod_1.z.boolean().default(true)),
    TELNYX_INGEST_POST_PLAYBACK_GRACE_MS: zod_1.z.preprocess(emptyToUndefined, zod_1.z.coerce.number().int().nonnegative().default(1200)),
    TELNYX_INGEST_MIN_AUDIO_MS_SINCE_PLAYBACK_END: zod_1.z.preprocess(emptyToUndefined, zod_1.z.coerce.number().int().nonnegative().default(2000)),
    TELNYX_AMRWB_MIN_DECODED_BYTES: zod_1.z.preprocess(emptyToUndefined, zod_1.z.coerce.number().int().positive().default(320)),
    TELNYX_INGEST_DECODE_FAILURES_BEFORE_FALLBACK: zod_1.z.preprocess(emptyToUndefined, zod_1.z.coerce.number().int().positive().default(3)),
    TELNYX_TARGET_SAMPLE_RATE: zod_1.z.preprocess(emptyToUndefined, zod_1.z.coerce.number().int().positive().default(16000)),
    TELNYX_OPUS_DECODE: zod_1.z.preprocess(stringToBoolean, zod_1.z.boolean().default(false)),
    TELNYX_G722_DECODE: zod_1.z.preprocess(stringToBoolean, zod_1.z.boolean().default(false)),
    TELNYX_AMRWB_DECODE: zod_1.z.preprocess(stringToBoolean, zod_1.z.boolean().default(false)),
    PUBLIC_BASE_URL: zod_1.z.string().min(1),
    AUDIO_PUBLIC_BASE_URL: zod_1.z.string().min(1),
    /* ───────────────────────── Media / Storage ───────────────────────── */
    MEDIA_STREAM_TOKEN: zod_1.z.string().min(1),
    AUDIO_STORAGE_DIR: zod_1.z.string().min(1),
    /* ───────────────────────── STT (Whisper) ───────────────────────── */
    WHISPER_URL: zod_1.z.preprocess(emptyToUndefined, zod_1.z.string().min(1).optional()).default('http://127.0.0.1:9000/transcribe'),
    DEEPGRAM_API_KEY: zod_1.z.preprocess(emptyToUndefined, zod_1.z.string().min(1).optional()),
    /** Language hint for Whisper (e.g. "en"). Improves accuracy when set. */
    STT_LANGUAGE: zod_1.z.preprocess(emptyToUndefined, zod_1.z.string().min(1).optional()),
    /** Optional text to bias Whisper decoding (e.g. "What time do you close. When do you close."). Sent as query param if your server supports it. */
    STT_WHISPER_PROMPT: zod_1.z.preprocess(emptyToUndefined, zod_1.z.string().min(1).optional()),
    ALLOW_HTTP_WAV_JSON: zod_1.z.preprocess(stringToBoolean, zod_1.z.boolean().default(false)),
    STT_CHUNK_MS: zod_1.z.coerce.number().int().positive(),
    STT_SILENCE_MS: zod_1.z.coerce.number().int().positive(),
    STT_MIN_SECONDS: zod_1.z.preprocess(emptyToUndefined, zod_1.z.coerce.number().positive().default(0.6)),
    STT_SILENCE_MIN_SECONDS: zod_1.z.preprocess(emptyToUndefined, zod_1.z.coerce.number().positive().default(0.45)),
    /* Endpointing + gating (used by chunkedSTT.ts) */
    // ✅ default to STT_SILENCE_MS via preprocess fallback
    STT_SILENCE_END_MS: zod_1.z.preprocess(sttSilenceEndFallback, zod_1.z.coerce.number().int().positive().default(700)),
    STT_PRE_ROLL_MS: zod_1.z.preprocess(emptyToUndefined, zod_1.z.coerce.number().int().positive().default(1200)),
    STT_MIN_UTTERANCE_MS: zod_1.z.preprocess(emptyToUndefined, zod_1.z.coerce.number().int().positive().default(400)),
    STT_MAX_UTTERANCE_MS: zod_1.z.preprocess(emptyToUndefined, zod_1.z.coerce.number().int().positive().default(6000)),
    /* Final utterance trimming */
    FINAL_TAIL_CUSHION_MS: zod_1.z.preprocess(emptyToUndefined, zod_1.z.coerce.number().int().positive().default(120)),
    FINAL_MIN_SECONDS: zod_1.z.preprocess(emptyToUndefined, zod_1.z.coerce.number().positive().default(1.0)),
    FINAL_MIN_BYTES: zod_1.z.preprocess(emptyToUndefined, zod_1.z.coerce.number().int().positive().optional()),
    /* Speech detection thresholds */
    STT_RMS_FLOOR: zod_1.z.preprocess(emptyToUndefined, zod_1.z.coerce.number().positive().default(0.015)),
    STT_PEAK_FLOOR: zod_1.z.preprocess(emptyToUndefined, zod_1.z.coerce.number().positive().default(0.05)),
    STT_DISABLE_GATES: zod_1.z.preprocess(stringToBoolean, zod_1.z.boolean().default(false)),
    STT_SPEECH_RMS_FLOOR: zod_1.z.preprocess(sttRmsFloorFallback, zod_1.z.coerce.number().positive().default(0.03)),
    STT_SPEECH_PEAK_FLOOR: zod_1.z.preprocess(emptyToUndefined, zod_1.z.coerce.number().positive().default(0.05)),
    STT_SPEECH_FRAMES_REQUIRED: zod_1.z.preprocess(sttFramesRequiredFallback, zod_1.z.coerce.number().int().positive().optional()),
    /* Partial transcription */
    STT_PARTIAL_INTERVAL_MS: zod_1.z.preprocess(emptyToUndefined, zod_1.z.coerce.number().int().positive().default(250)),
    STT_PARTIAL_MIN_MS: zod_1.z.preprocess(emptyToUndefined, zod_1.z.coerce.number().int().positive().default(600)),
    /** Max chars for transcript_preview fields in JSON logs (callSession + Whisper). Raise for local debugging. */
    STT_TRANSCRIPT_LOG_MAX_CHARS: zod_1.z.preprocess(emptyToUndefined, zod_1.z.coerce.number().int().min(40).max(32000).default(160)),
    /* STT input DSP */
    STT_HIGHPASS_ENABLED: zod_1.z.preprocess(stringToBoolean, zod_1.z.boolean().default(true)),
    STT_HIGHPASS_CUTOFF_HZ: zod_1.z.preprocess(emptyToUndefined, zod_1.z.coerce.number().int().positive().default(100)),
    /* Tier 2: measured listen-after-playback grace (300–900ms based on segment length) */
    STT_POST_PLAYBACK_GRACE_MS: zod_1.z.preprocess(emptyToUndefined, zod_1.z.coerce.number().int().positive().optional()),
    STT_POST_PLAYBACK_GRACE_MIN_MS: zod_1.z.preprocess(emptyToUndefined, zod_1.z.coerce.number().int().positive().default(300)),
    STT_POST_PLAYBACK_GRACE_MAX_MS: zod_1.z.preprocess(emptyToUndefined, zod_1.z.coerce.number().int().positive().default(900)),
    /* STT debug dumps */
    STT_DEBUG_DUMP_WHISPER_WAVS: zod_1.z.preprocess(stringToBoolean, zod_1.z.boolean().default(false)),
    STT_DEBUG_DUMP_PCM16: zod_1.z.preprocess(stringToBoolean, zod_1.z.boolean().default(false)),
    STT_DEBUG_DUMP_RX_WAV: zod_1.z.preprocess(stringToBoolean, zod_1.z.boolean().default(false)),
    STT_DEBUG_DUMP_FAR_END_REF: zod_1.z.preprocess(stringToBoolean, zod_1.z.boolean().default(false)),
    /** When true, write stereo WAV L=near / R=AEC output (20 ms aligned) on call end under STT_DEBUG_DIR. */
    STT_DEBUG_AEC_NEAR_OUT_WAV: zod_1.z.preprocess(stringToBoolean, zod_1.z.boolean().default(false)),
    /** Max duration retained for AEC near/out tap ring buffer (ms). Older frames dropped. */
    STT_DEBUG_AEC_TAP_MAX_MS: zod_1.z.preprocess(emptyToUndefined, zod_1.z.coerce.number().int().positive().max(120000).default(8000)),
    /** Periodic JSON snapshot of STT pipeline (levels, gates, dedupe, timing). 0 = off. Typical: 2000–3000. */
    STT_PIPELINE_DIAG_INTERVAL_MS: zod_1.z.preprocess(emptyToUndefined, zod_1.z.coerce.number().int().min(0).default(0)),
    /** Log full pipeline snapshot when assistant playback starts/ends (recommended). */
    STT_PIPELINE_DIAG_ON_PLAYBACK: zod_1.z.preprocess(stringToBoolean, zod_1.z.boolean().default(true)),
    /**
     * Attenuate inbound PCM before AEC/STT (negative dB only; 0 = off).
     * Reduces near-full-scale PSTN/codec peaks that confuse Whisper and exaggerate clicks.
     */
    STT_RX_HEADROOM_DB: zod_1.z.preprocess(emptyToUndefined, zod_1.z.coerce.number().min(-24).max(0).default(0)),
    /* Tier 4: SpeexDSP AEC (requires libspeexdsp: brew install speex / apt install libspeexdsp-dev) */
    STT_AEC_ENABLED: zod_1.z.preprocess(stringToBoolean, zod_1.z.boolean().default(true)),
    /* Tier 5: Auto-calibration (noise floor + adaptive thresholds) */
    STT_NOISE_FLOOR_ENABLED: zod_1.z.preprocess(stringToBoolean, zod_1.z.boolean().default(true)),
    STT_NOISE_FLOOR_ALPHA: zod_1.z.preprocess(emptyToUndefined, zod_1.z.coerce.number().positive().max(1).default(0.05)),
    STT_NOISE_FLOOR_MIN_SAMPLES: zod_1.z.preprocess(emptyToUndefined, zod_1.z.coerce.number().int().positive().default(30)),
    STT_ADAPTIVE_RMS_MULTIPLIER: zod_1.z.preprocess(emptyToUndefined, zod_1.z.coerce.number().positive().default(2.0)),
    STT_ADAPTIVE_PEAK_MULTIPLIER: zod_1.z.preprocess(emptyToUndefined, zod_1.z.coerce.number().positive().default(2.5)),
    STT_ADAPTIVE_FLOOR_MIN_RMS: zod_1.z.preprocess(emptyToUndefined, zod_1.z.coerce.number().positive().default(0.01)),
    STT_ADAPTIVE_FLOOR_MIN_PEAK: zod_1.z.preprocess(emptyToUndefined, zod_1.z.coerce.number().positive().default(0.03)),
    /* Tier 5: Late-final watchdog (force final if speech but no final in X sec) */
    STT_LATE_FINAL_WATCHDOG_ENABLED: zod_1.z.preprocess(stringToBoolean, zod_1.z.boolean().default(true)),
    STT_LATE_FINAL_WATCHDOG_MS: zod_1.z.preprocess(emptyToUndefined, zod_1.z.coerce.number().int().positive().default(8000)),
    /** Optional grace ms before late-final watchdog fires (read by callSession when set). */
    STT_LATE_FINAL_GRACE_MS: zod_1.z.preprocess(emptyToUndefined, zod_1.z.coerce.number().int().positive().optional()),
    /* Dead air protection */
    DEAD_AIR_MS: zod_1.z.coerce.number().int().positive(),
    DEAD_AIR_NO_FRAMES_MS: zod_1.z.preprocess(emptyToUndefined, zod_1.z.coerce.number().int().positive().default(1500)),
    /**
     * If inbound audio recently showed gate-level energy (RMS/peak) or STT classified speech but
     * Whisper never ran, defer “Are you still there?” reprompts for this many ms.
     */
    DEAD_AIR_DEFER_RECENT_STT_SIGNAL_MS: zod_1.z.preprocess(emptyToUndefined, zod_1.z.coerce.number().int().positive().default(4000)),
    /** When STT returns empty/noise or errors (after retries), play a TTS reprompt instead of staying silent. */
    STT_UNCLEAR_REPROMPT_ENABLED: zod_1.z.preprocess(stringToBoolean, zod_1.z.boolean().default(true)),
    /** Extra Whisper attempts after an empty final (same audio). Default 1 = one retry. */
    STT_EMPTY_FINAL_EXTRA_TRIES: zod_1.z.preprocess(emptyToUndefined, zod_1.z.coerce.number().int().min(0).max(4).default(1)),
    /** Extra attempts after retryable HTTP/network STT errors. */
    STT_FINAL_ERROR_EXTRA_TRIES: zod_1.z.preprocess(emptyToUndefined, zod_1.z.coerce.number().int().min(0).max(4).default(1)),
    /** Pause between STT retries (ms). */
    STT_FINAL_RETRY_BACKOFF_MS: zod_1.z.preprocess(emptyToUndefined, zod_1.z.coerce.number().int().min(0).max(2000).default(180)),
    /** Max unclear reprompts per call (empty / error / filler); 0 = unlimited (not recommended). */
    STT_UNCLEAR_REPROMPT_MAX_PER_CALL: zod_1.z.preprocess(emptyToUndefined, zod_1.z.coerce.number().int().min(0).max(30).default(8)),
    /** Minimum ms between unclear reprompts (anti-spam). */
    STT_UNCLEAR_REPROMPT_COOLDOWN_MS: zod_1.z.preprocess(emptyToUndefined, zod_1.z.coerce.number().int().min(0).max(120000).default(2200)),
    /** Pipe-separated TTS lines; default built-in phrases if unset. */
    STT_UNCLEAR_REPROMPT_PHRASES: zod_1.z.preprocess(emptyToUndefined, zod_1.z.string().optional()),
    /**
     * If > 0, transcripts with fewer than this many letters (A–Z) are treated as unclear.
     * Default 0 = disabled (avoids rejecting valid short answers like “no”).
     */
    STT_UNCLEAR_MIN_LETTERS: zod_1.z.preprocess(emptyToUndefined, zod_1.z.coerce.number().int().min(0).max(20).default(0)),
    /** Suppress a final transcript if it closely matches the previous final within a short window (double STT finals). */
    STT_TRANSCRIPT_DEDUPE_ENABLED: zod_1.z.preprocess(stringToBoolean, zod_1.z.boolean().default(true)),
    STT_TRANSCRIPT_DEDUPE_WINDOW_MS: zod_1.z.preprocess(emptyToUndefined, zod_1.z.coerce.number().int().min(500).max(30000).default(2200)),
    STT_TRANSCRIPT_DEDUPE_SIMILARITY: zod_1.z.preprocess(emptyToUndefined, zod_1.z.coerce.number().min(0.5).max(1).default(0.9)),
    /** Log + metrics when Telnyx sequence jumps by at least this many missing indices. */
    MEDIA_SEQ_GAP_LOG_MIN: zod_1.z.preprocess(emptyToUndefined, zod_1.z.coerce.number().int().min(1).max(100).default(3)),
    /** Reuse TCP connections to Whisper (lower tail latency). */
    WHISPER_HTTP_KEEPALIVE: zod_1.z.preprocess(stringToBoolean, zod_1.z.boolean().default(true)),
    WHISPER_HTTP_MAX_CONNECTIONS: zod_1.z.preprocess(emptyToUndefined, zod_1.z.coerce.number().int().min(1).max(64).default(8)),
    /* STT debug dir (optional); when set, runtime ensures it exists at startup */
    STT_DEBUG_DIR: zod_1.z.preprocess(emptyToUndefined, zod_1.z.string().min(1).optional()),
    /** Optional separate dir for AMR-WB debug artifacts (defaults to STT_DEBUG_DIR when unset). */
    AMRWB_DEBUG_DIR: zod_1.z.preprocess(emptyToUndefined, zod_1.z.string().min(1).optional()),
    /** Linear fade (samples @ decode rate) when AMR-WB PCM is zero-padded to nominal frame length. 0 = hard pad (legacy). */
    STT_AMRWB_PAD_FADE_SAMPLES: zod_1.z.preprocess(emptyToUndefined, zod_1.z.coerce.number().int().min(0).max(512).default(32)),
    /** Crossfade length when joining pending decoded PCM with the next decode batch (0 = off). */
    STT_INGEST_DECODE_JOIN_CROSSFADE_SAMPLES: zod_1.z.preprocess(emptyToUndefined, zod_1.z.coerce.number().int().min(0).max(160).default(24)),
    /** Only apply decode-join crossfade when |Δ int16| between last pending and first new sample exceeds this. */
    STT_INGEST_DECODE_JOIN_MIN_DELTA_INT16: zod_1.z.preprocess(emptyToUndefined, zod_1.z.coerce.number().int().min(0).max(32000).default(2500)),
    /* ───────────────────────── TTS ───────────────────────── */
    /** TTS backend when no tenant tts config is set. */
    TTS_MODE: zod_1.z.preprocess(emptyToUndefined, zod_1.z.enum(['kokoro_http', 'coqui_xtts', 'chatterbox_http', 'qwen3_tts_http', 'miso_tts_http', 'magpie_tts_http', 'melo_tts_http', 'openai_tts', 'elevenlabs']).default('kokoro_http')),
    KOKORO_URL: zod_1.z.preprocess(emptyToUndefined, zod_1.z.string().min(1).optional()),
    /** Coqui XTTS API base URL (e.g. http://host:7002/tts). Required when TTS_MODE=coqui_xtts. */
    COQUI_XTTS_URL: zod_1.z.preprocess(emptyToUndefined, zod_1.z.string().min(1).optional()),
    /** Chatterbox HTTP TTS (Resemble). Required when TTS_MODE=chatterbox_http. */
    CHATTERBOX_URL: zod_1.z.preprocess(emptyToUndefined, zod_1.z.string().min(1).optional()),
    /** Qwen3-TTS HTTP (veralux-audio-stack/qwen3_tts_server.py). Required when TTS_MODE=qwen3_tts_http. */
    QWEN3_TTS_URL: zod_1.z.preprocess(emptyToUndefined, zod_1.z.string().min(1).optional()),
    /** Miso TTS 8B HTTP (veralux-audio-stack/miso_tts_server.py). Required when TTS_MODE=miso_tts_http. */
    MISO_TTS_URL: zod_1.z.preprocess(emptyToUndefined, zod_1.z.string().min(1).optional()),
    /** NVIDIA Magpie HTTP (veralux-audio-stack/magpie_tts_server.py). Required when TTS_MODE=magpie_tts_http. */
    MAGPIE_TTS_URL: zod_1.z.preprocess(emptyToUndefined, zod_1.z.string().min(1).optional()),
    MAGPIE_TTS_SPEAKER: zod_1.z.preprocess(emptyToUndefined, zod_1.z.string().min(1).optional()),
    MAGPIE_TTS_LANGUAGE: zod_1.z.preprocess(emptyToUndefined, zod_1.z.string().min(1).optional()),
    /** MeloTTS HTTP (veralux-audio-stack/melo_tts_server.py). Required when TTS_MODE=melo_tts_http. */
    MELO_TTS_URL: zod_1.z.preprocess(emptyToUndefined, zod_1.z.string().min(1).optional()),
    MELO_TTS_SPEAKER: zod_1.z.preprocess(emptyToUndefined, zod_1.z.string().min(1).optional()),
    MELO_TTS_LANGUAGE: zod_1.z.preprocess(emptyToUndefined, zod_1.z.string().min(1).optional()),
    /** Preset speaker id (e.g. Ryan). Matches Qwen3 CustomVoice presets. */
    QWEN3_TTS_SPEAKER: zod_1.z.preprocess(emptyToUndefined, zod_1.z.string().min(1).optional()),
    QWEN3_TTS_LANGUAGE: zod_1.z.preprocess(emptyToUndefined, zod_1.z.string().min(1).optional()),
    QWEN3_TTS_INSTRUCT: zod_1.z.preprocess(emptyToUndefined, zod_1.z.string().optional()),
    /** Miso speaker id (integer as string; default 0). */
    MISO_TTS_SPEAKER: zod_1.z.preprocess(emptyToUndefined, zod_1.z.string().min(1).optional()),
    MISO_TTS_MAX_AUDIO_LENGTH_MS: zod_1.z.preprocess(emptyToUndefined, zod_1.z.coerce.number().int().min(500).max(90000).optional()),
    MISO_TTS_TEMPERATURE: zod_1.z.preprocess(emptyToUndefined, zod_1.z.coerce.number().min(0).max(2).optional()),
    MISO_TTS_TOP_K: zod_1.z.preprocess(emptyToUndefined, zod_1.z.coerce.number().int().min(1).max(1000).optional()),
    /** Must match the Chatterbox server CHATTERBOX_VARIANT. */
    CHATTERBOX_VARIANT: zod_1.z.preprocess(emptyToUndefined, zod_1.z.enum(['turbo', 'standard', 'multilingual']).default('turbo')),
    /** Optional label stored in tenant-style config; Chatterbox uses speaker WAV for voice, not this id. */
    CHATTERBOX_VOICE_ID: zod_1.z.preprocess(emptyToUndefined, zod_1.z.string().min(1).optional()),
    /** Default language_id for Chatterbox-Multilingual (e.g. en, fr). */
    CHATTERBOX_LANGUAGE: zod_1.z.preprocess(emptyToUndefined, zod_1.z.string().min(1).optional()),
    /**
     * When true (and CHATTERBOX_VARIANT=turbo), runtime calls POST .../tts/stream and merges segment WAVs.
     * Improves server-side chunking for long replies; short lines are one segment.
     */
    CHATTERBOX_STREAMING: zod_1.z.preprocess(stringToBoolean, zod_1.z.boolean().default(false)),
    /**
     * When true, Demo Shop playTtsSegment uses POST .../tts/stream and plays the first
     * sentence WAV without waiting for the rest. Default true (also readable via process.env
     * in qwen3Tts so live env.js does not have to be remounted).
     */
    QWEN3_TTS_STREAMING: zod_1.z.preprocess(stringToBoolean, zod_1.z.boolean().default(true)),
    /** Coqui XTTS voice_id (e.g. "en_sample"). Default "en_sample" when unset; not Kokoro preset names. */
    COQUI_VOICE_ID: zod_1.z.preprocess(emptyToUndefined, zod_1.z.string().min(1).optional()),
    /** When true, omit voice_id/speaker in Coqui requests (for single-speaker XTTS models). Default false. */
    COQUI_SINGLE_SPEAKER: zod_1.z.preprocess(stringToBoolean, zod_1.z.boolean().default(false)),
    /** XTTS v2 tuning (optional). Sent to your Coqui server if set. */
    COQUI_TEMPERATURE: zod_1.z.preprocess(emptyToUndefined, zod_1.z.coerce.number().min(0).optional()),
    COQUI_LENGTH_PENALTY: zod_1.z.preprocess(emptyToUndefined, zod_1.z.coerce.number().optional()),
    COQUI_REPETITION_PENALTY: zod_1.z.preprocess(emptyToUndefined, zod_1.z.coerce.number().optional()),
    COQUI_TOP_K: zod_1.z.preprocess(emptyToUndefined, zod_1.z.coerce.number().int().min(0).optional()),
    COQUI_TOP_P: zod_1.z.preprocess(emptyToUndefined, zod_1.z.coerce.number().min(0).max(1).optional()),
    COQUI_SPEED: zod_1.z.preprocess(emptyToUndefined, zod_1.z.coerce.number().positive().optional()),
    COQUI_SPLIT_SENTENCES: zod_1.z.preprocess(stringToBoolean, zod_1.z.boolean().optional()),
    /** Greeting text used to generate greeting.wav at startup and for live-TTS fallback. Default: "Hi! Thanks for calling. How can I help you today?" */
    GREETING_TEXT: zod_1.z.preprocess(emptyToUndefined, zod_1.z.string().min(1).optional()),
    KOKORO_VOICE_ID: zod_1.z.preprocess(emptyToUndefined, zod_1.z.string().min(1).optional()),
    /** Kokoro speaking speed (0.5–1.5); forwarded as JSON `rate`. */
    KOKORO_RATE: zod_1.z.preprocess(emptyToUndefined, zod_1.z.coerce.number().min(0.5).max(1.5).optional()),
    TTS_SAMPLE_RATE: zod_1.z.preprocess(ttsSampleRateFallback, zod_1.z.coerce.number().int().positive().default(8000)),
    /** When true, LRU + optional Redis cache TTS audio by synthesis parameters (reduces TTS compute). */
    TTS_CACHE_ENABLED: zod_1.z.preprocess(stringToBoolean, zod_1.z.boolean().default(true)),
    /** In-process LRU for hot phrases (per runtime instance). */
    TTS_CACHE_LRU_ENABLED: zod_1.z.preprocess(stringToBoolean, zod_1.z.boolean().default(true)),
    TTS_CACHE_LRU_MAX_ENTRIES: zod_1.z.preprocess(emptyToUndefined, zod_1.z.coerce.number().int().positive().default(256)),
    TTS_CACHE_LRU_MAX_BYTES: zod_1.z.preprocess(emptyToUndefined, zod_1.z.coerce.number().int().positive().default(33554432)),
    /** Share cached WAV across runtime instances via Redis. */
    TTS_CACHE_REDIS_ENABLED: zod_1.z.preprocess(stringToBoolean, zod_1.z.boolean().default(true)),
    TTS_CACHE_REDIS_TTL_SECONDS: zod_1.z.preprocess(emptyToUndefined, zod_1.z.coerce.number().int().positive().default(86400)),
    /** Skip Redis/LRU store for clips larger than this (bytes). */
    TTS_CACHE_MAX_ENTRY_BYTES: zod_1.z.preprocess(emptyToUndefined, zod_1.z.coerce.number().int().positive().default(4194304)),
    /** Redis key prefix for TTS payload keys: `${prefix}:${sha256}`. */
    TTS_CACHE_PREFIX: zod_1.z.preprocess(emptyToUndefined, zod_1.z.string().min(1).default('ttscache')),
    PLAYBACK_PROFILE: zod_1.z.preprocess(emptyToUndefined, zod_1.z.enum(['pstn', 'hd']).default('pstn')),
    PLAYBACK_PSTN_SAMPLE_RATE: zod_1.z.preprocess(emptyToUndefined, zod_1.z.coerce.number().int().positive().default(8000)),
    PLAYBACK_ENABLE_HIGHPASS: zod_1.z.preprocess(stringToBoolean, zod_1.z.boolean().default(true)),
    /* ───────────────────────── Brain / LLM ───────────────────────── */
    /** When true, use local default brain (keyword rules). When false or unset, use BRAIN_URL if set (e.g. GPT-4o API). */
    BRAIN_USE_LOCAL: zod_1.z.preprocess(stringToBoolean, zod_1.z.boolean().default(false)),
    /**
     * When false (default), strict `/health/voice` does not fail readiness if brain HTTP is unreachable
     * (e.g. `BRAIN_URL` set but compose profile `llm` not started). Set true when the HTTP brain must be up.
     */
    BRAIN_HEALTH_REQUIRED: zod_1.z.preprocess(stringToBoolean, zod_1.z.boolean().default(false)),
    BRAIN_URL: zod_1.z.preprocess(emptyToUndefined, zod_1.z.string().min(1).optional()),
    BRAIN_TIMEOUT_MS: zod_1.z.preprocess(emptyToUndefined, zod_1.z.coerce.number().int().positive().default(8000)),
    BRAIN_STREAMING_ENABLED: zod_1.z.preprocess(stringToBoolean, zod_1.z.boolean().default(true)),
    BRAIN_STREAM_PATH: zod_1.z.preprocess(emptyToUndefined, zod_1.z.string().min(1).default('/reply/stream')),
    BRAIN_STREAM_PING_MS: zod_1.z.preprocess(emptyToUndefined, zod_1.z.coerce.number().int().positive().default(15000)),
    BRAIN_STREAM_FIRST_AUDIO_MAX_MS: zod_1.z.preprocess(emptyToUndefined, zod_1.z.coerce.number().int().positive().default(2000)),
    BRAIN_STREAM_SEGMENT_MIN_CHARS: zod_1.z.preprocess(emptyToUndefined, zod_1.z.coerce.number().int().positive().default(120)),
    BRAIN_STREAM_SEGMENT_NEXT_CHARS: zod_1.z.preprocess(emptyToUndefined, zod_1.z.coerce.number().int().positive().default(180)),
    /**
     * Platform default for voice-call LLM routing: `brain_local` (keyword brain), `brain_http`, or `openai`.
     * Aliases: `brain` / `local` → brain_local. Does not force HTTP brain merely because BRAIN_URL is set.
     */
    PLATFORM_LLM_PROVIDER: zod_1.z.preprocess(emptyToUndefined, zod_1.z.string().min(1).default('brain_local')),
    /** Legacy voice env; used only when PLATFORM_LLM_PROVIDER is unset (prefer PLATFORM_LLM_PROVIDER). */
    LLM_PROVIDER: zod_1.z.preprocess(emptyToUndefined, zod_1.z.string().min(1).optional()),
    /** Platform OpenAI key when PLATFORM_LLM_PROVIDER=openai. */
    OPENAI_API_KEY: zod_1.z.preprocess(emptyToUndefined, zod_1.z.string().min(1).optional()),
    OPENAI_MODEL: zod_1.z.preprocess(emptyToUndefined, zod_1.z.string().min(1).default('gpt-4o-mini')),
    /** Optional OpenAI-compatible API base (default https://api.openai.com/v1). */
    OPENAI_BASE_URL: zod_1.z.preprocess(emptyToUndefined, zod_1.z.string().url().optional()),
    ELEVENLABS_API_KEY: zod_1.z.preprocess(emptyToUndefined, zod_1.z.string().min(1).optional()),
    /* ───────────────────────── Call transcript / summarizer ───────────────────────── */
    /** When set, write full call transcript (caller + assistant text) to this dir at teardown. No audio. */
    CALL_TRANSCRIPT_DIR: zod_1.z.preprocess(emptyToUndefined, zod_1.z.string().min(1).optional()),
    /** Per-call WAV/JSON forensics (default off). Requires ALLOW_PROD_DEBUG_CAPTURE in production if enabled. */
    AUDIO_FORENSICS_ENABLED: zod_1.z.preprocess(stringToBoolean, zod_1.z.boolean().default(false)),
    AUDIO_FORENSICS_DIR: zod_1.z.preprocess(emptyToUndefined, zod_1.z.string().min(1).default('/data/veralux/voice/forensics')),
    /** When false (default), redact transcript-like fields in forensics JSON via observability/redaction. */
    AUDIO_FORENSICS_ALLOW_PII: zod_1.z.preprocess(stringToBoolean, zod_1.z.boolean().default(false)),
    /** Max per-call `003_emit_frame_*.wav` artifacts (after cap, timeline still records). */
    AUDIO_FORENSICS_MAX_EMIT_FRAMES: zod_1.z.preprocess(emptyToUndefined, zod_1.z.coerce.number().int().min(0).default(400)),
    /**
     * When true, buffer inbound PCM during post-playback grace (not during active playback) and replay after grace.
     * Caps at STT_PLAYBACK_GRACE_BUFFER_MAX_MS. Default false.
     */
    STT_CAPTURE_DURING_POST_PLAYBACK_GRACE: zod_1.z.preprocess(stringToBoolean, zod_1.z.boolean().default(false)),
    STT_PLAYBACK_GRACE_BUFFER_MAX_MS: zod_1.z.preprocess(emptyToUndefined, zod_1.z.coerce.number().int().positive().default(1000)),
    /**
     * When true, use residual wall gap (time since last frame minus prior frame duration) to detect media gaps
     * instead of raw wall-clock delta alone. Default false preserves legacy Date.now gap behavior.
     */
    STT_USE_AUDIO_CLOCK_FOR_MEDIA_GAPS: zod_1.z.preprocess(stringToBoolean, zod_1.z.boolean().default(false)),
    /**
     * How aggressively to gate STT after assistant playback (echo control).
     * - conservative: longer grace, stricter energy on grace-buffer replay, stricter transcript echo match
     * - balanced: grace applies even in LISTENING; transcript similarity filter
     * - permissive: legacy early open when LISTENING (barge-in testing)
     */
    STT_ECHO_SUPPRESSION_MODE: zod_1.z.preprocess(emptyToUndefined, zod_1.z.enum(['conservative', 'balanced', 'permissive']).default('balanced')),
    /** First N ms of replayed post-playback grace audio: drop frames below echo-tail energy threshold. */
    STT_POST_PLAYBACK_ECHO_TAIL_MS: zod_1.z.preprocess(emptyToUndefined, zod_1.z.coerce.number().int().min(0).default(450)),
    /** During echo-tail replay, require rms >= effectiveFloor * mult (see echoSuppression). */
    STT_ECHO_POST_PLAYBACK_RMS_MULT_CONSERVATIVE: zod_1.z.preprocess(emptyToUndefined, zod_1.z.coerce.number().positive().default(1.75)),
    STT_ECHO_POST_PLAYBACK_RMS_MULT_BALANCED: zod_1.z.preprocess(emptyToUndefined, zod_1.z.coerce.number().positive().default(1.28)),
    STT_ECHO_POST_PLAYBACK_RMS_MULT_PERMISSIVE: zod_1.z.preprocess(emptyToUndefined, zod_1.z.coerce.number().positive().default(1.05)),
    /* ───────────────────────── Control Plane integration ───────────────────────── */
    /** When set, runtime reports call events (start/end with transcript) to the control plane. */
    CONTROL_PLANE_URL: zod_1.z.preprocess(emptyToUndefined, zod_1.z.string().min(1).optional()),
    /** API key for control plane auth (ADMIN_API_KEY). Required when CONTROL_PLANE_URL is set. */
    CONTROL_PLANE_API_KEY: zod_1.z.preprocess(emptyToUndefined, zod_1.z.string().min(1).optional()),
    /**
     * API key accepted by runtime voice-control endpoints.
     * Falls back to CONTROL_PLANE_API_KEY if unset.
     */
    VOICE_CONTROL_API_KEY: zod_1.z.preprocess(emptyToUndefined, zod_1.z.string().min(1).optional()),
    /* ───────────────────────── Redis / Capacity ───────────────────────── */
    REDIS_URL: zod_1.z.string().min(1),
    GLOBAL_CONCURRENCY_CAP: zod_1.z.coerce.number().int().positive(),
    TENANT_CONCURRENCY_CAP_DEFAULT: zod_1.z.coerce.number().int().positive(),
    TENANT_CALLS_PER_MIN_CAP_DEFAULT: zod_1.z.coerce.number().int().positive(),
    CAPACITY_TTL_SECONDS: zod_1.z.coerce.number().int().positive(),
    /** When at capacity, answer and retry instead of immediate busy message (PSTN / Telnyx). */
    CAPACITY_HOLD_ENABLED: zod_1.z.preprocess(stringToBoolean, zod_1.z.boolean().default(true)),
    /** Max seconds to wait on hold for a capacity slot before giving up. */
    CAPACITY_HOLD_MAX_SECONDS: zod_1.z.preprocess(emptyToUndefined, zod_1.z.coerce.number().int().positive().max(3600).default(300)),
    /** Delay between capacity retries while caller is on hold. */
    CAPACITY_HOLD_POLL_INTERVAL_MS: zod_1.z.preprocess(emptyToUndefined, zod_1.z.coerce.number().int().positive().max(120000).default(4000)),
    /** TTS line played periodically while waiting (ignored if CAPACITY_HOLD_AUDIO_URL is set). */
    CAPACITY_HOLD_MESSAGE: zod_1.z.preprocess(emptyToUndefined, zod_1.z.string().min(1).default('Please hold while we connect you.')),
    CAPACITY_HOLD_TIMEOUT_MESSAGE: zod_1.z.preprocess(emptyToUndefined, zod_1.z.string().min(1).default("We're still busy. Please try your call again later.")),
    /** Optional looped hold audio (Telnyx playback_start URL); overrides CAPACITY_HOLD_MESSAGE when set. */
    CAPACITY_HOLD_AUDIO_URL: zod_1.z.preprocess(emptyToUndefined, zod_1.z.string().url().optional()),
    TENANTMAP_PREFIX: zod_1.z.preprocess(emptyToUndefined, zod_1.z.string().min(1).default('tenantmap')),
    TENANTCFG_PREFIX: zod_1.z.preprocess(emptyToUndefined, zod_1.z.string().min(1).default('tenantcfg')),
    CAP_PREFIX: zod_1.z.preprocess(emptyToUndefined, zod_1.z.string().min(1).default('cap')),
}).superRefine((data, ctx) => {
    if (!data.KOKORO_URL || data.KOKORO_URL.trim() === '') {
        ctx.addIssue({
            code: zod_1.z.ZodIssueCode.custom,
            message: 'KOKORO_URL is required (Kokoro is the only TTS path)',
            path: ['KOKORO_URL'],
        });
    }
    if (data.TENANT_CONCURRENCY_CAP_DEFAULT > data.GLOBAL_CONCURRENCY_CAP) {
        ctx.addIssue({
            code: zod_1.z.ZodIssueCode.custom,
            message: 'TENANT_CONCURRENCY_CAP_DEFAULT must be <= GLOBAL_CONCURRENCY_CAP (per-tenant limit cannot exceed the global pool)',
            path: ['TENANT_CONCURRENCY_CAP_DEFAULT'],
        });
    }
});
const parsed = EnvSchema.safeParse(process.env);
if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join(', ');
    throw new Error(`Invalid environment variables: ${issues}`);
}
exports.env = parsed.data;
const verifyOverride = process.env.TELNYX_VERIFY_SIGNATURES?.trim().toLowerCase();
const signaturesExplicitlyDisabled = verifyOverride === 'false' || verifyOverride === '0' || verifyOverride === 'no';
if (exports.env.NODE_ENV === 'production') {
    if (exports.env.TELNYX_SKIP_SIGNATURE || signaturesExplicitlyDisabled) {
        throw new Error('Insecure Telnyx webhook config in production: signature verification cannot be disabled.');
    }
    if (!(exports.env.VOICE_CONTROL_API_KEY?.trim() || exports.env.CONTROL_PLANE_API_KEY?.trim())) {
        throw new Error('VOICE_CONTROL_API_KEY (or CONTROL_PLANE_API_KEY) is required in production to protect /v1/calls voice-control routes.');
    }
    const debugFlagsEnabled = exports.env.AUDIO_DIAGNOSTICS ||
        exports.env.AUDIO_FORENSICS_ENABLED ||
        exports.env.STT_DEBUG_DUMP_WHISPER_WAVS ||
        exports.env.STT_DEBUG_DUMP_PCM16 ||
        exports.env.STT_DEBUG_DUMP_RX_WAV ||
        exports.env.STT_DEBUG_DUMP_FAR_END_REF ||
        exports.env.STT_DEBUG_AEC_NEAR_OUT_WAV ||
        !!exports.env.STT_DEBUG_DIR ||
        !!exports.env.AMRWB_DEBUG_DIR;
    if (debugFlagsEnabled && !exports.env.ALLOW_PROD_DEBUG_CAPTURE) {
        throw new Error('Debug capture/logging flags are enabled in production. Disable debug flags or set ALLOW_PROD_DEBUG_CAPTURE=true explicitly.');
    }
}
//# sourceMappingURL=env.js.map