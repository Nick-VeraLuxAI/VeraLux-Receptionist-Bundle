"use strict";
// src/stt/chunkedSTT.ts
//
// ChunkedSTT = conversation manager (VAD + timing + buffering + orchestration)
// It should NOT “enhance” audio. However, in real-time systems, upstream bugs can cause
// PCM frame replay (lag-k duplication) even when the AMR storage is clean.
// This file includes an OPTIONAL, ENV-GATED defensive replay guard:
//   STT_RX_POSTPROCESS_ENABLED=true  => enables the guard
//   STT_RX_DEDUPE_WINDOW=32          => drop frames repeated within last N frames (per instance)
//
// Default behavior remains unchanged when STT_RX_POSTPROCESS_ENABLED is false.
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ChunkedSTT = void 0;
const crypto_1 = __importDefault(require("crypto"));
const env_1 = require("../env");
const log_1 = require("../log");
const audioForensics_1 = require("../observability/audioForensics");
const echoSuppression_1 = require("./echoSuppression");
const metrics_1 = require("../metrics");
const sileroVad_1 = require("./vad/sileroVad");
const DEFAULT_PARTIAL_INTERVAL_MS = 250;
const DEFAULT_SILENCE_END_MS = 900;
const DEFAULT_PRE_ROLL_MS = 1200;
const DEFAULT_MAX_UTTERANCE_MS = 6000;
const DEFAULT_MIN_SECONDS = 0.6; // must have this much audio before partials
const DEFAULT_SILENCE_MIN_SECONDS = 0.45; // silence needed to finalize
const DEFAULT_FINAL_TAIL_CUSHION_MS = 120;
const DEFAULT_FINAL_MIN_SECONDS = 1.0;
const DEFAULT_FINAL_MIN_BYTES_FALLBACK = 0;
const DEFAULT_PARTIAL_MIN_MS = 600;
// Speech detection defaults (env.ts may override)
const DEFAULT_SPEECH_RMS_FLOOR = 0.015;
const DEFAULT_SPEECH_PEAK_FLOOR = 0.045;
/** Consecutive frames at/above gate to open an utterance (PSTN syllables often alternate RMS vs peak per 20 ms frame). */
const DEFAULT_SPEECH_FRAMES_REQUIRED = 5;
/**
 * When VAD is off, allow opening speech if one dimension dips briefly but rolling energy + min/max ratios
 * still look like sustained caller speech (not used during playback-only barge-in path beyond shared isSpeech).
 */
const STT_ALT_SPEECH_ROLLING_OR_ENABLED = parseBool(process.env.STT_ALT_SPEECH_ROLLING_OR_PATH_ENABLED, true);
const STT_ALT_ROLLING_RMS_MULT = numEnv('STT_ALT_SPEECH_ROLLING_RMS_MULT', 0.76);
const STT_ALT_ROLLING_PEAK_MULT = numEnv('STT_ALT_SPEECH_ROLLING_PEAK_MULT', 0.5);
const STT_ALT_MAX_DIM_RATIO = numEnv('STT_ALT_SPEECH_MAX_DIM_RATIO', 0.88);
const STT_ALT_MIN_DIM_RATIO = numEnv('STT_ALT_SPEECH_MIN_DIM_RATIO', 0.36);
// Replay guard defaults
const DEFAULT_RX_DEDUPE_WINDOW = 32;
const FINAL_STOP_ABORT_GRACE_MS = 150;
// ============================================================================
// TIER_1_DYNAMIC_ENDPOINTING (ANCHOR BLOCK)
// - Adds dynamic silence finalization to prevent truncation / never-finalize
// - Replaces fixed silenceFramesNeeded logic with a curve based on speech length + RMS
// - Also enables a finalize fallback for stop/max when we have enough audio
// ============================================================================
function numEnv(key, fallback) {
    const raw = process.env[key];
    if (raw == null)
        return fallback;
    const n = Number(raw);
    return Number.isFinite(n) ? n : fallback;
}
/** Like numEnv but treats blank/whitespace as unset (avoids `Number('') === 0` for optional caps). */
function numEnvNonEmpty(key, fallback) {
    const raw = process.env[key];
    if (raw == null || raw.trim() === '')
        return fallback;
    const n = Number(raw);
    return Number.isFinite(n) ? n : fallback;
}
function clampN(x, lo, hi) {
    return Math.min(hi, Math.max(lo, x));
}
// NOTE: we keep your existing env.STT_SILENCE_END_MS behavior as the "baseline"
// and clamp dynamic silence within min/max.
const T1_SILENCE_MIN_MS = numEnv('STT_SILENCE_DYNAMIC_MIN_MS', 220);
const T1_SILENCE_MAX_MS = numEnv('STT_SILENCE_DYNAMIC_MAX_MS', 1200);
// How much extra silence we add as speech gets longer (log curve)
const T1_SILENCE_GROWTH_MS = numEnv('STT_SILENCE_GROWTH_MS', 280);
const T1_SILENCE_LOG_K = numEnv('STT_SILENCE_LOG_K', 0.8);
// Loud speech reduces required trailing silence
const T1_LOUD_BONUS_MS = numEnv('STT_SILENCE_LOUD_BONUS_MS', 160);
const T1_LOUD_RMS_REF = numEnv('STT_SILENCE_LOUD_RMS_REF', 0.06); // RMS is normalized (0..1)
// Weak/borderline speech increases required trailing silence
const T1_WEAK_PENALTY_MS = numEnv('STT_SILENCE_WEAK_PENALTY_MS', 220);
const T1_WEAK_RMS_FLOOR = numEnv('STT_SILENCE_WEAK_RMS_FLOOR', 0.03);
// Don’t finalize unless speech actually happened (prevents finalizing on noise)
const T1_MIN_SPEECH_MS = numEnv('STT_MIN_SPEECH_MS_TO_FINALIZE', 180);
const T1_MIN_SPEECH_BYTES = numEnv('STT_MIN_SPEECH_BYTES_TO_FINALIZE', 3200);
// Optional fallback thresholds for stop/max
const T1_FALLBACK_MIN_MS = numEnv('STT_FINALIZE_FALLBACK_MIN_MS', 250);
const T1_FALLBACK_MIN_BYTES = numEnv('STT_FINALIZE_FALLBACK_MIN_BYTES', 6400);
// ============================================================================
// TIER 5: Auto-calibration + late-final watchdog
// ============================================================================
const T5_NOISE_FLOOR_ENABLED = parseBool(process.env.STT_NOISE_FLOOR_ENABLED, true);
const T5_NOISE_FLOOR_ALPHA = clampN(numEnv('STT_NOISE_FLOOR_ALPHA', 0.05), 0.01, 1);
const T5_NOISE_FLOOR_MIN_SAMPLES = numEnv('STT_NOISE_FLOOR_MIN_SAMPLES', 30);
// Softer defaults than 2.0/2.5 — PSTN + AMR-WB often sits below aggressive adaptive floors.
const T5_ADAPTIVE_RMS_MULT = numEnv('STT_ADAPTIVE_RMS_MULTIPLIER', 1.5);
const T5_ADAPTIVE_PEAK_MULT = numEnv('STT_ADAPTIVE_PEAK_MULTIPLIER', 1.55);
const T5_ADAPTIVE_MIN_RMS = numEnv('STT_ADAPTIVE_FLOOR_MIN_RMS', 0.01);
const T5_ADAPTIVE_MIN_PEAK = numEnv('STT_ADAPTIVE_FLOOR_MIN_PEAK', 0.03);
/** Max effective RMS/peak gate thresholds (0 = no cap). Keeps Tier-5 adaptivity from exceeding PSTN levels. */
const T5_EFFECTIVE_RMS_CAP = numEnvNonEmpty('STT_EFFECTIVE_RMS_CAP', 0.021);
const T5_EFFECTIVE_PEAK_CAP = numEnvNonEmpty('STT_EFFECTIVE_PEAK_CAP', 0.058);
const T5_LATE_FINAL_WATCHDOG_ENABLED = parseBool(process.env.STT_LATE_FINAL_WATCHDOG_ENABLED, true);
const T5_LATE_FINAL_WATCHDOG_MS = clampN(numEnv('STT_LATE_FINAL_WATCHDOG_MS', 8000), 3000, 30000);
function t1ComputeDynamicSilenceMs(args) {
    const speechMs = Math.max(0, args.speechMs);
    const avgRms = Math.max(0, args.avgRms);
    const baselineMs = Math.max(0, args.baselineMs);
    // Length curve: log1p gives short utterances quick finalize, long utterances more tail
    const lenNorm = Math.log1p(speechMs / 250) * T1_SILENCE_LOG_K; // ~0..?
    const lenExtra = clampN(lenNorm, 0, 2) * (T1_SILENCE_GROWTH_MS / 2);
    // Loudness bonus: louder => reduce required trailing silence
    const loudRatio = clampN(avgRms / Math.max(1e-6, T1_LOUD_RMS_REF), 0, 2);
    const loudBonus = loudRatio * (T1_LOUD_BONUS_MS * 0.5);
    // Weak penalty: weak => require more trailing silence
    const weakPenalty = avgRms < T1_WEAK_RMS_FLOOR ? T1_WEAK_PENALTY_MS : 0;
    const raw = baselineMs + lenExtra + weakPenalty - loudBonus;
    return clampN(raw, T1_SILENCE_MIN_MS, T1_SILENCE_MAX_MS);
}
function t1HasEnoughSpeech(args) {
    // Require BOTH time and bytes so we don't finalize on short spikes or weird buffering artifacts.
    return args.speechMs >= T1_MIN_SPEECH_MS && args.speechBytes >= T1_MIN_SPEECH_BYTES;
}
function t1ShouldFallbackFinalize(args) {
    if (!args.sawSpeech)
        return false;
    return args.totalMs >= T1_FALLBACK_MIN_MS || args.totalBytes >= T1_FALLBACK_MIN_BYTES;
}
function parseBool(value, def = false) {
    if (value == null)
        return def;
    const v = value.trim().toLowerCase();
    return v === '1' || v === 'true' || v === 'yes' || v === 'y';
}
function clamp(n, min, max) {
    return Math.min(max, Math.max(min, n));
}
function safeNum(value, fallback) {
    if (typeof value === 'number' && Number.isFinite(value))
        return value;
    if (typeof value === 'string') {
        const v = Number(value.trim());
        if (Number.isFinite(v))
            return v;
    }
    return fallback;
}
function normalizeWhitespace(text) {
    return text.replace(/\s+/g, ' ').trim();
}
function isNonEmpty(text) {
    return normalizeWhitespace(text).length > 0;
}
function isAbortError(error) {
    if (!error || typeof error !== 'object')
        return false;
    const name = error.name;
    return name === 'AbortError';
}
function isRetryableSttError(error) {
    if (isAbortError(error))
        return false;
    if (error instanceof TypeError)
        return true;
    const msg = String(error instanceof Error ? error.message : error).toLowerCase();
    if (msg.includes('abort'))
        return false;
    return (msg.includes('fetch') ||
        msg.includes('network') ||
        msg.includes('econnreset') ||
        msg.includes('etimedout') ||
        msg.includes('timeout') ||
        msg.includes('502') ||
        msg.includes('503') ||
        msg.includes('504') ||
        msg.includes('429'));
}
function delayWithAbort(ms, signal) {
    if (ms <= 0)
        return Promise.resolve();
    return new Promise((resolve, reject) => {
        const onAbort = () => {
            clearTimeout(t);
            signal.removeEventListener('abort', onAbort);
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        };
        const t = setTimeout(() => {
            signal.removeEventListener('abort', onAbort);
            resolve();
        }, ms);
        signal.addEventListener('abort', onAbort, { once: true });
    });
}
function computeRmsAndPeak(pcm16le) {
    if (pcm16le.length < 2)
        return { rms: 0, peak: 0 };
    const samples = Math.floor(pcm16le.length / 2);
    let sumSquares = 0;
    let peak = 0;
    for (let i = 0; i < samples; i += 1) {
        const s = pcm16le.readInt16LE(i * 2) / 32768;
        const a = Math.abs(s);
        if (a > peak)
            peak = a;
        sumSquares += s * s;
    }
    return { rms: Math.sqrt(sumSquares / samples), peak };
}
/** Short-time energy (mean square of normalized samples); equals RMS². */
function steFromRms(rms) {
    return rms * rms;
}
/** 20·log10(x) for normalized RMS or peak (0…1); fuller scale ≈ 0 dBFS at peak 1. */
function amplitudeToDbfs(x) {
    return 20 * Math.log10(Math.max(x, 1e-12));
}
function clampInt16(n) {
    if (n > 32767)
        return 32767;
    if (n < -32768)
        return -32768;
    return n | 0;
}
// PCMU -> PCM16LE decoding (kept here only because ingest() receives PCMU in some transports).
function muLawToPcmSample(uLawByte) {
    const u = (~uLawByte) & 0xff;
    const sign = u & 0x80;
    const exponent = (u >> 4) & 0x07;
    const mantissa = u & 0x0f;
    const bias = 0x84;
    let sample = ((mantissa << 3) + bias) << exponent;
    sample -= bias;
    if (sign)
        sample = -sample;
    return clampInt16(sample);
}
function pcmuToPcm16le(pcmu) {
    const output = Buffer.alloc(pcmu.length * 2);
    for (let i = 0; i < pcmu.length; i += 1) {
        const sample = muLawToPcmSample(pcmu[i]);
        output.writeInt16LE(sample, i * 2);
    }
    return output;
}
function upsamplePcm16le8kTo16kLinear(pcm16le) {
    const sampleCount = Math.floor(pcm16le.length / 2);
    if (sampleCount === 0)
        return Buffer.alloc(0);
    const out = Buffer.alloc(sampleCount * 4);
    for (let i = 0; i < sampleCount - 1; i += 1) {
        const cur = pcm16le.readInt16LE(i * 2);
        const next = pcm16le.readInt16LE((i + 1) * 2);
        const interp = clampInt16(Math.round((cur + next) / 2));
        const o = i * 4;
        out.writeInt16LE(cur, o);
        out.writeInt16LE(interp, o + 2);
    }
    const last = pcm16le.readInt16LE((sampleCount - 1) * 2);
    const o = (sampleCount - 1) * 4;
    out.writeInt16LE(last, o);
    out.writeInt16LE(last, o + 2);
    return out;
}
function sha1Hex(buf) {
    return crypto_1.default.createHash('sha1').update(buf).digest('hex');
}
class ChunkedSTT {
    constructor(opts) {
        // ===== Ingest serialization (prevents async VAD/state interleaving) =====
        this.ingestChain = Promise.resolve();
        this.ingestToken = 0; // bumps on stop/reset to kill queued work
        this.vadReady = false;
        // VAD smoothing counters (optional but helps avoid flapping)
        this.vadSpeechStreak = 0;
        this.vadSilenceStreak = 0;
        this.vadSpeechNow = false;
        // VAD hysteresis thresholds (prevents flapping)
        this.vadSpeechFramesRequired = clamp(safeNum(process.env.STT_VAD_SPEECH_FRAMES_REQUIRED, 2), 1, 20);
        this.vadSilenceFramesRequired = clamp(safeNum(process.env.STT_VAD_SILENCE_FRAMES_REQUIRED, 6), 1, 50);
        this.bargeInArmed = false;
        this.bargeInSpeechStreak = 0;
        this.bargeInLastStats = { rms: 0, peak: 0 };
        this.bargeInLastFrameMs = 0;
        // VERA_DEMO_SHOP_SPEAKERPHONE_20260905
        this.demoShopSpeakerphoneProtect = false;
        this._demoShopMaxUttDeferredLogged = false;
        this.playbackStartedAtMs = 0;
        this._demoShopEarlyBargeSuppressLogged = false;
        this._demoShopListenFinalKeepLogged = false;
        // State
        this.firstFrameLogged = false;
        this.inSpeech = false;
        this.lastSpeechAt = 0;
        this.lastFrameAtMs = 0;
        this.sawSpeech = false;
        this.sawSpeechEver = false; // survives utterance resets; used for call-end drain decisions
        this.utteranceMs = 0;
        this.utteranceBytes = 0;
        this.preRollFrames = [];
        this.preRollMs = 0;
        this.lastPrependedMs = 0;
        this.lastFrameMs = 0;
        this.utteranceFrames = [];
        this.speechFrameStreak = 0;
        this.playbackSpeechStreak = 0;
        this.silenceFrameStreak = 0;
        this.lastPartialAt = 0;
        this.lastPartialTranscript = '';
        this.rollingRms = 0;
        this.rollingPeak = 0;
        this.lastRawFrameStats = { rms: 0, peak: 0 };
        this.lastGateLogAtMs = 0;
        /** When a frame fails both strict gates but RMS/peak ratio still suggests speech (Whisper not invoked for other reasons). */
        this.lastWhisperNotCalledReasonAtMs = 0;
        this.peakPreUtteranceStreak = 0;
        this.preSpeechFramesRms = 0;
        this.preSpeechFramesPeak = 0;
        this.preSpeechFramesBoth = 0;
        this.preSpeechFramesOrPath = 0;
        this.candidateStartEmitted = false;
        this.lastCandidateDropLogAtMs = 0;
        this.finalFlushAt = 0;
        this.finalTranscriptAccepted = false;
        this.inFlight = false;
        this.inFlightToken = 0;
        this.finalizingStop = false;
        this.finalizingStopAtMs = 0;
        this.finalizingStopSpeechStreak = 0;
        this.finalizingStopIgnoreCount = 0;
        this.recentRxHashes = [];
        this.rxFramesDropped = 0;
        this.framesSeen = 0;
        // ===== Tier 5: Noise floor estimation (adaptive thresholds) =====
        this.noiseFloorRms = 0;
        this.noiseFloorPeak = 0;
        this.noiseFloorSampleCount = 0;
        this.speechStartAtMs = 0; // used by late-final watchdog
        // ===== Playback hard-gate state =====
        this.playbackWasActive = false;
        this.playbackEndedAtMs = 0;
        this.postPlaybackGraceMs = safeNum(process.env.STT_POST_PLAYBACK_GRACE_MS, 650);
        // ===== Call-end drain window =====
        // Allow FINAL enqueue briefly after call becomes inactive, to avoid dropping the last user utterance.
        this.callEndDrainMs = safeNum(process.env.STT_CALL_END_DRAIN_MS, 1200);
        this.callInactiveAtMs = 0;
        /** Post-playback grace PCM buffer (optional; see STT_CAPTURE_DURING_POST_PLAYBACK_GRACE). */
        this.postPlaybackGraceBuffer = [];
        this.postPlaybackGraceBufferMs = 0;
        this.forensicsUtteranceSeq = 0;
        /** Utterance id for current in-flight STT final (forensics). */
        this.activeForensicsUtteranceId = null;
        /** Forensics: last observed playback gate (null = not yet sampled). */
        this.lastForensicsGateRecorded = null;
        /** Forensics: frames that passed RX dedupe + playback gate (STT ingest order). */
        this.sttFrameIndex = 0;
        this.sttAudioClockMs = 0;
        this.provider = opts.provider;
        this.whisperUrl = opts.whisperUrl;
        this.language = opts.language;
        this.logContext = opts.logContext;
        this.tenantLabel = opts.logContext?.tenant_id ?? 'unknown';
        this.onTranscript = opts.onTranscript;
        this.onSpeechStart = opts.onSpeechStart;
        this.onUtteranceEnd = opts.onUtteranceEnd;
        this.onFinalResult = opts.onFinalResult;
        this.onFinalPipelineOutcome = opts.onFinalPipelineOutcome;
        this.emptyFinalExtraTries = clamp(env_1.env.STT_EMPTY_FINAL_EXTRA_TRIES, 0, 4);
        this.finalErrorExtraTries = clamp(env_1.env.STT_FINAL_ERROR_EXTRA_TRIES, 0, 4);
        this.finalRetryBackoffMs = clamp(env_1.env.STT_FINAL_RETRY_BACKOFF_MS, 0, 2000);
        this.consumePreRoll = opts.consumePreRoll;
        this.onFrameForPreRoll = opts.onFrameForPreRoll;
        this.prompt = opts.prompt;
        // ===== BARGE-IN (NEW) =====
        this.onBargeInDetected = opts.onBargeInDetected;
        // VERA_DEMO_SHOP_SPEAKERPHONE_20260905
        this.demoShopSpeakerphoneProtect = !!opts.demoShopSpeakerphoneProtect;
        this.onSttRequestStart = opts.onSttRequestStart;
        this.onSttRequestEnd = opts.onSttRequestEnd;
        this.isPlaybackActive = opts.isPlaybackActive;
        this.isListening = opts.isListening;
        this.getTrack = opts.getTrack;
        this.getCodec = opts.getCodec;
        this.isCallActive = opts.isCallActive;
        this.getPostPlaybackGraceMs = opts.getPostPlaybackGraceMs;
        this.getPipelineDiagContext = opts.getPipelineDiagContext;
        this.onSttListeningGateActivity = opts.onSttListeningGateActivity;
        this.pipelineDiagOnPlayback = env_1.env.STT_PIPELINE_DIAG_ON_PLAYBACK;
        this.speechStreakPartialDecay = clamp(Math.floor(safeNum(process.env.STT_SPEECH_STREAK_PARTIAL_DECAY, 1)), 1, 4);
        this.inputCodec = opts.inputCodec ?? 'pcmu';
        const defaultHz = this.inputCodec === 'pcm16le' ? 16000 : 8000;
        const sampleRate = safeNum(opts.sampleRate, defaultHz);
        this.sampleRate = sampleRate > 0 ? sampleRate : defaultHz;
        // PCM16LE bytes/sec (mono)
        this.bytesPerSecondPcm16 = this.sampleRate * 2;
        this.fallbackFrameMs = safeNum(opts.frameMs, env_1.env.STT_CHUNK_MS);
        const minSeconds = safeNum(env_1.env.STT_MIN_SECONDS, DEFAULT_MIN_SECONDS);
        this.minSpeechMs = Math.max(0, minSeconds) * 1000;
        // Prefer explicit millisecond silence endpointing.
        // If not set, fall back to STT_SILENCE_MIN_SECONDS -> ms.
        // Final fallback is DEFAULT_SILENCE_END_MS.
        const silenceEndMsRaw = safeNum(env_1.env.STT_SILENCE_END_MS, NaN);
        const silenceEndMsFromSeconds = Math.round(Math.max(0, safeNum(env_1.env.STT_SILENCE_MIN_SECONDS, DEFAULT_SILENCE_MIN_SECONDS)) * 1000);
        const baselineSilenceEndMs = Number.isFinite(silenceEndMsRaw) && silenceEndMsRaw > 0 ? silenceEndMsRaw : silenceEndMsFromSeconds;
        const resolvedBaselineSilenceEndMs = Number.isFinite(baselineSilenceEndMs) && baselineSilenceEndMs > 0 ? baselineSilenceEndMs : DEFAULT_SILENCE_END_MS;
        // opts override ONLY if it's a positive finite number
        const optSilenceEndMs = typeof opts.silenceEndMs === 'number' && Number.isFinite(opts.silenceEndMs) && opts.silenceEndMs > 0
            ? opts.silenceEndMs
            : undefined;
        this.silenceEndMs = clamp(optSilenceEndMs ?? resolvedBaselineSilenceEndMs, 100, 8000);
        const finalTailCushionMs = safeNum(env_1.env.FINAL_TAIL_CUSHION_MS, DEFAULT_FINAL_TAIL_CUSHION_MS);
        this.finalTailCushionMs = clamp(finalTailCushionMs, 0, 2000);
        const finalMinSeconds = safeNum(env_1.env.FINAL_MIN_SECONDS, DEFAULT_FINAL_MIN_SECONDS);
        const computedFinalMinBytes = Math.round(this.bytesPerSecondPcm16 * Math.max(0, finalMinSeconds));
        const finalMinBytes = safeNum(env_1.env.FINAL_MIN_BYTES, computedFinalMinBytes);
        this.finalMinBytes = Math.max(0, Math.round(finalMinBytes ?? DEFAULT_FINAL_MIN_BYTES_FALLBACK));
        this.partialMinMs = clamp(safeNum(env_1.env.STT_PARTIAL_MIN_MS, DEFAULT_PARTIAL_MIN_MS), 200, 5000);
        this.partialMinBytes = Math.max(0, Math.round((this.bytesPerSecondPcm16 * this.partialMinMs) / 1000));
        this.partialIntervalMs = clamp(safeNum(opts.partialIntervalMs, env_1.env.STT_PARTIAL_INTERVAL_MS ?? DEFAULT_PARTIAL_INTERVAL_MS), 100, 10000);
        this.preRollMaxMs = clamp(safeNum(opts.preRollMs, env_1.env.STT_PRE_ROLL_MS ?? DEFAULT_PRE_ROLL_MS), 0, 2000);
        this.maxUtteranceMs = clamp(safeNum(opts.maxUtteranceMs, env_1.env.STT_MAX_UTTERANCE_MS ?? DEFAULT_MAX_UTTERANCE_MS), 2000, 60000);
        this.noFrameFinalizeMs = Math.max(400, Math.min(5000, safeNum(process.env.STT_NO_FRAME_FINALIZE_MS, 1000)));
        const rmsFloorEnv = env_1.env.STT_RMS_FLOOR ?? env_1.env.STT_SPEECH_RMS_FLOOR ?? DEFAULT_SPEECH_RMS_FLOOR;
        const peakFloorEnv = env_1.env.STT_PEAK_FLOOR ?? env_1.env.STT_SPEECH_PEAK_FLOOR ?? DEFAULT_SPEECH_PEAK_FLOOR;
        this.speechRmsFloor = safeNum(opts.speechRmsFloor, rmsFloorEnv);
        this.speechPeakFloor = safeNum(opts.speechPeakFloor, peakFloorEnv);
        this.speechFramesRequired = clamp(safeNum(opts.speechFramesRequired, env_1.env.STT_SPEECH_FRAMES_REQUIRED ?? DEFAULT_SPEECH_FRAMES_REQUIRED), 1, 30);
        // VERA_DEMO_SHOP_LISTENOPEN_20260907 — AMR-WB+AEC speech is bursty; 5 consecutive
        // 20ms frames above both floors never opened v3:B0f4 (peak_streak=2 then silence_reset).
        if (this.demoShopSpeakerphoneProtect) {
            this.speechFramesRequired = Math.min(this.speechFramesRequired, 2);
        }
        // honor opts override
        this.disableGates = opts.disableGates ?? (env_1.env.STT_DISABLE_GATES ?? false);
        this.vadEnabled = parseBool(process.env.STT_VAD_ENABLED, false);
        this.vadThreshold = safeNum(process.env.STT_VAD_THRESHOLD, 0.5);
        if (this.vadEnabled) {
            void sileroVad_1.SileroVad.create({ threshold: this.vadThreshold })
                .then((v) => {
                this.vad = v;
                log_1.log.info({ event: 'stt_vad_ready', threshold: this.vadThreshold, ...(this.logContext ?? {}) }, 'silero vad ready');
                this.vadReady = true;
            })
                .catch((err) => {
                log_1.log.error({ event: 'stt_vad_init_failed', err, ...(this.logContext ?? {}) }, 'silero vad init failed');
            })
                .then(() => undefined);
        }
        // Optional RX replay guard
        this.rxGuardEnabled = parseBool(process.env.STT_RX_POSTPROCESS_ENABLED, false);
        const win = Number.parseInt(process.env.STT_RX_DEDUPE_WINDOW ?? '', 10);
        this.rxDedupeWindow =
            this.rxGuardEnabled && Number.isFinite(win) && win > 0 ? win : this.rxGuardEnabled ? DEFAULT_RX_DEDUPE_WINDOW : 0;
        const rawRxMinPeak = process.env.STT_RX_DEDUPE_MIN_PEAK;
        const parsedRxMinPeak = rawRxMinPeak !== undefined && rawRxMinPeak !== '' ? Number.parseFloat(rawRxMinPeak) : NaN;
        this.rxDedupeMinPeak =
            Number.isFinite(parsedRxMinPeak) && parsedRxMinPeak >= 0 ? parsedRxMinPeak : 280 / 32768;
        log_1.log.info({
            event: 'stt_tuning',
            stt_tuning: {
                input_codec: this.inputCodec,
                sample_rate_hz: this.sampleRate,
                rms_floor: this.speechRmsFloor,
                peak_floor: this.speechPeakFloor,
                frames_required: this.speechFramesRequired,
                chunk_ms: this.fallbackFrameMs,
                partial_interval_ms: this.partialIntervalMs,
                partial_min_ms: this.partialMinMs,
                pre_roll_ms: this.preRollMaxMs,
                silence_end_ms: this.silenceEndMs,
                max_utt_ms: this.maxUtteranceMs,
                final_tail_cushion_ms: this.finalTailCushionMs,
                final_min_bytes: this.finalMinBytes,
                disable_gates: this.disableGates,
                rx_guard_enabled: this.rxGuardEnabled,
                rx_dedupe_window: this.rxDedupeWindow,
                rx_dedupe_min_peak: this.rxDedupeMinPeak,
                post_playback_grace_ms: this.postPlaybackGraceMs,
                post_playback_grace_dynamic: !!this.getPostPlaybackGraceMs,
                no_frame_finalize_ms: this.noFrameFinalizeMs,
                noise_floor_enabled: T5_NOISE_FLOOR_ENABLED,
                adaptive_rms_mult: T5_ADAPTIVE_RMS_MULT,
                adaptive_peak_mult: T5_ADAPTIVE_PEAK_MULT,
                effective_rms_cap: T5_EFFECTIVE_RMS_CAP,
                effective_peak_cap: T5_EFFECTIVE_PEAK_CAP,
                late_final_watchdog_enabled: T5_LATE_FINAL_WATCHDOG_ENABLED,
                late_final_watchdog_ms: T5_LATE_FINAL_WATCHDOG_MS,
                pipeline_diag_interval_ms: env_1.env.STT_PIPELINE_DIAG_INTERVAL_MS,
                pipeline_diag_on_playback: env_1.env.STT_PIPELINE_DIAG_ON_PLAYBACK,
                alt_speech_rolling_or_enabled: STT_ALT_SPEECH_ROLLING_OR_ENABLED,
                speech_streak_partial_decay: this.speechStreakPartialDecay,
                empty_final_extra_tries: this.emptyFinalExtraTries,
                final_error_extra_tries: this.finalErrorExtraTries,
                final_retry_backoff_ms: this.finalRetryBackoffMs,
            },
            ...(this.logContext ?? {}),
        }, 'stt tuning');
        const diagMs = env_1.env.STT_PIPELINE_DIAG_INTERVAL_MS;
        if (diagMs > 0) {
            this.pipelineDiagTimer = setInterval(() => {
                try {
                    this.emitPipelineDiag('interval');
                }
                catch (err) {
                    log_1.log.error({ event: 'stt_pipeline_diag_error', err, ...(this.logContext ?? {}) }, 'stt pipeline diag failed');
                }
            }, diagMs);
            this.pipelineDiagTimer.unref?.();
        }
        // Partial tick is OPTIONAL now.
        // With CallSession running a final-only turn policy, partials just add load and can delay finals.
        // Enable explicitly with: STT_PARTIALS_ENABLED=true
        const partialsEnabled = parseBool(process.env.STT_PARTIALS_ENABLED, false);
        if (partialsEnabled) {
            this.timer = setInterval(() => {
                try {
                    this.flushIfReady('interval');
                }
                catch (err) {
                    log_1.log.error({ err, ...(this.logContext ?? {}) }, 'stt interval flush failed');
                }
            }, this.partialIntervalMs);
        }
        else {
            this.timer = undefined;
            this.noFrameCheckTimer = setInterval(() => {
                try {
                    this.checkNoFrameFinalize();
                }
                catch (err) {
                    log_1.log.error({ err, ...(this.logContext ?? {}) }, 'stt no-frame check failed');
                }
            }, 400);
            log_1.log.info({ event: 'stt_partials_disabled', no_frame_finalize_ms: this.noFrameFinalizeMs, ...(this.logContext ?? {}) }, 'stt partial timer disabled (final-only policy)');
        }
    }
    checkNoFrameFinalize() {
        if (!this.inSpeech || this.utteranceBytes <= 0 || this.playbackGateActive())
            return;
        const now = this.nowMs();
        const speechMs = Math.max(0, this.utteranceMs - this.lastPrependedMs);
        // Tier 5: Late-final watchdog — speech has been ongoing too long without finalizing
        if (T5_LATE_FINAL_WATCHDOG_ENABLED && this.speechStartAtMs > 0) {
            const elapsedSinceSpeechStart = now - this.speechStartAtMs;
            if (elapsedSinceSpeechStart >= T5_LATE_FINAL_WATCHDOG_MS &&
                t1HasEnoughSpeech({ speechMs, speechBytes: this.utteranceBytes })) {
                this.silenceToFinalizeTimer?.();
                this.silenceToFinalizeTimer = undefined;
                log_1.log.info({
                    event: 'stt_late_final_watchdog',
                    reason: 'watchdog',
                    elapsed_since_speech_start_ms: Math.round(elapsedSinceSpeechStart),
                    watchdog_ms: T5_LATE_FINAL_WATCHDOG_MS,
                    speech_ms: Math.round(speechMs),
                    speech_bytes: this.utteranceBytes,
                    ...(this.logContext ?? {}),
                }, 'stt late-final watchdog (force final)');
                this.finalizeUtterance('silence');
                return;
            }
        }
        // Original: no frames received for noFrameFinalizeMs
        if (now - this.lastFrameAtMs < this.noFrameFinalizeMs)
            return;
        if (!t1HasEnoughSpeech({ speechMs, speechBytes: this.utteranceBytes }))
            return;
        this.silenceToFinalizeTimer?.();
        this.silenceToFinalizeTimer = undefined;
        log_1.log.info({
            event: 'stt_no_frame_finalize',
            reason: 'no_frames',
            no_frame_ms: Math.round(now - this.lastFrameAtMs),
            no_frame_finalize_ms: this.noFrameFinalizeMs,
            speech_ms: Math.round(speechMs),
            speech_bytes: this.utteranceBytes,
            ...(this.logContext ?? {}),
        }, 'stt finalize (no frames received)');
        this.finalizeUtterance('silence');
    }
    // Direct PCM16 ingest (already decoded elsewhere).
    ingestPcm16(pcm16, sampleRateHz) {
        if (!pcm16 || pcm16.length === 0)
            return;
        if (sampleRateHz !== this.sampleRate) {
            this.recordForensicsTimeline('frame_dropped_by_sample_rate', {
                expected_hz: this.sampleRate,
                got_hz: sampleRateHz,
                sample_count: pcm16.length,
            });
            log_1.log.warn({
                event: 'chunked_stt_sample_rate_mismatch',
                expected_hz: this.sampleRate,
                got_hz: sampleRateHz,
                ...(this.logContext ?? {}),
            }, 'chunked stt sample rate mismatch');
            return;
        }
        // IMPORTANT: Buffer.from(Int16Array) treats values as bytes (WRONG).
        // Create a Buffer view over the underlying ArrayBuffer, then COPY.
        const view = Buffer.from(pcm16.buffer, pcm16.byteOffset, pcm16.byteLength);
        const frame = Buffer.from(view);
        const computedFrameMs = (pcm16.length / sampleRateHz) * 1000;
        const frameMs = Number.isFinite(computedFrameMs) && computedFrameMs > 0 ? computedFrameMs : this.fallbackFrameMs;
        if (!this.firstFrameLogged) {
            this.firstFrameLogged = true;
            log_1.log.info({
                event: 'stt_first_pcm16_frame',
                input_codec: 'pcm16le',
                int16_len: pcm16.length,
                input_bytes: frame.length,
                sample_rate_hz: sampleRateHz,
                computed_frame_ms: Math.round(frameMs),
                ...(this.logContext ?? {}),
            }, 'stt first pcm16 frame');
        }
        this.enqueueIngestDecodedPcm16(frame, frameMs);
    }
    // Unified ingest for either PCMU or PCM16LE input.
    ingest(input) {
        if (!input || input.length === 0)
            return;
        const bytesPerSampleIn = this.inputCodec === 'pcmu' ? 1 : 2;
        const samples = input.length / bytesPerSampleIn;
        const computedFrameMs = (samples / this.sampleRate) * 1000;
        const frameMs = Number.isFinite(computedFrameMs) && computedFrameMs > 0 ? computedFrameMs : this.fallbackFrameMs;
        if (!this.firstFrameLogged) {
            this.firstFrameLogged = true;
            const computedSamples = input.length / bytesPerSampleIn;
            log_1.log.info({
                event: 'stt_first_audio_frame',
                input_codec: this.inputCodec,
                input_bytes: input.length,
                bytes_per_sample_in: bytesPerSampleIn,
                computed_samples: computedSamples,
                sample_rate_hz: this.sampleRate,
                computed_frame_ms: Math.round(frameMs),
                silence_end_ms: this.silenceEndMs,
                partial_interval_ms: this.partialIntervalMs,
                ...(this.logContext ?? {}),
            }, 'stt first audio frame');
        }
        let framePcm16;
        if (this.inputCodec === 'pcmu') {
            framePcm16 = pcmuToPcm16le(input);
        }
        else {
            // passthrough, but COPY so we don't retain a pooled/reused buffer
            framePcm16 = Buffer.from(input);
        }
        this.enqueueIngestDecodedPcm16(framePcm16, frameMs);
    }
    enqueueIngestDecodedPcm16(pcm16, frameMs, opts) {
        const token = this.ingestToken;
        this.ingestChain = this.ingestChain
            .then(async () => {
            if (token !== this.ingestToken)
                return;
            await this.ingestDecodedPcm16(pcm16, frameMs, opts);
        })
            .catch((err) => {
            log_1.log.error({ event: 'stt_ingest_chain_error', err, ...(this.logContext ?? {}) }, 'stt ingest chain error');
        });
    }
    nowMs() {
        return Date.now();
    }
    allowFinalDuringCallEndDrain(kind) {
        if (kind !== 'final')
            return false;
        if (!this.isCallActive)
            return false;
        const active = this.isCallActive();
        const now = this.nowMs();
        if (active) {
            this.callInactiveAtMs = 0;
            return true;
        }
        // call is inactive
        if (this.callInactiveAtMs === 0)
            this.callInactiveAtMs = now;
        // Only allow if we actually had speech (prevents garbage finals)
        if (!this.sawSpeechEver)
            return false;
        return now - this.callInactiveAtMs <= this.callEndDrainMs;
    }
    playbackGateActive() {
        if (this.disableGates)
            return false;
        // VERA_DEMO_SHOP_DUPLEX_20260907 — after sustained barge, listen while her clip dies.
        // inSpeech keeps the gate open through post-play grace so the rest of the turn isn't dropped.
        if (this.demoShopSpeakerphoneProtect && (this.bargeInArmed || this.inSpeech))
            return false;
        const active = !!this.isPlaybackActive?.();
        if (active)
            return true;
        // Permissive: keep legacy behavior — open gate when LISTENING even during grace (barge-in tuning).
        // Balanced / conservative: post-playback grace still gates STT even after LISTENING arms (reduces echo).
        if ((0, echoSuppression_1.getEchoSuppressionMode)() === 'permissive' && this.isListening?.())
            return false;
        if (this.playbackEndedAtMs > 0) {
            const graceMs = this.getPostPlaybackGraceMs?.() ?? this.postPlaybackGraceMs;
            const since = this.nowMs() - this.playbackEndedAtMs;
            if (since >= 0 && since < graceMs)
                return true;
        }
        return false;
    }
    handlePlaybackTransitionIfNeeded() {
        if (this.disableGates)
            return;
        const active = !!this.isPlaybackActive?.();
        // PLAYBACK STARTED
        if (active && !this.playbackWasActive) {
            this.playbackWasActive = true;
            // VERA_DEMO_SHOP_SPEAKERPHONE_20260905
            this.playbackStartedAtMs = this.nowMs();
            this._demoShopEarlyBargeSuppressLogged = false;
            this.bargeInArmed = false;
            this.bargeInSpeechStreak = 0;
            this.bargeInLastStats = { rms: 0, peak: 0 };
            this.bargeInLastFrameMs = 0;
            this.preRollFrames = [];
            this.preRollMs = 0;
            if (this.inFlight)
                this.abortInFlight('finalize');
            if (this.inSpeech)
                this.resetUtteranceState();
            this.vadSpeechNow = false;
            this.vadSpeechStreak = 0;
            this.vadSilenceStreak = 0;
            if (this.vad)
                this.vad.reset();
            this.recentRxHashes.length = 0;
            if (this.pipelineDiagOnPlayback) {
                this.emitPipelineDiag('playback_start');
            }
        }
        // PLAYBACK ENDED
        if (!active && this.playbackWasActive) {
            this.playbackWasActive = false;
            this.playbackEndedAtMs = this.nowMs();
            // VERA_DEMO_SHOP_SPEAKERPHONE_20260905
            this.playbackStartedAtMs = 0;
            this._demoShopEarlyBargeSuppressLogged = false;
            this.recordForensicsTimeline('post_playback_echo_window_started', {
                grace_ms: this.getPostPlaybackGraceMs?.() ?? this.postPlaybackGraceMs,
                echo_tail_ms: env_1.env.STT_POST_PLAYBACK_ECHO_TAIL_MS,
                echo_suppression_mode: (0, echoSuppression_1.getEchoSuppressionMode)(),
            });
            this.playbackSpeechStreak = 0;
            this.vadSpeechNow = false;
            this.vadSpeechStreak = 0;
            this.vadSilenceStreak = 0;
            if (this.vad)
                this.vad.reset();
            this.recentRxHashes.length = 0;
            // ===== BARGE-IN HANDOFF =====
            if (this.bargeInArmed &&
                this.bargeInSpeechStreak >= this.speechFramesRequired &&
                !this.inSpeech &&
                this.preRollFrames.length > 0) {
                const frameMs = this.bargeInLastFrameMs > 0 ? this.bargeInLastFrameMs : this.fallbackFrameMs;
                const stats = this.bargeInLastStats.rms > 0
                    ? this.bargeInLastStats
                    : { rms: this.rollingRms, peak: this.rollingPeak };
                // VERA_DEMO_SHOP_SPEAKERPHONE_20260905 — near-silent scraps must not become a user turn
                if (this.demoShopSpeakerphoneProtect && Number(stats.rms) < 0.015) {
                    log_1.log.info({
                        event: 'stt_barge_in_handoff_skipped_near_silent',
                        pre_roll_frames: this.preRollFrames.length,
                        pre_roll_ms: Math.round(this.preRollMs),
                        frame_ms: Math.round(frameMs),
                        rms: Number(stats.rms.toFixed(4)),
                        peak: Number(stats.peak.toFixed(4)),
                        streak: this.bargeInSpeechStreak,
                        ...(this.logContext ?? {}),
                    }, 'demo-shop speakerphone: skip near-silent barge handoff startSpeech');
                }
                else {
                log_1.log.info({
                    event: 'stt_barge_in_handoff',
                    pre_roll_frames: this.preRollFrames.length,
                    pre_roll_ms: Math.round(this.preRollMs),
                    frame_ms: Math.round(frameMs),
                    rms: Number(stats.rms.toFixed(4)),
                    peak: Number(stats.peak.toFixed(4)),
                    streak: this.bargeInSpeechStreak,
                    ...(this.logContext ?? {}),
                }, 'barge-in handoff: entering speech after playback ended');
                this.speechFrameStreak = this.speechFramesRequired;
                this.startSpeech(stats, frameMs);
                }
            }
            // reset barge-in state for next playback segment
            this.bargeInArmed = false;
            this.bargeInSpeechStreak = 0;
            this.bargeInLastStats = { rms: 0, peak: 0 };
            this.bargeInLastFrameMs = 0;
            if (this.pipelineDiagOnPlayback) {
                this.emitPipelineDiag('playback_end');
            }
        }
    }
    // Optional defensive replay guard: drops identical frames repeated within last N frames.
    shouldDropRxFrame(pcm16) {
        if (!this.rxGuardEnabled || this.rxDedupeWindow <= 0)
            return { drop: false, sha1_10: '' };
        const pre = computeRmsAndPeak(pcm16);
        if (pre.peak < this.rxDedupeMinPeak) {
            this.recentRxHashes.length = 0;
            return { drop: false, sha1_10: sha1Hex(pcm16).slice(0, 10) };
        }
        const h = sha1Hex(pcm16);
        const h10 = h.slice(0, 10);
        const recent = this.recentRxHashes;
        for (let i = recent.length - 1, lag = 1; i >= 0 && lag <= this.rxDedupeWindow; i -= 1, lag += 1) {
            if (recent[i] === h)
                return { drop: true, sha1_10: h10, matchedLag: lag };
        }
        recent.push(h);
        if (recent.length > this.rxDedupeWindow)
            recent.shift();
        return { drop: false, sha1_10: h10 };
    }
    forensicsCallId() {
        const v = this.logContext?.call_control_id;
        return typeof v === 'string' && v.trim() !== '' ? v : undefined;
    }
    writeWhisperTranscriptForensics(utteranceId, rawWhisper, normalized, kind) {
        const cc = this.forensicsCallId();
        if (!cc || !utteranceId)
            return;
        const sess = (0, audioForensics_1.getForensicsSession)(cc);
        if (!sess)
            return;
        void sess.writeText(`transcripts/007a_whisper_text_${utteranceId}.txt`, rawWhisper).catch(() => undefined);
        void sess.writeText(`transcripts/007_normalized_transcript_${utteranceId}.txt`, normalized).catch(() => undefined);
        void (0, audioForensics_1.forensicsTimeline)(cc, {
            event: kind === 'partial' ? 'transcript_partial' : 'transcript_final',
            utteranceId,
            wallClockMs: Date.now(),
            audioClockMs: this.sttAudioClockMs,
            normalized_len: normalized.length,
        });
    }
    recordForensicsTimeline(event, extra) {
        const id = this.forensicsCallId();
        if (!id)
            return;
        const ctx = this.getPipelineDiagContext?.() ?? {};
        void (0, audioForensics_1.forensicsTimeline)(id, {
            event,
            wallClockMs: Date.now(),
            audioClockMs: this.sttAudioClockMs,
            playbackActive: ctx.playback_flag_active ?? null,
            listening: ctx.session_state === 'LISTENING',
            state: ctx.session_state ?? null,
            utteranceId: this.activeForensicsUtteranceId,
            ...extra,
        });
    }
    maybeFlushPostPlaybackGraceBuffer() {
        if (!env_1.env.STT_CAPTURE_DURING_POST_PLAYBACK_GRACE)
            return;
        if (this.postPlaybackGraceBuffer.length === 0)
            return;
        if (this.playbackGateActive())
            return;
        const frames = this.postPlaybackGraceBuffer.splice(0);
        this.postPlaybackGraceBufferMs = 0;
        this.recordForensicsTimeline('post_playback_grace_buffer_flushed', { frames: frames.length });
        const echoTailMs = env_1.env.STT_POST_PLAYBACK_ECHO_TAIL_MS;
        const mode = (0, echoSuppression_1.getEchoSuppressionMode)();
        const skipEnergyGate = mode === 'permissive';
        let maxRms = 0;
        for (const f of frames) {
            if (f.rms > maxRms)
                maxRms = f.rms;
        }
        const floorRms = this.getEffectiveRmsFloor();
        const floorPeak = this.getEffectivePeakFloor();
        const mult = (0, echoSuppression_1.postPlaybackEchoEnergyMultiplier)();
        let cumMs = 0;
        for (const f of frames) {
            cumMs += f.frameMs;
            const inEchoTail = echoTailMs > 0 && cumMs <= echoTailMs;
            let release = true;
            if (!skipEnergyGate && inEchoTail) {
                const minRms = Math.max(floorRms * mult, maxRms * 0.28);
                const minPeak = floorPeak * mult * 0.9;
                const energyOk = f.rms >= minRms && f.peak >= minPeak;
                if (!energyOk) {
                    release = false;
                    this.recordForensicsTimeline('post_playback_frame_dropped', {
                        reason: 'echo_tail_low_energy',
                        rms: f.rms,
                        peak: f.peak,
                        frame_ms: f.frameMs,
                        cum_ms: cumMs,
                        min_rms: minRms,
                        min_peak: minPeak,
                        max_rms_in_buffer: maxRms,
                        echo_suppression_mode: mode,
                    });
                }
            }
            if (release) {
                this.recordForensicsTimeline('post_playback_frame_released', {
                    rms: f.rms,
                    peak: f.peak,
                    frame_ms: f.frameMs,
                    cum_ms: cumMs,
                    energy_gated: !skipEnergyGate && inEchoTail,
                });
                this.enqueueIngestDecodedPcm16(f.buf, f.frameMs, { bypassPlaybackGate: true });
            }
        }
    }
    // Post-decode path (PCM16LE mono @ this.sampleRate)
    async ingestDecodedPcm16(pcm16, frameMs, opts) {
        this.lastFrameAtMs = this.nowMs();
        this.handlePlaybackTransitionIfNeeded();
        const gateNow = this.playbackGateActive();
        if (this.lastForensicsGateRecorded === null) {
            this.lastForensicsGateRecorded = gateNow;
        }
        else if (this.lastForensicsGateRecorded !== gateNow) {
            this.recordForensicsTimeline(gateNow ? 'playback_gate_active' : 'playback_gate_released', {
                listening: this.isListening?.() ?? null,
                active_playback: !!this.isPlaybackActive?.(),
            });
            this.lastForensicsGateRecorded = gateNow;
        }
        if (this.isCallActive?.()) {
            this.callInactiveAtMs = 0;
        }
        this.lastFrameMs = frameMs;
        if (!this.disableGates && this.playbackEndedAtMs > 0) {
            const graceMs = this.getPostPlaybackGraceMs?.() ?? this.postPlaybackGraceMs;
            const since = this.nowMs() - this.playbackEndedAtMs;
            if (since >= graceMs)
                this.playbackEndedAtMs = 0;
        }
        this.maybeFlushPostPlaybackGraceBuffer();
        // VERA_DEMO_SHOP_SPEAKERPHONE_20260905 — loud clear speech flushes post-playback grace immediately (before buffer early-return)
        if (this.demoShopSpeakerphoneProtect && this.playbackEndedAtMs > 0 && !this.isPlaybackActive?.()) {
            const loudStats = computeRmsAndPeak(pcm16);
            if (loudStats.rms >= 0.05) {
                const sinceEnd = this.nowMs() - this.playbackEndedAtMs;
                this.playbackEndedAtMs = 0;
                if (this.postPlaybackGraceBuffer.length > 0) {
                    this.maybeFlushPostPlaybackGraceBuffer();
                    this.postPlaybackGraceBuffer = [];
                    this.postPlaybackGraceBufferMs = 0;
                }
                log_1.log.info({
                    event: 'stt_post_playback_grace_flushed_loud_speech',
                    rms: Number(loudStats.rms.toFixed(4)),
                    peak: Number(loudStats.peak.toFixed(4)),
                    ms_since_playback_ended: Math.round(sinceEnd),
                    ...(this.logContext ?? {}),
                }, 'demo-shop speakerphone: flush post-playback grace on loud speech');
            }
        }
        const graceBufferActive = env_1.env.STT_CAPTURE_DURING_POST_PLAYBACK_GRACE &&
            !opts?.bypassPlaybackGate &&
            this.playbackGateActive() &&
            !this.isPlaybackActive?.();
        if (graceBufferActive) {
            if (this.postPlaybackGraceBufferMs + frameMs <= env_1.env.STT_PLAYBACK_GRACE_BUFFER_MAX_MS) {
                const st = computeRmsAndPeak(pcm16);
                this.postPlaybackGraceBuffer.push({
                    buf: Buffer.from(pcm16),
                    frameMs,
                    rms: st.rms,
                    peak: st.peak,
                });
                this.postPlaybackGraceBufferMs += frameMs;
                this.recordForensicsTimeline('post_playback_frame_buffered', {
                    frameMs,
                    grace_buffer_ms: this.postPlaybackGraceBufferMs,
                    rms: st.rms,
                    peak: st.peak,
                    grace_buffered: true,
                });
                return;
            }
        }
        this.onFrameForPreRoll?.(pcm16, frameMs);
        // ===== HARD GATE during playback (and brief grace after) =====
        // IMPORTANT: We still run VAD/speech detection during playback so barge-in works.
        // We only block *buffering/transcription* during playback/grace.
        const gatedForPlayback = opts?.bypassPlaybackGate ? false : this.playbackGateActive();
        // ===== Replay guard here (before any VAD/state) =====
        // Goal:
        // - If playback-gated: skip RX guard & counters (we return later anyway)
        // - If RX guard enabled: drop frames repeated within last N frames
        // - Always advance rxFramesKept for non-gated frames so log throttles behave
        if (!gatedForPlayback) {
            if (this.rxGuardEnabled) {
                const guard = this.shouldDropRxFrame(pcm16);
                if (guard.drop) {
                    this.rxFramesDropped += 1;
                    this.recordForensicsTimeline('frame_dropped_by_rx_dedupe', {
                        frameMs,
                        sha1_10: guard.sha1_10,
                        matched_lag: guard.matchedLag,
                    });
                    if (this.rxFramesDropped <= 20 || this.rxFramesDropped % 100 === 0) {
                        log_1.log.warn({
                            event: 'stt_rx_replay_dropped',
                            matched_lag: guard.matchedLag,
                            sha1_10: guard.sha1_10,
                            dropped: this.rxFramesDropped,
                            kept: this.framesSeen,
                            rx_dedupe_window: this.rxDedupeWindow,
                            rx_dedupe_min_peak: this.rxDedupeMinPeak,
                            ...(this.logContext ?? {}),
                        }, 'dropping replayed PCM frame before ChunkedSTT buffering');
                    }
                    return; // critical: do NOT continue into VAD/buffering
                }
                // Guard enabled and frame not dropped
                this.framesSeen += 1;
            }
            else {
                // Guard disabled: still advance for log throttling / observability
                this.framesSeen += 1;
            }
            this.sttFrameIndex += 1;
            this.sttAudioClockMs += frameMs;
        }
        const stats = computeRmsAndPeak(pcm16);
        this.lastRawFrameStats = { rms: stats.rms, peak: stats.peak };
        this.updateRollingStats(stats);
        // Tier 5: Update noise floor from pre-speech frames (ambient, not gated)
        if (T5_NOISE_FLOOR_ENABLED && !gatedForPlayback && !this.inSpeech) {
            const alpha = T5_NOISE_FLOOR_ALPHA;
            this.noiseFloorSampleCount += 1;
            if (this.noiseFloorSampleCount >= T5_NOISE_FLOOR_MIN_SAMPLES) {
                this.noiseFloorRms =
                    this.noiseFloorRms === 0
                        ? stats.rms
                        : this.noiseFloorRms * (1 - alpha) + stats.rms * alpha;
                this.noiseFloorPeak =
                    this.noiseFloorPeak === 0
                        ? stats.peak
                        : this.noiseFloorPeak * (1 - alpha) + stats.peak * alpha;
            }
        }
        // Tier 5: Adaptive floors when noise floor is available
        const effectiveRmsFloor = this.getEffectiveRmsFloor();
        const effectivePeakFloor = this.getEffectivePeakFloor();
        // === VAD: speech decision ===
        if (this.vadEnabled && this.vadReady && this.vad) {
            const pcmForVad = this.sampleRate === 16000
                ? pcm16
                : this.sampleRate === 8000
                    ? upsamplePcm16le8kTo16kLinear(pcm16)
                    : null;
            if (pcmForVad) {
                const res = await this.vad.pushPcm16le16k(pcmForVad);
                if (res) {
                    this.vadSpeechNow = !!res.isSpeech;
                    if (res.isSpeech) {
                        this.vadSpeechStreak += 1;
                        this.vadSilenceStreak = 0;
                    }
                    else {
                        this.vadSilenceStreak += 1;
                        this.vadSpeechStreak = 0;
                    }
                }
            }
        }
        let vadSpeechDecision = null;
        if (this.vadEnabled && this.vadReady && this.vad) {
            if (this.vadSpeechStreak >= this.vadSpeechFramesRequired)
                vadSpeechDecision = true;
            else if (this.vadSilenceStreak >= this.vadSilenceFramesRequired)
                vadSpeechDecision = false;
            else
                vadSpeechDecision = this.vadSpeechNow;
        }
        const speechDec = this.computeFrameSpeechDecision(stats, effectiveRmsFloor, effectivePeakFloor, vadSpeechDecision);
        const { gateRms, gatePeak, isSpeech, usedRollingOrPath } = speechDec;
        if (isSpeech && !gatedForPlayback) {
            this.sawSpeech = true;
            this.sawSpeechEver = true;
        }
        if (this.finalizingStop && !isSpeech) {
            this.finalizingStopSpeechStreak = 0;
        }
        // ===== BARGE-IN ON =====
        // During playback/grace:
        // - keep rolling stats
        // - detect speech and arm barge-in
        // - once armed, buffer ONLY post-arm frames as pre-roll for handoff
        if (gatedForPlayback) {
            // Track stats for potential handoff
            this.bargeInLastStats = { rms: stats.rms, peak: stats.peak };
            this.bargeInLastFrameMs = frameMs;
            if (isSpeech) {
                // VERA_DEMO_SHOP_BARGE_SUSTAIN_20260906 — residual below 0.032 must not build barge streak
                if (this.demoShopSpeakerphoneProtect && Number(stats.rms) < 0.032) {
                    this.bargeInSpeechStreak = Math.max(0, this.bargeInSpeechStreak - 1);
                }
                else {
                    this.bargeInSpeechStreak += 1;
                }
                const sustainMs = this.bargeInSpeechStreak * frameMs;
                const inEarlyWindow = this.demoShopSpeakerphoneProtect &&
                    this.playbackStartedAtMs > 0 &&
                    (this.nowMs() - this.playbackStartedAtMs) < 500;
                // VERA_DEMO_SHOP_BARGEKEEP_20260907 — buffer AEC near-end during sustain so
                // "Tuesday at—" is not discarded. Skip the first 500ms of her clip (echo).
                if (this.demoShopSpeakerphoneProtect && !inEarlyWindow && Number(stats.rms) >= 0.032) {
                    this.addPreRollFrame(pcm16, frameMs);
                }
                const demoShopSustainReady = !this.demoShopSpeakerphoneProtect ||
                    (sustainMs >= 280 && Number(stats.rms) >= 0.032);
                // Arm once we’ve seen enough consecutive speech frames
                if (!this.bargeInArmed && this.bargeInSpeechStreak >= this.speechFramesRequired && demoShopSustainReady) {
                    // VERA_DEMO_SHOP_SPEAKERPHONE_20260905 — do not arm/fire barge in first 500ms of playback
                    if (this.demoShopSpeakerphoneProtect &&
                        this.playbackStartedAtMs > 0 &&
                        (this.nowMs() - this.playbackStartedAtMs) < 500) {
                        if (!this._demoShopEarlyBargeSuppressLogged) {
                            this._demoShopEarlyBargeSuppressLogged = true;
                            log_1.log.info({
                                event: 'stt_barge_in_suppressed_early_window',
                                rms: Number(stats.rms.toFixed(4)),
                                peak: Number(stats.peak.toFixed(4)),
                                frame_ms: Math.round(frameMs),
                                streak: this.bargeInSpeechStreak,
                                sustain_ms: Math.round(sustainMs),
                                ms_since_playback_started: Math.round(this.nowMs() - this.playbackStartedAtMs),
                                ...(this.logContext ?? {}),
                            }, 'demo-shop speakerphone: suppress early barge arm/fire');
                        }
                        // hold streak but do not arm yet
                    }
                    else {
                    this.bargeInArmed = true;
                    // VERA_DEMO_SHOP_BARGEKEEP_20260907 — keep sustain lead-in for Whisper
                    if (!this.demoShopSpeakerphoneProtect) {
                        this.preRollFrames = [];
                        this.preRollMs = 0;
                    }
                    log_1.log.info({
                        event: 'stt_barge_in_detected',
                        marker: this.demoShopSpeakerphoneProtect ? 'VERA_DEMO_SHOP_DUPLEX_20260907' : undefined,
                        rms: Number(stats.rms.toFixed(4)),
                        peak: Number(stats.peak.toFixed(4)),
                        frame_ms: Math.round(frameMs),
                        streak: this.bargeInSpeechStreak,
                        sustain_ms: Math.round(this.bargeInSpeechStreak * frameMs),
                        sustain_threshold_ms: this.demoShopSpeakerphoneProtect ? 280 : undefined,
                        pre_roll_ms: Math.round(this.preRollMs),
                        ...(this.logContext ?? {}),
                    }, 'barge-in detected during playback (armed)');
                    this.onBargeInDetected?.({
                        rms: stats.rms,
                        peak: stats.peak,
                        frameMs,
                        streak: this.bargeInSpeechStreak,
                        duringPlayback: true,
                    });
                    // Don’t let any in-flight STT “win” during a barge-in
                    if (this.inFlight)
                        this.abortInFlight('barge_in');
                    }
                }
                // Once armed, buffer user lead-in (non-demo-shop). Demo Shop already
                // buffered AEC near-end during sustain (BARGEKEEP).
                if (this.bargeInArmed && !this.demoShopSpeakerphoneProtect) {
                    this.addPreRollFrame(pcm16, frameMs);
                }
            }
            else {
                // Speech flicker during playback: decay instead of hard reset (more reliable)
                this.bargeInSpeechStreak = Math.max(0, this.bargeInSpeechStreak - 1);
                if (this.demoShopSpeakerphoneProtect && this.bargeInSpeechStreak === 0 && !this.bargeInArmed) {
                    this.preRollFrames = [];
                    this.preRollMs = 0;
                }
                // Non-demo-shop: do not buffer pre-roll until armed (assistant leakage).
            }
            this.recordForensicsTimeline('frame_dropped_by_playback_gate', {
                frameMs,
                active_playback: !!this.isPlaybackActive?.(),
                is_speech: isSpeech,
                barge_in_armed: this.bargeInArmed,
            });
            return;
        }
        if (!gatedForPlayback && this.isListening?.() && (gateRms || gatePeak || isSpeech)) {
            this.onSttListeningGateActivity?.({
                gate_rms: gateRms,
                gate_peak: gatePeak,
                is_speech: isSpeech,
            });
        }
        if (!this.disableGates && (this.framesSeen <= 20 || this.framesSeen % 100 === 0)) {
            log_1.log.info({
                event: 'stt_speech_decision',
                is_speech: isSpeech,
                vad_enabled: this.vadEnabled && this.vadReady,
                vad_raw: this.vadSpeechNow,
                vad_speech_streak: this.vadSpeechStreak,
                vad_silence_streak: this.vadSilenceStreak,
                vad_speech_req: this.vadSpeechFramesRequired,
                vad_silence_req: this.vadSilenceFramesRequired,
                vad_decision: vadSpeechDecision,
                gate_rms: gateRms,
                gate_peak: gatePeak,
                rolling_or_path: usedRollingOrPath,
                rms: stats.rms,
                peak: stats.peak,
                energy_ste: Number(steFromRms(stats.rms).toFixed(10)),
                rms_dbfs: Number(amplitudeToDbfs(stats.rms).toFixed(2)),
                peak_dbfs: Number(amplitudeToDbfs(stats.peak).toFixed(2)),
                ...(this.logContext ?? {}),
            }, 'stt speech decision');
        }
        // Barge-in: if final request is in-flight and speech resumes, abort and reset.
        // VERA_DEMO_SHOP_LISTENFINAL_20260905 — while LISTENING (not playback), complete the
        // in-flight Whisper final instead of abort→discard. Playback barge still aborts above.
        if (this.inFlight && this.inFlightKind === 'final' && isSpeech) {
            if (this.demoShopSpeakerphoneProtect) {
                if (!this._demoShopListenFinalKeepLogged) {
                    this._demoShopListenFinalKeepLogged = true;
                    log_1.log.info({
                        event: 'stt_abort_final_ignored_listening',
                        reason: 'complete_or_queue',
                        in_flight_kind: this.inFlightKind,
                        playback_gated: false,
                        is_listening: !!this.isListening?.(),
                        ...(this.logContext ?? {}),
                    }, 'demo-shop: keep in-flight Whisper final during listening speech');
                }
            }
            else if (this.finalizingStop) {
                const now = this.nowMs();
                const elapsed = now - this.finalizingStopAtMs;
                if (elapsed < FINAL_STOP_ABORT_GRACE_MS) {
                    this.finalizingStopIgnoreCount += 1;
                    if (this.finalizingStopIgnoreCount <= 3 || this.finalizingStopIgnoreCount % 50 === 0) {
                        log_1.log.info({
                            event: 'stt_abort_final_ignored_during_stop',
                            reason: 'within_grace',
                            elapsed_ms: Math.round(elapsed),
                            streak: this.finalizingStopSpeechStreak,
                            frames_required: this.speechFramesRequired,
                            ...(this.logContext ?? {}),
                        }, 'ignoring final abort during stop grace');
                    }
                }
                else {
                    this.finalizingStopSpeechStreak += 1;
                    if (this.finalizingStopSpeechStreak >= this.speechFramesRequired) {
                        this.finalizingStop = false;
                        this.finalizingStopAtMs = 0;
                        this.finalizingStopSpeechStreak = 0;
                        this.finalizingStopIgnoreCount = 0;
                        this.abortInFlight('barge_in');
                        this.resetUtteranceState();
                        return;
                    }
                    this.finalizingStopIgnoreCount += 1;
                    if (this.finalizingStopIgnoreCount <= 3 || this.finalizingStopIgnoreCount % 50 === 0) {
                        log_1.log.info({
                            event: 'stt_abort_final_ignored_during_stop',
                            reason: 'awaiting_streak',
                            elapsed_ms: Math.round(elapsed),
                            streak: this.finalizingStopSpeechStreak,
                            frames_required: this.speechFramesRequired,
                            ...(this.logContext ?? {}),
                        }, 'ignoring final abort during stop (waiting for new utterance)');
                    }
                }
            }
            else {
                this.abortInFlight('barge_in');
                this.resetUtteranceState();
                return;
            }
        }
        // Not in speech yet: build pre-roll and detect start
        if (!this.inSpeech) {
            this.addPreRollFrame(pcm16, frameMs);
            if (isSpeech) {
                if (gateRms)
                    this.preSpeechFramesRms += 1;
                if (gatePeak)
                    this.preSpeechFramesPeak += 1;
                if (gateRms && gatePeak)
                    this.preSpeechFramesBoth += 1;
                if (usedRollingOrPath)
                    this.preSpeechFramesOrPath += 1;
                this.silenceFrameStreak = 0;
                this.silenceToFinalizeTimer = undefined;
                this.speechFrameStreak += 1;
                this.peakPreUtteranceStreak = Math.max(this.peakPreUtteranceStreak, this.speechFrameStreak);
                if (!this.candidateStartEmitted && this.speechFrameStreak === 1) {
                    this.candidateStartEmitted = true;
                    log_1.log.info({
                        event: 'stt_candidate_started',
                        speech_frames_required: this.speechFramesRequired,
                        rms: Number(stats.rms.toFixed(5)),
                        peak: Number(stats.peak.toFixed(5)),
                        effective_rms_floor: Number(effectiveRmsFloor.toFixed(5)),
                        effective_peak_floor: Number(effectivePeakFloor.toFixed(5)),
                        gate_rms: gateRms,
                        gate_peak: gatePeak,
                        rolling_or_path: usedRollingOrPath,
                        ...(this.logContext ?? {}),
                    }, 'stt gate candidate started');
                }
            }
            else {
                const partialEnergy = gateRms || gatePeak;
                if (partialEnergy && this.speechFrameStreak > 0) {
                    this.speechFrameStreak = Math.max(0, this.speechFrameStreak - this.speechStreakPartialDecay);
                    this.peakPreUtteranceStreak = Math.max(this.peakPreUtteranceStreak, this.speechFrameStreak);
                }
                else if (!partialEnergy) {
                    // VERA_DEMO_SHOP_LISTENOPEN_20260907 — one below-floor frame must not wipe a started candidate
                    if (this.demoShopSpeakerphoneProtect && this.speechFrameStreak > 0) {
                        this.speechFrameStreak = Math.max(0, this.speechFrameStreak - 1);
                        if (this.speechFrameStreak === 0)
                            this.maybeEmitCandidateDropped('silence_reset', stats, speechDec);
                    }
                    else {
                        this.maybeEmitCandidateDropped('silence_reset', stats, speechDec);
                        this.speechFrameStreak = 0;
                    }
                }
                else {
                    this.speechFrameStreak = 0;
                }
            }
            if (isSpeech && this.speechFrameStreak >= this.speechFramesRequired) {
                this.startSpeech(stats, frameMs);
            }
            else if (!this.disableGates) {
                const reason = this.resolveGateClosedReason(gateRms, gatePeak, this.speechFrameStreak);
                if (reason)
                    this.maybeLogGateClosed(reason, stats, frameMs);
            }
            return;
        }
        // In speech: append frames and decide when to finalize
        this.appendUtterance(pcm16, frameMs);
        if (isSpeech) {
            this.lastSpeechAt = this.nowMs();
            this.silenceFrameStreak = 0;
            this.silenceToFinalizeTimer = undefined;
        }
        else {
            if (this.silenceFrameStreak === 0) {
                this.silenceToFinalizeTimer = (0, metrics_1.startStageTimer)('stt_silence_to_finalize_ms', this.tenantLabel);
            }
            this.silenceFrameStreak += 1;
            // ============================================================================
            // TIER_1_DYNAMIC_ENDPOINTING (DROP-IN)
            // - dynamic trailing-silence requirement based on utterance length + rolling RMS
            // - prevents truncation and “never finalize” in noisier environments
            //
            // Requires these helper functions to exist in this file (top-level):
            //   - t1ComputeDynamicSilenceMs({ speechMs, avgRms, baselineMs })
            //   - t1HasEnoughSpeech({ speechMs, speechBytes })
            // (If you used the earlier helper block, you're good.)
            // ============================================================================
            const speechMs = Math.max(0, this.utteranceMs - this.lastPrependedMs);
            const speechBytes = this.utteranceBytes;
            // utteranceMs includes pre-roll; that's OK (we're only deciding how long to wait after last speech)
            const avgRms = this.rollingRms; // already updated each frame via updateRollingStats()
            const dynamicSilenceMs = t1ComputeDynamicSilenceMs({ speechMs, avgRms, baselineMs: this.silenceEndMs });
            const silenceMsSoFar = this.silenceFrameStreak * frameMs;
            const okToFinalize = t1HasEnoughSpeech({ speechMs, speechBytes });
            if (okToFinalize && silenceMsSoFar >= dynamicSilenceMs) {
                this.silenceToFinalizeTimer?.();
                this.silenceToFinalizeTimer = undefined;
                log_1.log.info({
                    event: 'stt_dynamic_finalize',
                    reason: 'silence_dynamic',
                    speech_ms: Math.round(speechMs),
                    speech_bytes: speechBytes,
                    silence_ms: Math.round(silenceMsSoFar),
                    dynamic_silence_ms: Math.round(dynamicSilenceMs),
                    rolling_rms: Number(this.rollingRms.toFixed(4)),
                    rolling_peak: Number(this.rollingPeak.toFixed(4)),
                    silence_end_ms: this.silenceEndMs,
                    ...(this.logContext ?? {}),
                }, 'stt dynamic finalize (tier1)');
                this.finalizeUtterance('silence');
                return;
            }
        }
        if (this.utteranceMs >= this.maxUtteranceMs) {
            // VERA_DEMO_SHOP_PERSONEND_20260907 — do not guess a talk-time. End the
            // turn when the person stops (silenceEndMs). 60s is only a runaway fuse.
            if (this.demoShopSpeakerphoneProtect) {
                const frameMsNow = Number(frameMs) > 0 ? Number(frameMs) : 20;
                const silenceMs = (this.silenceFrameStreak || 0) * frameMsNow;
                const needSilence = Number(this.silenceEndMs) > 0 ? Number(this.silenceEndMs) : 550;
                const personStillInTurn = silenceMs < needSilence;
                const fuseMs = 60000;
                if (personStillInTurn && this.utteranceMs < fuseMs) {
                    if (!this._demoShopMaxUttDeferredLogged) {
                        this._demoShopMaxUttDeferredLogged = true;
                        log_1.log.info({
                            event: 'demo_shop_max_utt_deferred',
                            marker: 'VERA_DEMO_SHOP_PERSONEND_20260907',
                            utterance_ms: Math.round(this.utteranceMs),
                            max_utt_ms: this.maxUtteranceMs,
                            silence_ms: Math.round(silenceMs),
                            silence_end_ms: needSilence,
                            ...(this.logContext ?? {}),
                        }, 'demo shop waiting for caller to stop (not cutting on a time cap)');
                    }
                    return;
                }
            }
            this.finalizeUtterance('max');
            return;
        }
    }
    async stop(options = {}) {
        this.ingestToken += 1;
        const chain = this.ingestChain;
        this.ingestChain = Promise.resolve();
        if (this.timer)
            clearInterval(this.timer);
        this.timer = undefined;
        if (this.noFrameCheckTimer) {
            clearInterval(this.noFrameCheckTimer);
            this.noFrameCheckTimer = undefined;
        }
        if (this.pipelineDiagTimer) {
            clearInterval(this.pipelineDiagTimer);
            this.pipelineDiagTimer = undefined;
        }
        try {
            await chain;
        }
        catch { /* ignore */ }
        const allowFinal = options.allowFinal ?? true;
        const preserveInFlightFinal = options.preserveInFlightFinal ?? false;
        let queuedFinal = false;
        if (allowFinal && this.inSpeech && this.utteranceBytes > 0) {
            // finalizeUtterance('stop') will enqueue a final if it passes fallback checks
            this.flushIfReady('stop');
            queuedFinal = true;
        }
        // If we just queued a final, DO NOT abort it.
        // Only abort if nothing was queued and we’re just shutting down.
        if (!queuedFinal) {
            if (!(preserveInFlightFinal && this.inFlight && this.inFlightKind === 'final')) {
                this.abortInFlight('finalize');
            }
        }
        // If playback/grace gate is active, don't wipe buffered speech here.
        // finalizeUtterance() will refuse to send during gate; wiping here loses the last utterance.
        const gated = this.playbackGateActive();
        if (!gated) {
            this.resetUtteranceState();
        }
        this.bargeInArmed = false;
        this.bargeInSpeechStreak = 0;
        this.bargeInLastStats = { rms: 0, peak: 0 };
        this.bargeInLastFrameMs = 0;
        this.playbackWasActive = false;
        this.playbackEndedAtMs = 0;
    }
    flushIfReady(reason) {
        // Interval is only for partials; finalization still happens via silence/max/stop.
        if (reason === 'interval') {
            const partialsEnabled = parseBool(process.env.STT_PARTIALS_ENABLED, false);
            if (!partialsEnabled)
                return;
            return void this.maybeSendPartial();
        }
        if (reason === 'stop')
            return void this.finalizeUtterance('stop');
        this.finalizeUtterance('silence');
    }
    addPreRollFrame(pcm16, frameMs) {
        if (this.preRollMaxMs <= 0)
            return;
        const snap = Buffer.from(pcm16);
        this.preRollFrames.push({ buffer: snap, ms: frameMs });
        this.preRollMs += frameMs;
        while (this.preRollMs > this.preRollMaxMs && this.preRollFrames.length > 0) {
            const dropped = this.preRollFrames.shift();
            if (!dropped)
                break;
            this.preRollMs -= dropped.ms;
        }
    }
    startSpeech(stats, frameMs) {
        log_1.log.info({
            event: 'stt_gate_summary_per_utterance',
            frames_gate_rms: this.preSpeechFramesRms,
            frames_gate_peak: this.preSpeechFramesPeak,
            frames_both_gates: this.preSpeechFramesBoth,
            frames_rolling_or_path: this.preSpeechFramesOrPath,
            peak_pre_utterance_streak: this.peakPreUtteranceStreak,
            speech_frames_required: this.speechFramesRequired,
            rms_floor: this.speechRmsFloor,
            peak_floor: this.speechPeakFloor,
            effective_rms_floor: Number(this.getEffectiveRmsFloor().toFixed(5)),
            effective_peak_floor: Number(this.getEffectivePeakFloor().toFixed(5)),
            ...(this.logContext ?? {}),
        }, 'stt gate summary for accepted utterance');
        this.resetPreUtteranceGateCounters();
        this.forensicsUtteranceSeq += 1;
        this.activeForensicsUtteranceId = `utt-${this.forensicsUtteranceSeq}`;
        this.recordForensicsTimeline('vad_speech_start', {
            frameMs,
            rms: stats.rms,
            peak: stats.peak,
        });
        this.inSpeech = true;
        this.speechStartAtMs = this.nowMs(); // Tier 5: late-final watchdog baseline
        this.noiseFloorSampleCount = 0; // Tier 5: reset so next utterance re-estimates noise floor
        // ✅ FIX: ensure Tier1 fallback finalize logic knows we truly saw speech
        // (prevents stop/max from skipping finalize when speech started and ended quickly)
        this.sawSpeech = true;
        this.sawSpeechEver = true;
        this.lastSpeechAt = this.nowMs();
        this.silenceFrameStreak = 0;
        this.silenceToFinalizeTimer = undefined;
        let selectedFrames = this.preRollFrames;
        let selectedMs = this.preRollMs;
        const external = this.consumePreRoll?.();
        if (external && external.frames.length > 0 && external.sampleRateHz === this.sampleRate) {
            selectedFrames = external.frames;
            selectedMs = external.totalMs;
        }
        const prependedMs = selectedMs;
        const prependedFrames = selectedFrames.length;
        this.lastPrependedMs = prependedMs;
        this.utteranceFrames = [...selectedFrames];
        this.utteranceMs = selectedMs;
        this.utteranceBytes = this.utteranceFrames.reduce((sum, f) => sum + f.buffer.length, 0);
        this.preRollFrames = [];
        this.preRollMs = 0;
        this.lastPartialAt = 0;
        this.lastPartialTranscript = '';
        this.finalFlushAt = 0;
        this.finalTranscriptAccepted = false;
        log_1.log.info({
            event: 'stt_utterance_start',
            prepended_ms: Math.round(prependedMs),
            preroll_frames: prependedFrames,
            sample_rate_hz: this.sampleRate,
            ts: this.nowMs(),
            ...(this.logContext ?? {}),
        }, 'stt utterance start');
        this.recordForensicsTimeline('utterance_started', {
            prepended_ms: Math.round(prependedMs),
            preroll_frames: prependedFrames,
        });
        this.onSpeechStart?.({
            rms: stats.rms,
            peak: stats.peak,
            frameMs,
            streak: this.speechFrameStreak,
            prependedMs: Math.round(prependedMs),
        });
        log_1.log.info({
            event: 'stt_speech_start',
            speech_rms: Number(stats.rms.toFixed(4)),
            speech_peak: Number(stats.peak.toFixed(4)),
            frame_ms: Math.round(frameMs),
            ...(this.logContext ?? {}),
        }, 'stt speech start');
    }
    appendUtterance(pcm16, frameMs) {
        const snap = Buffer.from(pcm16);
        this.utteranceFrames.push({ buffer: snap, ms: frameMs });
        this.utteranceMs += frameMs;
        this.utteranceBytes += snap.length;
    }
    trimTrailingSilence(frames) {
        if (frames.length === 0)
            return frames;
        let lastSpeechIndex = -1;
        for (let i = frames.length - 1; i >= 0; i -= 1) {
            const stats = computeRmsAndPeak(frames[i].buffer);
            if (stats.rms >= this.speechRmsFloor && stats.peak >= this.speechPeakFloor) {
                lastSpeechIndex = i;
                break;
            }
        }
        if (lastSpeechIndex === -1)
            return frames;
        let endIndex = lastSpeechIndex;
        let tailMs = 0;
        for (let i = lastSpeechIndex + 1; i < frames.length; i += 1) {
            tailMs += frames[i].ms;
            endIndex = i;
            if (tailMs >= this.finalTailCushionMs)
                break;
        }
        if (endIndex >= frames.length - 1)
            return frames;
        return frames.slice(0, endIndex + 1);
    }
    maybeSendPartial() {
        if (!this.inSpeech)
            return;
        if (this.inFlight)
            return;
        // ✅ NEW: never send partials during playback/grace
        this.handlePlaybackTransitionIfNeeded();
        if (this.playbackGateActive())
            return;
        if (this.utteranceMs < this.minSpeechMs)
            return;
        const now = this.nowMs();
        if (this.lastPartialAt > 0 && now - this.lastPartialAt < this.partialIntervalMs)
            return;
        const payload = this.concatFrames(this.utteranceFrames);
        if (payload.length < this.partialMinBytes)
            return;
        this.lastPartialAt = now;
        this.enqueueTranscription(payload, { reason: 'partial', isFinal: false });
    }
    finalizeUtterance(reason) {
        // ============================================================================
        // TIER_1_DYNAMIC_ENDPOINTING (ANCHOR FALLBACK)
        // If stop/max happens, only finalize if we have enough real speech.
        // Otherwise skip finalizing and reset state (prevents garbage finals).
        // ============================================================================
        if (reason === 'stop' || reason === 'max') {
            const totalMs = this.utteranceMs;
            const totalBytes = this.utteranceBytes;
            const enough = t1ShouldFallbackFinalize({
                totalMs,
                totalBytes,
                sawSpeech: this.sawSpeech,
            });
            if (!enough) {
                log_1.log.info({
                    event: 'stt_finalize_fallback_skipped',
                    reason,
                    total_ms: Math.round(totalMs),
                    total_bytes: totalBytes,
                    ...(this.logContext ?? {}),
                }, 'stt finalize fallback skipped (tier1)');
                this.resetUtteranceState();
                return;
            }
            log_1.log.info({
                event: 'stt_finalize_fallback',
                reason,
                total_ms: Math.round(totalMs),
                total_bytes: totalBytes,
                ...(this.logContext ?? {}),
            }, 'stt finalize fallback (tier1)');
        }
        if (!this.inSpeech || this.utteranceBytes === 0)
            return;
        // ✅ NEW: never finalize during playback/grace
        this.handlePlaybackTransitionIfNeeded();
        // ✅ FIX: never finalize during playback/grace
        if (this.playbackGateActive()) {
            this.maybeLogWhisperNotCalled('playback_gate_active_at_finalize', {
                utterance_bytes: this.utteranceBytes,
                utterance_ms: Math.round(this.utteranceMs),
            });
            // During playback/grace, do not finalize or send STT.
            // Keep buffering state so we can finalize once gate clears.
            return;
        }
        if (this.finalFlushAt === 0) {
            this.finalFlushAt = this.nowMs();
            if (reason === 'silence' && this.lastSpeechAt > 0) {
                (0, metrics_1.observeStageDuration)('pre_stt_gate', this.tenantLabel, this.nowMs() - this.lastSpeechAt);
            }
        }
        if (this.inFlight) {
            if (this.inFlightKind === 'final')
                return;
            this.abortInFlight('finalize');
        }
        const trimmedFrames = this.trimTrailingSilence(this.utteranceFrames);
        const payload = this.concatFrames(trimmedFrames);
        log_1.log.info({
            event: 'stt_finalize_payload_stats',
            reason,
            frames: trimmedFrames.length,
            utterance_ms: Math.round((payload.length / this.bytesPerSecondPcm16) * 1000),
            bytes: payload.length,
            silence_end_ms: this.silenceEndMs,
            min_speech_ms: this.minSpeechMs,
            final_min_bytes: this.finalMinBytes,
            ...(this.logContext ?? {}),
        }, 'finalizing utterance payload');
        const utteranceTotalMs = Math.max(0, Math.round(this.utteranceMs));
        const preRollMs = Math.max(0, Math.round(this.lastPrependedMs));
        const frameMs = this.lastFrameMs > 0 ? this.lastFrameMs : this.fallbackFrameMs;
        const trailingSilenceMs = Math.max(0, Math.round(Math.min(this.utteranceMs, this.silenceFrameStreak * frameMs)));
        const speechMs = Math.max(0, Math.round(this.utteranceMs - preRollMs - trailingSilenceMs));
        this.onUtteranceEnd?.({
            preRollMs,
            utteranceMs: utteranceTotalMs,
            speechMs,
            trailingSilenceMs,
        });
        this.recordForensicsTimeline('vad_speech_end', {
            final_reason: reason,
            utterance_ms: utteranceTotalMs,
        });
        this.recordForensicsTimeline('utterance_finalized', {
            final_reason: reason,
            payload_bytes: payload.length,
            utterance_ms: utteranceTotalMs,
        });
        this.enqueueTranscription(payload, {
            reason: 'final',
            isFinal: true,
            finalReason: reason,
        });
        this.resetUtteranceState();
    }
    concatFrames(frames) {
        if (frames.length === 1)
            return frames[0].buffer;
        return Buffer.concat(frames.map((f) => f.buffer));
    }
    abortInFlight(reason) {
        if (!this.inFlight)
            return;
        const kind = this.inFlightKind;
        this.inFlightAbort?.abort();
        this.inFlightAbort = undefined;
        this.inFlight = false;
        this.inFlightKind = undefined;
        this.finalizeToResultTimer = undefined;
        this.finalFlushAt = 0;
        this.inFlightToken += 1;
        if (kind === 'final') {
            this.finalizingStop = false;
            this.finalizingStopAtMs = 0;
            this.finalizingStopSpeechStreak = 0;
            this.finalizingStopIgnoreCount = 0;
        }
        // ✅ ensure CallSession always sees the "end"
        if (kind)
            this.onSttRequestEnd?.(kind);
        if (reason === 'barge_in') {
            this.silenceFrameStreak = 0;
            this.silenceToFinalizeTimer = undefined;
        }
    }
    enqueueTranscription(payloadPcm16, meta) {
        // ✅ CALL LIFECYCLE GATE: do not enqueue STT if call is already ended/inactive
        if (this.isCallActive && !this.isCallActive()) {
            const allow = this.allowFinalDuringCallEndDrain(meta.reason);
            if (!allow) {
                log_1.log.info({
                    event: 'stt_skip_transcription_call_inactive',
                    kind: meta.reason,
                    payload_bytes: payloadPcm16.length,
                    saw_speech: this.sawSpeech,
                    drain_ms: this.callEndDrainMs,
                    inactive_at_ms: this.callInactiveAtMs,
                    now_ms: this.nowMs(),
                    ...(this.logContext ?? {}),
                }, 'skipping STT enqueue because call is inactive');
                this.maybeLogWhisperNotCalled('call_inactive', { kind: meta.reason, payload_bytes: payloadPcm16.length });
                return;
            }
            log_1.log.warn({
                event: 'stt_call_end_drain_allow',
                kind: meta.reason,
                payload_bytes: payloadPcm16.length,
                saw_speech: this.sawSpeech,
                drain_ms: this.callEndDrainMs,
                inactive_at_ms: this.callInactiveAtMs,
                now_ms: this.nowMs(),
                ...(this.logContext ?? {}),
            }, 'allowing FINAL STT during call-end drain window');
        }
        // 1) If we’re already sending something, log it (otherwise Whisper will never move)
        if (this.inFlight) {
            log_1.log.info({
                event: 'stt_enqueue_skipped_inflight',
                kind: meta.reason,
                payload_bytes: payloadPcm16.length,
                in_flight_kind: this.inFlightKind,
                ...(this.logContext ?? {}),
            }, 'stt enqueue skipped (already in-flight)');
            this.maybeLogWhisperNotCalled('stt_inflight', {
                kind: meta.reason,
                payload_bytes: payloadPcm16.length,
                in_flight_kind: this.inFlightKind,
            });
            return;
        }
        // ✅ safety net
        this.handlePlaybackTransitionIfNeeded();
        // 2) If playback gate is active, log WHY we are blocked
        if (this.playbackGateActive()) {
            log_1.log.warn({
                event: 'stt_enqueue_blocked_by_playback_gate',
                kind: meta.reason,
                payload_bytes: payloadPcm16.length,
                playback_active: !!this.isPlaybackActive?.(),
                playback_ended_at_ms: this.playbackEndedAtMs,
                post_playback_grace_ms: this.postPlaybackGraceMs,
                now_ms: this.nowMs(),
                ...(this.logContext ?? {}),
            }, 'stt enqueue blocked by playback/grace gate (NO WHISPER REQUEST WILL BE SENT)');
            this.maybeLogWhisperNotCalled('playback_gate_at_enqueue', {
                kind: meta.reason,
                payload_bytes: payloadPcm16.length,
                playback_active: !!this.isPlaybackActive?.(),
            });
            return;
        }
        // Optional but super useful: confirm we’re actually about to send
        log_1.log.info({
            event: 'stt_enqueue_start',
            kind: meta.reason,
            payload_bytes: payloadPcm16.length,
            ...(this.logContext ?? {}),
        }, 'stt enqueue starting transcription');
        if (meta.reason === 'final' && meta.finalReason === 'stop') {
            this.finalizingStop = true;
            this.finalizingStopAtMs = this.nowMs();
            this.finalizingStopSpeechStreak = 0;
            this.finalizingStopIgnoreCount = 0;
            log_1.log.info({
                event: 'stt_finalizing_stop_armed',
                ts: this.finalizingStopAtMs,
                ...(this.logContext ?? {}),
            }, 'finalizing stop armed');
        }
        this.inFlight = true;
        this.inFlightKind = meta.reason;
        this._demoShopListenFinalKeepLogged = false;
        const token = (this.inFlightToken += 1);
        this.inFlightAbort = new AbortController();
        if (meta.isFinal)
            this.finalizeToResultTimer = (0, metrics_1.startStageTimer)('stt_finalize_to_result_ms', this.tenantLabel);
        // notify CallSession if wired
        this.onSttRequestStart?.(meta.reason);
        void this.transcribePayload(payloadPcm16, meta, token, this.inFlightAbort.signal)
            .catch((err) => log_1.log.error({ event: 'stt_transcribePayload_failed', err, ...(this.logContext ?? {}) }, 'stt transcription failed'))
            .finally(() => {
            if (this.inFlightToken !== token)
                return;
            const kind = this.inFlightKind ?? meta.reason;
            this.inFlight = false;
            this.inFlightKind = undefined;
            this.inFlightAbort = undefined;
            this.finalizeToResultTimer = undefined;
            if (kind === 'final') {
                this.finalizingStop = false;
                this.finalizingStopAtMs = 0;
                this.finalizingStopSpeechStreak = 0;
                this.finalizingStopIgnoreCount = 0;
            }
            this.onSttRequestEnd?.(kind);
        });
    }
    async transcribePayload(payloadPcm16, meta, token, signal) {
        this.handlePlaybackTransitionIfNeeded();
        if (this.playbackGateActive()) {
            this.maybeLogWhisperNotCalled('playback_gate_before_http', {
                kind: meta.reason,
                payload_bytes: payloadPcm16.length,
            });
            return;
        }
        if (this.isCallActive && !this.isCallActive()) {
            if (!this.allowFinalDuringCallEndDrain(meta.reason))
                return;
        }
        if (signal.aborted)
            return;
        const startedAt = this.nowMs();
        const utteranceMs = Math.round((payloadPcm16.length / this.bytesPerSecondPcm16) * 1000);
        const audioInput = {
            audio: payloadPcm16,
            sampleRateHz: this.sampleRate,
            encoding: 'pcm16le',
            channels: 1,
        };
        // ----- partial: single attempt (unchanged policy) -----
        if (meta.reason === 'partial') {
            const endStt = (0, metrics_1.startStageTimer)('stt', this.tenantLabel);
            try {
                const result = await this.provider.transcribe(audioInput, {
                    language: this.language,
                    prompt: this.prompt,
                    isPartial: true,
                    endpointUrl: this.whisperUrl,
                    logContext: this.logContext,
                    signal,
                    utteranceId: this.activeForensicsUtteranceId ?? undefined,
                });
                endStt();
                if (token !== this.inFlightToken)
                    return;
                this.finalizeToResultTimer?.();
                this.finalizeToResultTimer = undefined;
                const rawWhisper = typeof result.text === 'string' ? result.text : '';
                const text = normalizeWhitespace(rawWhisper);
                log_1.log.info({
                    event: 'stt_transcription_result',
                    kind: 'partial',
                    elapsed_ms: this.nowMs() - startedAt,
                    text_len: text.length,
                    ...(this.logContext ?? {}),
                }, 'stt transcription result');
                this.writeWhisperTranscriptForensics(this.activeForensicsUtteranceId, rawWhisper, text, 'partial');
                if (!text) {
                    this.recordForensicsTimeline('transcript_empty', { kind: 'partial' });
                    return;
                }
                if (text === this.lastPartialTranscript)
                    return;
                this.lastPartialTranscript = text;
                if (isNonEmpty(text))
                    await Promise.resolve(this.onTranscript(text, 'partial_fallback'));
            }
            catch (error) {
                endStt();
                if (signal.aborted || isAbortError(error))
                    return;
                (0, metrics_1.incStageError)('stt', this.tenantLabel);
                throw error;
            }
            return;
        }
        // ----- final: retries for empty transcript and transient HTTP errors -----
        let emptyExtra = this.emptyFinalExtraTries;
        let errorExtra = this.finalErrorExtraTries;
        let attempts = 0;
        while (true) {
            if (signal.aborted)
                return;
            if (token !== this.inFlightToken)
                return;
            const endStt = (0, metrics_1.startStageTimer)('stt', this.tenantLabel);
            try {
                attempts += 1;
                const result = await this.provider.transcribe(audioInput, {
                    language: this.language,
                    prompt: this.prompt,
                    isPartial: false,
                    endpointUrl: this.whisperUrl,
                    logContext: this.logContext,
                    signal,
                    utteranceId: this.activeForensicsUtteranceId ?? undefined,
                });
                endStt();
                if (token !== this.inFlightToken)
                    return;
                this.finalizeToResultTimer?.();
                this.finalizeToResultTimer = undefined;
                const rawWhisper = typeof result.text === 'string' ? result.text : '';
                const text = normalizeWhitespace(rawWhisper);
                log_1.log.info({
                    event: 'stt_transcription_result',
                    kind: 'final',
                    elapsed_ms: this.nowMs() - startedAt,
                    text_len: text.length,
                    attempts,
                    ...(this.logContext ?? {}),
                }, 'stt transcription result');
                this.writeWhisperTranscriptForensics(this.activeForensicsUtteranceId, rawWhisper, text, 'final');
                if (text) {
                    this.onFinalResult?.({
                        isEmpty: false,
                        textLength: text.length,
                        utteranceMs,
                    });
                    this.onFinalPipelineOutcome?.({
                        kind: 'success',
                        text,
                        utteranceMs,
                        attempts,
                    });
                    if (!this.finalTranscriptAccepted) {
                        this.finalTranscriptAccepted = true;
                        await Promise.resolve(this.onTranscript(text, 'final'));
                    }
                    return;
                }
                if (emptyExtra > 0) {
                    emptyExtra -= 1;
                    log_1.log.warn({
                        event: 'stt_empty_final_retry',
                        attempts,
                        empty_extra_remaining: emptyExtra,
                        utterance_ms: utteranceMs,
                        ...(this.logContext ?? {}),
                    }, 'empty Whisper final; retrying same payload');
                    try {
                        await delayWithAbort(this.finalRetryBackoffMs, signal);
                    }
                    catch {
                        return;
                    }
                    continue;
                }
                this.onFinalResult?.({ isEmpty: true, textLength: 0, utteranceMs });
                this.onFinalPipelineOutcome?.({ kind: 'empty', utteranceMs, attempts });
                this.recordForensicsTimeline('transcript_empty', { kind: 'final', attempts });
                return;
            }
            catch (error) {
                endStt();
                if (signal.aborted || isAbortError(error))
                    return;
                if (errorExtra > 0 && isRetryableSttError(error)) {
                    errorExtra -= 1;
                    log_1.log.warn({
                        event: 'stt_final_retry_after_error',
                        err: error,
                        attempts,
                        error_extra_remaining: errorExtra,
                        ...(this.logContext ?? {}),
                    }, 'STT error; retrying transcribe');
                    (0, metrics_1.incStageError)('stt', this.tenantLabel);
                    try {
                        await delayWithAbort(this.finalRetryBackoffMs, signal);
                    }
                    catch {
                        return;
                    }
                    continue;
                }
                (0, metrics_1.incStageError)('stt', this.tenantLabel);
                this.finalizeToResultTimer?.();
                this.finalizeToResultTimer = undefined;
                log_1.log.error({ event: 'stt_transcription_failed_final', err: error, attempts, ...(this.logContext ?? {}) }, 'stt final transcription failed');
                this.onFinalResult?.({ isEmpty: true, textLength: 0, utteranceMs });
                this.onFinalPipelineOutcome?.({ kind: 'error', utteranceMs, attempts, error });
                return;
            }
        }
    }
    updateRollingStats(stats) {
        const alpha = 0.1;
        this.rollingRms = this.rollingRms === 0 ? stats.rms : this.rollingRms * (1 - alpha) + stats.rms * alpha;
        this.rollingPeak = this.rollingPeak === 0 ? stats.peak : this.rollingPeak * (1 - alpha) + stats.peak * alpha;
    }
    /** Tier 5: Effective RMS floor (noise-adaptive or fixed). */
    getEffectiveRmsFloor() {
        if (!T5_NOISE_FLOOR_ENABLED ||
            this.noiseFloorSampleCount < T5_NOISE_FLOOR_MIN_SAMPLES ||
            this.noiseFloorRms <= 0) {
            return this.applyEffectiveFloorCap(this.speechRmsFloor, T5_EFFECTIVE_RMS_CAP);
        }
        const adaptive = this.noiseFloorRms * T5_ADAPTIVE_RMS_MULT;
        const v = Math.max(T5_ADAPTIVE_MIN_RMS, this.speechRmsFloor, adaptive);
        return this.applyEffectiveFloorCap(v, T5_EFFECTIVE_RMS_CAP);
    }
    /** Tier 5: Effective peak floor (noise-adaptive or fixed). */
    getEffectivePeakFloor() {
        if (!T5_NOISE_FLOOR_ENABLED ||
            this.noiseFloorSampleCount < T5_NOISE_FLOOR_MIN_SAMPLES ||
            this.noiseFloorPeak <= 0) {
            return this.applyEffectiveFloorCap(this.speechPeakFloor, T5_EFFECTIVE_PEAK_CAP);
        }
        const adaptive = this.noiseFloorPeak * T5_ADAPTIVE_PEAK_MULT;
        const v = Math.max(T5_ADAPTIVE_MIN_PEAK, this.speechPeakFloor, adaptive);
        return this.applyEffectiveFloorCap(v, T5_EFFECTIVE_PEAK_CAP);
    }
    /** When cap > 0, prevents adaptive floors from exceeding PSTN-usual energy (set cap=0 to disable). */
    applyEffectiveFloorCap(v, cap) {
        if (!Number.isFinite(cap) || cap <= 0)
            return v;
        return Math.min(v, cap);
    }
    computeFrameSpeechDecision(stats, effectiveRmsFloor, effectivePeakFloor, vadSpeechDecision) {
        const rmsForGate = Math.max(stats.rms, this.rollingRms);
        const peakForGate = Math.max(stats.peak, this.rollingPeak);
        const gateRms = rmsForGate >= effectiveRmsFloor;
        const gatePeak = peakForGate >= effectivePeakFloor;
        const bothGates = gateRms && gatePeak;
        const ratioRms = rmsForGate / Math.max(effectiveRmsFloor, 1e-9);
        const ratioPeak = peakForGate / Math.max(effectivePeakFloor, 1e-9);
        if (this.disableGates) {
            return {
                gateRms: true,
                gatePeak: true,
                bothGates: true,
                usedRollingOrPath: false,
                isSpeech: true,
                ratioRms,
                ratioPeak,
            };
        }
        if (vadSpeechDecision != null) {
            return {
                gateRms,
                gatePeak,
                bothGates,
                usedRollingOrPath: false,
                isSpeech: vadSpeechDecision,
                ratioRms,
                ratioPeak,
            };
        }
        const rollingAlign = this.rollingRms >= effectiveRmsFloor * STT_ALT_ROLLING_RMS_MULT &&
            this.rollingPeak >= effectivePeakFloor * STT_ALT_ROLLING_PEAK_MULT;
        const strongEnough = Math.max(ratioRms, ratioPeak) >= STT_ALT_MAX_DIM_RATIO &&
            Math.min(ratioRms, ratioPeak) >= STT_ALT_MIN_DIM_RATIO;
        const anyGate = gateRms || gatePeak;
        const usedRollingOrPath = STT_ALT_SPEECH_ROLLING_OR_ENABLED &&
            !bothGates &&
            anyGate &&
            rollingAlign &&
            strongEnough;
        const isSpeech = bothGates || usedRollingOrPath;
        return { gateRms, gatePeak, bothGates, usedRollingOrPath, isSpeech, ratioRms, ratioPeak };
    }
    resetPreUtteranceGateCounters() {
        this.peakPreUtteranceStreak = 0;
        this.preSpeechFramesRms = 0;
        this.preSpeechFramesPeak = 0;
        this.preSpeechFramesBoth = 0;
        this.preSpeechFramesOrPath = 0;
        this.candidateStartEmitted = false;
    }
    maybeEmitCandidateDropped(reason, stats, speechDec) {
        const hadProgress = this.peakPreUtteranceStreak > 0 || this.preSpeechFramesRms > 0 || this.preSpeechFramesPeak > 0;
        if (!hadProgress)
            return;
        const now = this.nowMs();
        if (now - this.lastCandidateDropLogAtMs >= 2000) {
            this.lastCandidateDropLogAtMs = now;
            log_1.log.info({
                event: 'stt_candidate_dropped_reason',
                reason,
                peak_streak: this.peakPreUtteranceStreak,
                frames_gate_rms: this.preSpeechFramesRms,
                frames_gate_peak: this.preSpeechFramesPeak,
                frames_both_gates: this.preSpeechFramesBoth,
                frames_rolling_or_path: this.preSpeechFramesOrPath,
                rms: Number(stats.rms.toFixed(5)),
                peak: Number(stats.peak.toFixed(5)),
                ratio_rms: Number(speechDec.ratioRms.toFixed(3)),
                ratio_peak: Number(speechDec.ratioPeak.toFixed(3)),
                effective_rms_floor: Number(this.getEffectiveRmsFloor().toFixed(5)),
                effective_peak_floor: Number(this.getEffectivePeakFloor().toFixed(5)),
                ...(this.logContext ?? {}),
            }, 'stt candidate dropped before utterance opened');
        }
        this.resetPreUtteranceGateCounters();
    }
    maybeLogWhisperNotCalled(reason, extra) {
        const now = this.nowMs();
        if (now - this.lastWhisperNotCalledReasonAtMs < 800)
            return;
        this.lastWhisperNotCalledReasonAtMs = now;
        log_1.log.info({
            event: 'whisper_not_called_reason',
            reason,
            ...(extra ?? {}),
            ...(this.logContext ?? {}),
        }, 'whisper not called');
    }
    resolveGateClosedReason(gateRms, gatePeak, streak) {
        if (!gateRms)
            return 'below_rms_floor';
        if (!gatePeak)
            return 'below_peak_floor';
        if (streak < this.speechFramesRequired)
            return 'insufficient_frames';
        return null;
    }
    maybeLogGateClosed(reason, stats, frameMs) {
        const now = this.nowMs();
        if (now - this.lastGateLogAtMs < 1000)
            return;
        this.lastGateLogAtMs = now;
        const playbackActive = this.isPlaybackActive?.();
        const listening = this.isListening?.();
        const codec = this.getCodec?.() ?? this.inputCodec;
        const track = this.getTrack?.();
        const effRmsGate = this.getEffectiveRmsFloor();
        const effPeakGate = this.getEffectivePeakFloor();
        log_1.log.info({
            event: 'stt_gate_closed',
            reason,
            codec,
            track,
            playback_active: playbackActive,
            listening,
            rms: stats.rms,
            peak: stats.peak,
            rolling_rms: this.rollingRms,
            rolling_peak: this.rollingPeak,
            rms_floor: this.speechRmsFloor,
            peak_floor: this.speechPeakFloor,
            effective_rms_floor: Number(effRmsGate.toFixed(5)),
            effective_peak_floor: Number(effPeakGate.toFixed(5)),
            rms_vs_effective_ratio: effRmsGate > 1e-9 ? Number((stats.rms / effRmsGate).toFixed(3)) : null,
            energy_ste: Number(steFromRms(stats.rms).toFixed(10)),
            rms_dbfs: Number(amplitudeToDbfs(stats.rms).toFixed(2)),
            peak_dbfs: Number(amplitudeToDbfs(stats.peak).toFixed(2)),
            speech_frames_required: this.speechFramesRequired,
            speech_frame_streak: this.speechFrameStreak,
            frame_ms: Math.round(frameMs),
            sample_rate_hz: this.sampleRate,
            disable_gates: this.disableGates,
            ...(this.logContext ?? {}),
        }, 'stt gate closed');
    }
    /** Rich snapshot: levels, gates, dedupe, VAD, timing (see STT_PIPELINE_DIAG_* env). */
    emitPipelineDiag(reason) {
        const now = this.nowMs();
        const playbackActive = !!this.isPlaybackActive?.();
        const listening = !!this.isListening?.();
        const gateActive = this.playbackGateActive();
        const effRms = this.getEffectiveRmsFloor();
        const effPeak = this.getEffectivePeakFloor();
        const graceMs = this.getPostPlaybackGraceMs?.() ?? this.postPlaybackGraceMs;
        const sincePlaybackEnd = this.playbackEndedAtMs > 0 ? now - this.playbackEndedAtMs : null;
        const graceRemainingMs = sincePlaybackEnd != null && sincePlaybackEnd >= 0 && sincePlaybackEnd < graceMs
            ? Math.round(graceMs - sincePlaybackEnd)
            : null;
        const speechMs = Math.max(0, this.utteranceMs - this.lastPrependedMs);
        let tier1DynamicSilenceMs = null;
        try {
            tier1DynamicSilenceMs = Math.round(t1ComputeDynamicSilenceMs({ speechMs, avgRms: this.rollingRms, baselineMs: this.silenceEndMs }));
        }
        catch {
            tier1DynamicSilenceMs = null;
        }
        const dupDenom = Math.max(1, this.framesSeen + this.rxFramesDropped);
        const rxDropRatio = this.rxFramesDropped / dupDenom;
        const msSinceLastFrame = this.lastFrameAtMs > 0 ? Math.round(now - this.lastFrameAtMs) : null;
        const msSinceLastSpeech = this.inSpeech && this.lastSpeechAt > 0 ? Math.round(now - this.lastSpeechAt) : null;
        const extras = this.getPipelineDiagContext?.() ?? {};
        const ratioToRmsFloor = effRms > 1e-9 ? this.rollingRms / effRms : null;
        const audioLikelyTooQuiet = listening &&
            !playbackActive &&
            !gateActive &&
            this.noiseFloorSampleCount >= 40 &&
            ratioToRmsFloor != null &&
            ratioToRmsFloor < 0.35;
        log_1.log.info({
            event: 'stt_pipeline_diag',
            reason,
            codec: this.getCodec?.() ?? this.inputCodec,
            track: this.getTrack?.() ?? null,
            disable_gates: this.disableGates,
            playback_active: playbackActive,
            listening,
            playback_gate_active: gateActive,
            post_playback_grace_ms: graceMs,
            ms_since_playback_ended: sincePlaybackEnd != null ? Math.round(sincePlaybackEnd) : null,
            post_playback_grace_remaining_ms: graceRemainingMs,
            levels: {
                last_frame_rms: Number(this.lastRawFrameStats.rms.toFixed(5)),
                last_frame_peak: Number(this.lastRawFrameStats.peak.toFixed(5)),
                rolling_rms: Number(this.rollingRms.toFixed(5)),
                rolling_peak: Number(this.rollingPeak.toFixed(5)),
                noise_floor_rms: this.noiseFloorRms > 0 ? Number(this.noiseFloorRms.toFixed(5)) : null,
                noise_floor_peak: this.noiseFloorPeak > 0 ? Number(this.noiseFloorPeak.toFixed(5)) : null,
                noise_floor_samples: this.noiseFloorSampleCount,
                fixed_rms_floor: this.speechRmsFloor,
                fixed_peak_floor: this.speechPeakFloor,
                effective_rms_floor: Number(effRms.toFixed(5)),
                effective_peak_floor: Number(effPeak.toFixed(5)),
                rolling_rms_to_effective_ratio: ratioToRmsFloor != null ? Number(ratioToRmsFloor.toFixed(3)) : null,
                audio_likely_too_quiet: audioLikelyTooQuiet,
                energy: {
                    last_frame_ste: Number(steFromRms(this.lastRawFrameStats.rms).toFixed(10)),
                    rolling_ste: Number(steFromRms(this.rollingRms).toFixed(10)),
                    last_frame_rms_dbfs: Number(amplitudeToDbfs(this.lastRawFrameStats.rms).toFixed(2)),
                    rolling_rms_dbfs: Number(amplitudeToDbfs(this.rollingRms).toFixed(2)),
                    last_frame_peak_dbfs: Number(amplitudeToDbfs(this.lastRawFrameStats.peak).toFixed(2)),
                    rolling_peak_dbfs: Number(amplitudeToDbfs(this.rollingPeak).toFixed(2)),
                    noise_floor_ste: this.noiseFloorRms > 0 ? Number(steFromRms(this.noiseFloorRms).toFixed(10)) : null,
                    noise_floor_rms_dbfs: this.noiseFloorRms > 0 ? Number(amplitudeToDbfs(this.noiseFloorRms).toFixed(2)) : null,
                    effective_rms_floor_dbfs: Number(amplitudeToDbfs(effRms).toFixed(2)),
                    effective_peak_floor_dbfs: Number(amplitudeToDbfs(effPeak).toFixed(2)),
                },
            },
            dedupe: {
                rx_guard_enabled: this.rxGuardEnabled,
                rx_dedupe_window: this.rxDedupeWindow,
                rx_dedupe_min_peak: this.rxDedupeMinPeak,
                frames_accepted: this.framesSeen,
                frames_dropped_as_duplicate: this.rxFramesDropped,
                duplicate_drop_ratio: Number(rxDropRatio.toFixed(4)),
            },
            vad: {
                enabled: this.vadEnabled,
                ready: this.vadReady,
                speech_now: this.vadSpeechNow,
                speech_streak: this.vadSpeechStreak,
                silence_streak: this.vadSilenceStreak,
            },
            speech: {
                in_speech: this.inSpeech,
                speech_frame_streak: this.speechFrameStreak,
                silence_frame_streak: this.silenceFrameStreak,
                saw_speech_ever: this.sawSpeechEver,
                utterance_ms: Math.round(this.utteranceMs),
                utterance_bytes: this.utteranceBytes,
                speech_ms_net: Math.round(speechMs),
            },
            barge_in: {
                armed: this.bargeInArmed,
                speech_streak: this.bargeInSpeechStreak,
            },
            timing: {
                ms_since_last_frame: msSinceLastFrame,
                ms_since_last_speech: msSinceLastSpeech,
                no_frame_finalize_ms: this.noFrameFinalizeMs,
                tier1_dynamic_silence_ms: tier1DynamicSilenceMs,
                baseline_silence_end_ms: this.silenceEndMs,
                max_utterance_ms: this.maxUtteranceMs,
            },
            stt_http: {
                in_flight: this.inFlight,
                in_flight_kind: this.inFlightKind ?? null,
                finalizing_stop: this.finalizingStop,
            },
            ...extras,
            ...(this.logContext ?? {}),
        }, 'stt pipeline diagnostic');
    }
    resetUtteranceState() {
        this.inSpeech = false;
        this._demoShopMaxUttDeferredLogged = false;
        this.speechStartAtMs = 0; // Tier 5: late-final watchdog
        this.utteranceMs = 0;
        this.utteranceBytes = 0;
        this.sawSpeech = false;
        this.lastPrependedMs = 0;
        this.utteranceFrames = [];
        this.speechFrameStreak = 0;
        this.resetPreUtteranceGateCounters();
        this.playbackSpeechStreak = 0;
        this.silenceFrameStreak = 0;
        this.silenceToFinalizeTimer = undefined;
        this.lastPartialTranscript = '';
        this.finalFlushAt = 0;
        this.finalTranscriptAccepted = false;
        this.lastSpeechAt = 0;
        this.vadSpeechStreak = 0;
        this.vadSilenceStreak = 0;
        if (this.vad)
            this.vad.reset();
    }
}
exports.ChunkedSTT = ChunkedSTT;
//# sourceMappingURL=chunkedSTT.js.map