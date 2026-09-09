"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.CallSession = void 0;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const env_1 = require("../env");
const log_1 = require("../log");
const wavInfo_1 = require("../audio/wavInfo");
const playbackPipeline_1 = require("../audio/playbackPipeline");
const audioStore_1 = require("../storage/audioStore");
const chunkedSTT_1 = require("../stt/chunkedSTT");
const transcriptClarity_1 = require("../stt/transcriptClarity");
const registry_1 = require("../stt/registry");
const pstnTelnyxTransport_1 = require("../transport/pstnTelnyxTransport");
const tts_1 = require("../tts");
const qwen3Chunking_1 = require("../tts/qwen3Chunking");
const audioProbe_1 = require("../diagnostics/audioProbe");
const tenantConfig_1 = require("../tenants/tenantConfig");
const shared_1 = require("@veralux/shared");
const shopGate_1 = require("./shopGate");
const talkerBoard_1 = require("./talkerBoard");
const demoShopDtmf_1 = require("./demoShopDtmf");
const controlPlane_1 = require("../controlPlane");
const crypto_1 = require("crypto");
const brainClient_1 = require("../ai/brainClient");
const quickReplyMatch_1 = require("../ai/quickReplyMatch");
const callAudioCoordinator_1 = require("./callAudioCoordinator");
const audioForensics_1 = require("../observability/audioForensics");
const audioInvariantReport_1 = require("../observability/audioInvariantReport");
const redaction_1 = require("../observability/redaction");
const assistantEcho_1 = require("../stt/assistantEcho");
const echoSuppression_1 = require("../stt/echoSuppression");
const farEndReference_1 = require("../audio/farEndReference");
const aecProcessor_1 = require("../audio/aecProcessor");
const metrics_1 = require("../metrics");
const PARTIAL_FAST_PATH_MIN_CHARS = 18;
const DEFAULT_UNCLEAR_REPROMPT_PHRASES = [
    "I'm sorry, I didn't catch that. Could you repeat that, please?",
    "I didn't quite understand. Please say that again.",
    'Sorry — I had trouble hearing you. Could you repeat your question?',
];
function getErrorMessage(error) {
    if (error instanceof Error)
        return error.message;
    return 'unknown_error';
}

/** VERA_DEMO_SHOP_FIX_20260904: pino logs Error as {} unless fields are copied. */
function serializeCaughtError(error, depth) {
    const d = depth || 0;
    if (error == null) {
        return { value: String(error) };
    }
    if (typeof error !== "object") {
        return { value: String(error) };
    }
    const out = {};
    const name = error.name;
    const message = error.message;
    const stack = error.stack;
    if (typeof name === "string" && name)
        out.name = name;
    if (typeof message === "string")
        out.message = message;
    else if (message != null)
        out.message = String(message);
    if (typeof stack === "string" && stack)
        out.stack = stack.slice(0, 4000);
    const status = error.status ?? error.statusCode ?? error.status_code;
    if (status != null)
        out.status = status;
    let body = error.body ?? error.responseBody ?? error.response_body;
    if (body != null) {
        if (typeof body === "string")
            out.body_snippet = body.slice(0, 500);
        else {
            try {
                out.body_snippet = JSON.stringify(body).slice(0, 500);
            }
            catch {
                out.body_snippet = String(body).slice(0, 500);
            }
        }
    }
    const code = error.code;
    if (typeof code === "string" || typeof code === "number")
        out.code = code;
    const cause = error.cause;
    if (cause != null && d < 3)
        out.cause = serializeCaughtError(cause, d + 1);
    if (!out.message && !out.name) {
        try {
            out.json = JSON.stringify(error).slice(0, 1000);
        }
        catch {
            out.json = "[unserializable]";
        }
    }
    return out;
}
/**
 * VERA_DEMO_SHOP_STREAMTTS_REMAINDER_20260906
 * After first-audio segs, leftover spoken text that was never queued.
 * VERA_DEMO_SHOP_STREAMTTS_REMAINDER_DEDUP_20260906 — suffix only, never the full reply.
 */
function extractDemoShopStreamRemainder(fullText, queuedParts) {
    let rest = String(fullText || '').trim();
    if (!rest)
        return '';
    for (const part of queuedParts || []) {
        const p = String(part || '').trim();
        if (!p)
            continue;
        if (rest.startsWith(p)) {
            rest = rest.slice(p.length).replace(/^[\s,;.!?—–-]+/, '').trim();
            continue;
        }
        const idx = rest.indexOf(p);
        if (idx >= 0 && idx <= 12) {
            rest = rest.slice(idx + p.length).replace(/^[\s,;.!?—–-]+/, '').trim();
        }
    }
    return rest;
}
function mapDemoShopSpeakCursorAfterUnwrap(spoken, queuedParts) {
    const s = String(spoken || '');
    if (!s)
        return 0;
    let idx = 0;
    for (const part of queuedParts || []) {
        const p = String(part || '').trim();
        if (!p)
            continue;
        const from = s.slice(idx);
        const trimmedFrom = from.trimStart();
        const lead = from.length - trimmedFrom.length;
        if (trimmedFrom.startsWith(p)) {
            idx += lead + p.length;
            continue;
        }
        const found = s.indexOf(p, idx);
        if (found >= 0)
            idx = found + p.length;
    }
    return idx;
}
function isDemoShopRemainderDuplicate(remain, fullSpoken, queuedParts) {
    const r = String(remain || '').trim();
    const full = String(fullSpoken || '').trim();
    if (!r)
        return true;
    if (r === full)
        return true;
    const first = String((queuedParts && queuedParts[0]) || '').trim();
    if (first.length >= 6) {
        const prefix = first.slice(0, Math.min(12, first.length)).toLowerCase();
        if (r.toLowerCase().startsWith(prefix))
            return true;
    }
    return false;
}
function pickDemoShopStreamRemainder(fullSpoken, queuedParts, fromCursor) {
    const stripped = extractDemoShopStreamRemainder(fullSpoken, queuedParts);
    if (stripped && !isDemoShopRemainderDuplicate(stripped, fullSpoken, queuedParts))
        return stripped;
    const cursor = String(fromCursor || '').trim();
    if (cursor && !isDemoShopRemainderDuplicate(cursor, fullSpoken, queuedParts))
        return cursor;
    return '';
}
function resolveDebugDir() {
    const dir = process.env.STT_DEBUG_DIR;
    return dir && dir.trim() !== '' ? dir.trim() : '/tmp/veralux-stt-debug';
}
function wavHeader(pcmDataBytes, sampleRate, channels) {
    const bytesPerSample = 2;
    const blockAlign = channels * bytesPerSample;
    const byteRate = sampleRate * blockAlign;
    const header = Buffer.alloc(44);
    header.write('RIFF', 0, 'ascii');
    header.writeUInt32LE(36 + pcmDataBytes, 4);
    header.write('WAVE', 8, 'ascii');
    header.write('fmt ', 12, 'ascii');
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(channels, 22);
    header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE(byteRate, 28);
    header.writeUInt16LE(blockAlign, 32);
    header.writeUInt16LE(16, 34);
    header.write('data', 36, 'ascii');
    header.writeUInt32LE(pcmDataBytes, 40);
    return header;
}
function encodePcm16Wav(pcm16le, sampleRateHz) {
    const header = wavHeader(pcm16le.length, sampleRateHz, 1);
    return Buffer.concat([header, pcm16le]);
}
/** Negative dB only; returns same buffer when db >= 0. */
function applyRxHeadroomDb(pcm16, db) {
    if (db >= 0)
        return pcm16;
    const mul = 10 ** (db / 20);
    const out = new Int16Array(pcm16.length);
    for (let i = 0; i < pcm16.length; i += 1) {
        const v = Math.round((pcm16[i] ?? 0) * mul);
        if (v > 32767)
            out[i] = 32767;
        else if (v < -32768)
            out[i] = -32768;
        else
            out[i] = v;
    }
    return out;
}
class CallSession {
    endPlaybackAuthoritatively(reason) {
        if (this.transport.mode !== 'pstn') {
            this.onPlaybackEnded();
            return;
        }
        this.pstnPlaybackEndAuthority = reason;
        try {
            this.onPlaybackEnded();
        }
        finally {
            this.pstnPlaybackEndAuthority = null;
        }
    }
    onSttRequestStart(kind) {
        this.sttInFlightCount += 1;
        this.audioCoordinator.onSttRequestStart(kind, Date.now());
        log_1.log.info({
            event: 'stt_req_start',
            kind,
            stt_in_flight: this.sttInFlightCount,
            ...(this.logContext ?? {}),
        }, 'stt request started');
    }
    onSttRequestEnd(kind) {
        this.sttInFlightCount = Math.max(0, this.sttInFlightCount - 1);
        this.audioCoordinator.onSttRequestEnd(kind, Date.now());
        log_1.log.info({
            event: 'stt_req_end',
            kind,
            stt_in_flight: this.sttInFlightCount,
            ...(this.logContext ?? {}),
        }, 'stt request ended');
    }
    /** Used by SessionManager to defer teardown until in-flight STT completes or grace expires. */
    getSttInFlightCount() {
        return this.sttInFlightCount;
    }
    /**
     * Arm deferred teardown: when STT is in flight at hangup, manager calls this instead of teardown immediately.
     * We run the callback when (1) late final transcript is captured, or (2) grace period expires.
     */
    armDeferredTeardown(callback) {
        if (this.onReadyForTeardown != null) {
            log_1.log.warn({ event: 'deferred_teardown_already_armed', ...this.logContext }, 'armDeferredTeardown called more than once; replacing callback');
        }
        this.onReadyForTeardown = callback;
        this.lateFinalGraceTimeout = setTimeout(() => {
            this.lateFinalGraceTimeout = undefined;
            this.settleLateFinalGrace();
        }, this.lateFinalGraceMs);
    }
    /**
     * Called when late final transcript is captured or grace timer fires.
     * Runs the deferred teardown callback once and clears state.
     */
    settleLateFinalGrace() {
        if (this.lateFinalGraceTimeout != null) {
            clearTimeout(this.lateFinalGraceTimeout);
            this.lateFinalGraceTimeout = undefined;
        }
        this.lateFinalGraceUntilMs = 0;
        const cb = this.onReadyForTeardown;
        this.onReadyForTeardown = undefined;
        if (typeof cb === 'function') {
            cb();
        }
    }
    constructor(config) {
        this.state = 'INIT';
        this.transcriptBuffer = [];
        this.conversationHistory = [];
        /** Lightweight counters for Call Quality Analytics (no raw audio). */
        this.qualitySignals = {
            assistantEchoRejected: 0,
            transcriptNearDuplicateRejected: 0,
            bargeInDuringPlayback: 0,
            deadAirFired: 0,
            transcriptDeferred: 0,
            sttLatencyMs: [],
            ttsLatencyMs: [],
            llmLatencyMs: [],
        };
        this.deadAirMs = env_1.env.DEAD_AIR_MS;
        this.deadAirNoFramesMs = env_1.env.DEAD_AIR_NO_FRAMES_MS;
        /**
         * Voice mode for XTTS: 'preset' uses built-in voice_id, 'cloned' uses reference audio.
         * Can be changed mid-call via setVoiceMode() for hot-swap functionality.
         */
        this.currentVoiceMode = 'preset';
        this.active = true;
        this.transferPending = false;
        this.nightDeskCompletion = undefined;
        this.cidMatch = undefined;
        this.cidLookupPromise = undefined;
        this.callEndedWorkflowEnsured = false;
        this.demoShopMidCallBookPosted = false;
        this.demoShopMidCallBookInFlight = false;
        this.demoShopMidCallBookPromise = null;
        // VERA_DEMO_SHOP_SLOTCARD_20260907 — last injected Call board (log on change)
        this.lastTalkerBoardKey = '';
        // VERA_DEMO_SHOP_NAMETRUTH_20260905 — persist first-name-only ("My name is Nick")
        this.demoShopCollectedName = null;
        // VERA_DEMO_SHOP_NO_REGREET_20260906 — after first Hi+Name ack, strip later reopeners
        this.demoShopNameAcked = false;
        // VERA_DEMO_SHOP_PICKUP_HISTORY_20260906 — pickup WAV is assistant turn 0
        this.pickupGreetingRecorded = false;
        // VERA_DEMO_SHOP_BARGE_SUSTAIN_20260906 — settle after barge before a new LLM turn
        this.demoShopLastBargeAtMs = 0;
        this.demoShopBargeSettleUntilMs = 0;
        this.demoShopBargeSettleTimer = null;
        // VERA_DEMO_SHOP_PSTN_WAIT_20260905 — per-segment await for Telnyx playback.ended / duration
        this.demoShopPstnSegmentWait = null;
        // VERA_DEMO_SHOP_ONEWAV_20260905 — generation token so stale playback.ended cannot settle a newer wait
        this.demoShopPstnPlayGeneration = 0;
        // Epoch bumps on clearTtsQueue so superseded chain finally cannot segment_drain a rewrite play.
        this.ttsSegmentChainEpoch = 0;
        // VERA_DEMO_SHOP_PLAYSERIAL_20260907 — invalidate in-flight playText after rewrite/stop
        this.demoShopPlayEpoch = 0;
        // VERA_DEMO_SHOP_HARDEN_20260904 — contact max-utt + incomplete/bye guards
        this.demoShopAwaitingContact = false;
        // VERA_DEMO_SHOP_DTMF_20260907 — keypad buffer; spoken fragments never stitch into this
        this.demoShopDtmfBuffer = '';
        this.demoShopDtmfPhone = null;
        this._demoShopBaselineMaxUttMs = null;
        // VERA_DEMO_SHOP_SPEAKERPHONE_20260905 — ignore residual energy barge for first ~500ms of each TTS
        this.demoShopTtsPlaybackStartAtMs = 0;
        this.demoShopTelnyxPlayStartedAtMs = 0;
        this.pstnPlaybackEndAuthority = null;
        this.isHandlingTranscript = false;
        this.hasStarted = false;
        this.turnSequence = 0;
        this.forensicsPolicySeq = 0;
        /** Recent assistant/TTS strings for assistant-echo detection (newest first). */
        this.assistantEchoReferenceLines = [];
        this.deadAirEligible = false;
        this.repromptInFlight = false;
        this.unclearRepromptCount = 0;
        this.lastUnclearRepromptAtMs = 0;
        this.demoShopEmptyReaskThisListen = false;
        /** Last accepted user final for near-duplicate suppression (double Whisper finals). */
        this.lastUserFinalForDedupeText = '';
        this.lastUserFinalForDedupeAtMs = 0;
        /** Anchor for turn SLO: time final transcript was accepted (post-dedupe), until first playback.play. */
        this.userTurnFinalAcceptedAtMs = null;
        this.userTurnPlaybackLatencyRecorded = false;
        // VERA_DEMO_SHOP_LATENCY_20260905 — per-turn + end-of-call latency report
        this.callStartedAtMs = Date.now();
        this.latencyTurns = [];
        this.latencyCurrent = null;
        this.latencyReportEmitted = false;
        this.ingestFailurePrompted = false;
        this.logPreviewChars = env_1.env.STT_TRANSCRIPT_LOG_MAX_CHARS;
        this.ttsSegmentChain = Promise.resolve();
        this.ttsSegmentQueueDepth = 0;
        this.playbackState = {
            active: false,
            interrupted: false,
        };
        /** Last TTS segment duration (ms) — used for Tier 2 measured listen-after-playback grace (300–900ms). */
        this.lastPlaybackSegmentDurationMs = 0;
        this.transcriptHandlingToken = 0;
        this.transcriptAcceptedForUtterance = false;
        this.lastSpeechStartAtMs = 0;
        /** Last frame where STT saw gate_rms, gate_peak, or is_speech while listening (even if utterance never opened). */
        this.lastSttGatePositiveAtMs = 0;
        this.lastDecodedFrameAtMs = 0;
        this.lastInboundMediaAtMs = 0; // ✅ inbound PCM received (authoritative)
        this.rxDumpActive = false;
        this.rxDumpSamplesTarget = 0;
        this.rxDumpSamplesCollected = 0;
        this.rxDumpBuffers = [];
        this.listeningSinceAtMs = 0;
        // pick reasonable defaults; you can env-ize later
        this.deadAirListeningGraceMs = 1200; // prevents immediate reprompt right after enter LISTENING
        this.deadAirAfterSpeechStartGraceMs = 1500; // prevents reprompt while user has started speaking but transcript not ready
        this.deadAirDeferRecentSttSignalMs = env_1.env.DEAD_AIR_DEFER_RECENT_STT_SIGNAL_MS;
        // ===== STT in-flight tracking (prevents dead-air reprompt while Whisper HTTP is running) =====
        this.sttInFlightCount = 0;
        // ===== Late FINAL grace window (accept FINAL transcript briefly after hangup) =====
        // Purpose: caller hangs up while Whisper final is still processing.
        // We want to CAPTURE the final transcript for logs/history, but NOT respond.
        this.lateFinalGraceUntilMs = 0;
        this.lateFinalGraceMs = env_1.env.STT_LATE_FINAL_GRACE_MS ?? 1500;
        /** Set while trying to play a response to a late-final transcript so we attempt Telnyx playback despite inactive. */
        this.isRespondingToLateFinal = false;
        this.pstnPlaybackWatchdogMs = 8000; // tune 6000–12000ms as needed
        this.callControlId = config.callControlId;
        this.tenantId = config.tenantId;
        this.from = config.from;
        this.to = config.to;
        this.requestId = config.requestId;
        this.metrics = {
            createdAt: new Date(),
            lastHeardAt: undefined,
            turns: 0,
            transcriptsTotal: 0,
            transcriptsEmpty: 0,
            totalUtteranceMs: 0,
            totalTranscribedChars: 0,
        };
        this.sttConfig = config.tenantConfig?.stt;
        this.ttsConfig = config.tenantConfig?.tts;
        this.refreshPublishedTts = async () => {
            if (!this.tenantId)
                return;
            try {
                const published = await (0, tenantConfig_1.loadTenantConfig)(this.tenantId);
                if (!published?.tts)
                    return;
                this.ttsConfig = published.tts;
                if (published.tts.mode === 'coqui_xtts' || published.tts.mode === 'chatterbox_http') {
                    this.currentVoiceMode = published.tts.defaultVoiceMode ?? this.currentVoiceMode ?? 'preset';
                }
            }
            catch (err) {
                log_1.log.warn({ err, ...this.logContext }, 'tts config refresh failed');
            }
        };
        this.transferProfiles = config.tenantConfig?.transferProfiles;
        this.assistantContext = config.tenantConfig?.assistantContext;
        this.fullTenantConfig = config.tenantConfig;
        this.tenantPrompts = config.tenantConfig?.llmContext?.prompts;
        this.tenantGreetingText = config.tenantConfig?.llmContext?.prompts?.greetingText;
        this.quickReplies = config.tenantConfig?.quickReplies;
        this.logContext = {
            call_control_id: this.callControlId,
            tenant_id: this.tenantId,
            requestId: this.requestId,
            telnyx_track: env_1.env.TELNYX_STREAM_TRACK,
        };
        // Initialize voice mode from tenant config (XTTS / Chatterbox cloning)
        if (this.ttsConfig?.mode === 'coqui_xtts' ||
            this.ttsConfig?.mode === 'chatterbox_http') {
            this.currentVoiceMode = this.ttsConfig.defaultVoiceMode ?? 'preset';
            log_1.log.info({
                event: 'voice_mode_initialized',
                voice_mode: this.currentVoiceMode,
                has_cloned_voice: !!this.ttsConfig.clonedVoice,
                cloned_voice_label: this.ttsConfig.clonedVoice?.label,
                ...this.logContext,
            }, 'voice mode initialized');
        }
        this.transport =
            config.transportSession ??
                new pstnTelnyxTransport_1.PstnTelnyxTransportSession({
                    callControlId: this.callControlId,
                    tenantId: this.tenantId,
                    requestId: this.requestId,
                    isActive: () => this.active && this.state !== 'ENDED',
                    allowPlaybackWhenInactive: () => this.isRespondingToLateFinal,
                    alreadyAnswered: config.pstnAlreadyAnswered,
                });
        // ✅ Ensure this is ALWAYS a string (tenant override → env fallback)
        const sttEndpointUrl = this.sttConfig?.config?.url ??
            this.sttConfig?.whisperUrl ??
            env_1.env.WHISPER_URL ??
            '';
        if (!sttEndpointUrl) {
            log_1.log.warn({ event: 'stt_url_missing', ...this.logContext }, 'No STT URL configured');
        }
        const sttMode = this.sttConfig?.mode ?? 'whisper_http';
        const selectedMode = sttMode === 'http_wav_json' && !env_1.env.ALLOW_HTTP_WAV_JSON ? 'whisper_http' : sttMode;
        const provider = (0, registry_1.getProvider)(selectedMode);
        log_1.log.info({
            event: 'stt_provider_selected',
            call_control_id: this.callControlId,
            stt_mode: selectedMode,
            requested_mode: sttMode,
            provider_id: provider.id,
            ...(this.logContext ?? {}),
        }, 'stt provider selected');
        const sttAudioInput = this.transport.mode === 'pstn'
            ? { codec: 'pcm16le', sampleRateHz: env_1.env.TELNYX_TARGET_SAMPLE_RATE }
            : this.transport.audioInput;
        this.rxSampleRateHz = sttAudioInput.sampleRateHz;
        this.audioCoordinator = new callAudioCoordinator_1.CallAudioCoordinator({
            callControlId: this.callControlId,
            sampleRateHz: this.rxSampleRateHz,
            logContext: this.logContext,
            isPlaybackActive: () => this.isPlaybackActive(),
            isCallActive: () => this.active && this.state !== 'ENDED',
            canArmListening: () => this.active && this.state !== 'ENDED' && !this.isHandlingTranscript &&
                !(this.tenantId === 'demo-shop' && this.isPlaybackActive() && !this.playbackState.interrupted),
            isListening: () => this.state === 'LISTENING',
            onArmListening: (reason) => {
                void reason;
                this.enterListeningState(true);
            },
            onTimingSummary: (payload) => {
                const stt = payload.stt_roundtrip_ms;
                if (typeof stt === 'number' && Number.isFinite(stt) && stt >= 0 && stt < 120000) {
                    this.qualitySignals.sttLatencyMs.push(Math.round(stt));
                }
                const tts = payload.tts_roundtrip_ms;
                if (typeof tts === 'number' && Number.isFinite(tts) && tts >= 0 && tts < 300000) {
                    this.qualitySignals.ttsLatencyMs.push(Math.round(tts));
                }
            },
        });
        if (this.transport.mode !== 'pstn') {
            this.audioCoordinator.setWsConnected(true);
        }
        this.stt = new chunkedSTT_1.ChunkedSTT({
            provider,
            whisperUrl: sttEndpointUrl,
            language: this.sttConfig?.language ?? env_1.env.STT_LANGUAGE,
            prompt: env_1.env.STT_WHISPER_PROMPT,
            frameMs: this.sttConfig?.chunkMs ?? env_1.env.STT_CHUNK_MS,
            // VERA_DEMO_SHOP_CONVOFEEL_20260906 — conversational endpoint 550ms; contact path raises to 800
            silenceEndMs: this.tenantId === 'demo-shop' ? 550 : env_1.env.STT_SILENCE_MS,
            inputCodec: sttAudioInput.codec,
            sampleRate: sttAudioInput.sampleRateHz,
            onTranscript: async (text, source) => {
                await this.handleTranscript(text, source);
            },
            onSpeechStart: (info) => {
                void this.handleSpeechStart(info);
            },
            // VERA_DEMO_SHOP_TURN_20260905 — barge-in during playback MUST stop Telnyx playback
            // immediately. ChunkedSTT arms bargeInArmed + fires onBargeInDetected, but without
            // this hook frames stay dropped (frame_dropped_by_playback_gate barge_in_armed:true)
            // while monologue TTS segments keep playing.
            // VERA_DEMO_SHOP_SPEAKERPHONE_20260905 — early barge ignore + silent empty finals (demo-shop only)
            onBargeInDetected: (info) => {
                // VERA_DEMO_SHOP_SPEAKERPHONE_20260905 — keep TURN stopPlayback for real barges; ignore early residual energy
                if (this.tenantId === 'demo-shop') {
                    const now = Date.now();
                    const startedAt = this.demoShopTtsPlaybackStartAtMs || 0;
                    const telnyxStartedAt = this.demoShopTelnyxPlayStartedAtMs || 0;
                    const msSinceTtsStart = startedAt > 0 ? now - startedAt : null;
                    const telnyxPlayNotStarted = startedAt > 0 && telnyxStartedAt <= 0;
                    const inEarlyWindow = startedAt > 0 && msSinceTtsStart != null && msSinceTtsStart < 500;
                    if (telnyxPlayNotStarted || inEarlyWindow) {
                        log_1.log.info({
                            event: 'stt_barge_in_ignored_speakerphone_protect',
                            rms: info?.rms,
                            peak: info?.peak,
                            streak: info?.streak,
                            ms_since_tts_playback_start: msSinceTtsStart,
                            telnyx_play_started: telnyxStartedAt > 0,
                            ...this.logContext,
                        }, 'demo-shop speakerphone: ignoring early/false barge (keep playback)');
                        return;
                    }
                    // VERA_DEMO_SHOP_BARGE_SUSTAIN_20260906 — brief blips must not cancel TTS
                    const frameMs = Number(info?.frameMs) > 0 ? Number(info.frameMs) : 20;
                    const streak = Number(info?.streak) > 0 ? Number(info.streak) : 0;
                    const sustainMs = Math.round(streak * frameMs);
                    const rms = Number(info?.rms);
                    if (sustainMs < 280 || (Number.isFinite(rms) && rms < 0.032)) {
                        log_1.log.info({
                            event: 'stt_barge_in_ignored_unsustained',
                            marker: 'VERA_DEMO_SHOP_BARGE_SUSTAIN_20260906',
                            rms: info?.rms,
                            peak: info?.peak,
                            streak,
                            frame_ms: Math.round(frameMs),
                            sustain_ms: sustainMs,
                            sustain_threshold_ms: 280,
                            rms_threshold: 0.032,
                            ...this.logContext,
                        }, 'demo-shop: ignoring unsustained barge blip (keep playback)');
                        return;
                    }
                    log_1.log.info({
                        event: 'stt_barge_in_detected',
                        marker: 'VERA_DEMO_SHOP_BARGE_SUSTAIN_20260906',
                        rms: info?.rms,
                        peak: info?.peak,
                        streak,
                        frame_ms: Math.round(frameMs),
                        sustain_ms: sustainMs,
                        sustain_threshold_ms: 280,
                        ...this.logContext,
                    }, 'demo-shop: sustained barge — stop playback');
                }
                // VERA_DEMO_SHOP_TURN_20260905 — barge-in during playback MUST stop Telnyx playback
                log_1.log.info({
                    event: 'stt_barge_in_stop_playback',
                    rms: info?.rms,
                    peak: info?.peak,
                    streak: info?.streak,
                    during_playback: true,
                    ...this.logContext,
                }, 'barge-in detected — stopping playback and clearing TTS queue');
                void this.handleSpeechStart({
                    rms: info?.rms ?? 0,
                    peak: info?.peak ?? 0,
                    frameMs: info?.frameMs ?? 20,
                    streak: info?.streak ?? 0,
                    prependedMs: 0,
                });
            },
            onUtteranceEnd: (info) => {
                this.audioCoordinator.onUtteranceEnd(info);
            },
            onFinalResult: (opts) => {
                this.metrics.transcriptsTotal += 1;
                if (opts.isEmpty)
                    this.metrics.transcriptsEmpty += 1;
                this.metrics.totalUtteranceMs += opts.utteranceMs;
                this.metrics.totalTranscribedChars += opts.textLength;
            },
            onFinalPipelineOutcome: (outcome) => {
                void this.onFinalPipelineOutcome(outcome);
            },
            // When AEC is on, ring buffer has raw audio but STT receives AEC-processed;
            // mixing causes "starts over" / duplication. Use internal pre-roll only.
            consumePreRoll: env_1.env.STT_AEC_ENABLED
                ? undefined
                : () => this.audioCoordinator.consumePreRollForUtterance(),
            // Feed preroll ring in STT order so snapshot at speech start doesn't include future frames (avoids "starts and repeats").
            onFrameForPreRoll: env_1.env.STT_AEC_ENABLED
                ? undefined
                : (buffer, _frameMs) => this.audioCoordinator.pushFrameForPreRoll(buffer, this.rxSampleRateHz),
            // ✅ STT in-flight hooks (ChunkedSTT calls these when provider requests start/end)
            onSttRequestStart: (kind) => this.onSttRequestStart(kind),
            onSttRequestEnd: (kind) => this.onSttRequestEnd(kind),
            isPlaybackActive: () => this.isPlaybackActive(),
            isListening: () => this.isListening(),
            isCallActive: () => this.active && this.state !== 'ENDED',
            getTrack: () => env_1.env.TELNYX_STREAM_TRACK,
            getCodec: () => this.transport.audioInput.codec,
            logContext: this.logContext,
            // Tier 2: measured listen-after-playback delay (300–900ms based on last segment length)
            getPostPlaybackGraceMs: () => this.computePostPlaybackGraceMs(),
            getPipelineDiagContext: () => ({
                session_state: this.state,
                stt_in_flight: this.sttInFlightCount,
                is_handling_transcript: this.isHandlingTranscript,
                reprompt_in_flight: this.repromptInFlight,
                ms_since_last_inbound_media: this.lastInboundMediaAtMs > 0 ? Date.now() - this.lastInboundMediaAtMs : null,
                tts_segment_queue_depth: this.ttsSegmentQueueDepth,
                playback_flag_active: this.playbackState.active,
            }),
            // VERA_DEMO_SHOP_SPEAKERPHONE_20260905
            demoShopSpeakerphoneProtect: this.tenantId === 'demo-shop',
            onSttListeningGateActivity: (p) => {
                if (this.state !== 'LISTENING' || !this.active)
                    return;
                if (p.is_speech || p.gate_rms || p.gate_peak) {
                    this.lastSttGatePositiveAtMs = Date.now();
                }
            },
        });
        // VERA_DEMO_SHOP_COLLECTPASS_20260907 + PERSONEND — fuse before first dump; turn ends on silence
        if (this.tenantId === 'demo-shop')
            this.syncDemoShopContactMaxUtt('');
    }
    start(options = {}) {
        if (!this.active || this.state === 'ENDED' || this.hasStarted) {
            return false;
        }
        this.state = 'INIT';
        this.hasStarted = true;
        if (this.from) {
            this.cidLookupPromise = (0, controlPlane_1.lookupCallerCid)(this.tenantId || '', this.from).then((hit) => {
                if (hit)
                    this.cidMatch = hit;
            });
        }
        if (options.autoAnswer !== false) {
            void this.answerAndGreet();
        }
        return true;
    }
    getNightDeskLead() {
        const extracted = (0, shopGate_1.extractNightDeskLead)({
            history: this.conversationHistory,
            callerId: this.from,
            existingCustomerName: this.cidMatch?.name,
            membership: this.cidMatch?.membership,
        });
        return {
            ...extracted,
            completion: this.nightDeskCompletion,
            existingCustomer: this.cidMatch?.name,
            openJobs: this.cidMatch?.openJobs,
            membership: this.cidMatch?.membership,
            warranty: this.cidMatch?.warranty,
            bookingAdapter: this.demoShopMidCallBookPosted ? 'gcal_helper' : undefined,
        };
    }
    onAnswered() {
        if (!this.active || this.state === 'ENDED') {
            return false;
        }
        const previousState = this.state;
        if (this.state === 'INIT') {
            this.state = 'ANSWERED';
        }
        this.metrics.lastHeardAt = new Date();
        this.audioCoordinator.notifyListeningEligibilityChanged('answered');
        return previousState !== this.state;
    }
    onMediaWsConnected() {
        this.audioCoordinator.setWsConnected(true);
    }
    onMediaWsDisconnected() {
        this.handleMediaDisconnect('ws_close');
    }
    onMediaStreamingStopped() {
        this.handleMediaDisconnect('streaming_stopped');
    }
    handleMediaDisconnect(reason) {
        const now = Date.now();
        this.audioCoordinator.setWsConnected(false, now);
        if (this.audioCoordinator.shouldFinalizeOnDisconnect()) {
            if (!this.audioCoordinator.isFinalInFlight()) {
                this.stt.stop({ preserveInFlightFinal: true }).catch(() => undefined);
            }
        }
        if (this.active && this.state === 'LISTENING') {
            this.state = 'ANSWERED';
            this.listeningSinceAtMs = 0;
            this.deadAirEligible = false;
            this.clearDeadAirTimer();
        }
    }
    onAudioFrame(frame) {
        if (!this.active || this.state === 'ENDED')
            return;
        // PSTN must feed STT with decoded PCM16 only (via onPcm16Frame)
        if (this.transport.mode === 'pstn') {
            log_1.log.warn({ event: 'unexpected_audio_frame_on_pstn', ...this.logContext }, 'PSTN transport should call onPcm16Frame (decoded pcm16) not onAudioFrame');
            return;
        }
        // Non-PSTN / WebRTC can continue using this path if that's how your transport works.
        const now = Date.now();
        this.lastInboundMediaAtMs = now; // ✅ NEW
        this.lastDecodedFrameAtMs = now;
        if (this.transport.audioInput.codec === 'pcm16le') {
            const sampleCount = Math.floor(frame.length / 2);
            if (sampleCount > 0) {
                const pcm16 = new Int16Array(frame.buffer, frame.byteOffset, sampleCount);
                this.audioCoordinator.onInboundFrame({ pcm16, sampleRateHz: this.rxSampleRateHz, channels: 1 }, now);
            }
        }
        if (this.state === 'LISTENING') {
            if (!this.deadAirEligible && this.audioCoordinator.isMediaReady()) {
                this.deadAirEligible = true;
            }
            this.scheduleDeadAirTimer();
        }
        this.metrics.lastHeardAt = new Date();
        (0, metrics_1.incSttFramesFed)();
        // IMPORTANT: only do rx dump here if you KNOW these bytes are pcm16.
        // If you don't, remove this line entirely.
        // this.maybeCaptureRxDump(frame as unknown as Buffer);
        // Only feed raw bytes into STT when they are PCM16LE frames.
        if (this.transport.audioInput.codec !== 'pcm16le') {
            return;
        }
        this.stt.ingest(frame);
    }
    onPcm16Frame(frame) {
        if (!this.active || this.state === 'ENDED') {
            return;
        }
        const now = Date.now();
        // ✅ authoritative: inbound media was received
        this.lastInboundMediaAtMs = now;
        // keep existing marker too
        this.lastDecodedFrameAtMs = now;
        this.metrics.lastHeardAt = new Date();
        this.audioCoordinator.onInboundFrame(frame, now);
        // ✅ CRITICAL: keep dead-air timer fresh while listening
        if (this.state === 'LISTENING') {
            if (!this.deadAirEligible && this.audioCoordinator.isMediaReady()) {
                this.deadAirEligible = true;
            }
            this.scheduleDeadAirTimer();
        }
        if (frame.sampleRateHz !== this.rxSampleRateHz) {
            log_1.log.warn({
                event: 'stt_sample_rate_mismatch',
                expected_hz: this.rxSampleRateHz,
                got_hz: frame.sampleRateHz,
                ...this.logContext,
            }, 'stt sample rate mismatch');
        }
        const feedToStt = (pcm16, sampleRateHz) => {
            const pcmBuffer = Buffer.from(pcm16.buffer, pcm16.byteOffset, pcm16.byteLength);
            const fos = (0, audioForensics_1.getForensicsSession)(this.callControlId);
            if (fos && sampleRateHz > 0 && pcm16.length > 0) {
                fos.sessionSttInputFrameIndex += 1;
                if (fos.sessionSttInputFrameIndex <= env_1.env.AUDIO_FORENSICS_MAX_EMIT_FRAMES) {
                    const idx = String(fos.sessionSttInputFrameIndex).padStart(4, '0');
                    void fos
                        .writeBinary(`audio/004_session_stt_input_${idx}.wav`, (0, audioForensics_1.encodePcm16MonoWav)(pcmBuffer, sampleRateHz))
                        .catch(() => undefined);
                }
            }
            (0, metrics_1.incSttFramesFed)();
            this.maybeCaptureRxDump(pcmBuffer);
            this.stt.ingestPcm16(pcm16, sampleRateHz);
        };
        const rxPcm = applyRxHeadroomDb(frame.pcm16, env_1.env.STT_RX_HEADROOM_DB);
        if (env_1.env.STT_AEC_ENABLED && aecProcessor_1.speexAecAvailable && frame.sampleRateHz === 16000) {
            (0, aecProcessor_1.processAec)(this.callControlId, rxPcm, frame.sampleRateHz, feedToStt, this.logContext);
        }
        else {
            feedToStt(rxPcm, frame.sampleRateHz);
        }
    }
    isPlaybackActive() {
        if (!this.active || this.state === 'ENDED')
            return false;
        if (this.transport.mode === 'pstn') {
            // PSTN: only the authoritative playback flag matters
            return this.playbackState.active;
        }
        return this.playbackState.active || this.ttsSegmentQueueDepth > 0;
    }
    isListening() {
        return this.state === 'LISTENING';
    }
    getLastSpeechStartAtMs() {
        return this.lastSpeechStartAtMs;
    }
    notifyIngestFailure(reason) {
        if (!this.active || this.state === 'ENDED') {
            return;
        }
        if (this.ingestFailurePrompted || this.repromptInFlight) {
            return;
        }
        this.ingestFailurePrompted = true;
        this.repromptInFlight = true;
        this.stt.stop();
        const turnId = `ingest-${this.nextTurnId()}`;
        log_1.log.warn({ event: 'call_session_ingest_failure_prompt', reason, ...this.logContext }, 'ingest failure prompt');
        void this.playText("I'm having trouble hearing you. Please try again.", turnId)
            .catch((error) => {
            log_1.log.warn({ err: error, ...this.logContext }, 'ingest failure reprompt failed');
        })
            .finally(() => {
            this.repromptInFlight = false;
            if (this.state === 'LISTENING') {
                this.scheduleDeadAirTimer();
            }
        });
    }
    end() {
        if (this.state === 'ENDED') {
            this.markEnded('ended');
            this.maybeDemoShopHangupBook();
            return false;
        }
        this.markEnded('ended');
        this.state = 'ENDED';
        this.metrics.lastHeardAt = new Date();
        this.clearDeadAirTimer();
        this.stt.stop({ allowFinal: false, preserveInFlightFinal: true }).catch(() => undefined);
        this.emitLatencyReport('ended');
        this.maybeDemoShopHangupBook();
        return true;
    }
    /**
     * VERA_DEMO_SHOP_NORMALIZE_20260904
     * Durable normalize-then-write: extract booking object, resolve absolute PT datetime,
     * POST /book when confirmed + start. Mid-call + hangup share this path.
     */
    normalizeDemoShopBooking(turns) {
        // VERA_DEMO_SHOP_NORMALIZE_20260904 + VERA_DEMO_SHOP_BOOKTRUTH_20260905
        // Prefer spoken user clock; reject business-hours bleed; require name+(phone|email) to write.
        const list = Array.isArray(turns) ? turns : (this.conversationHistory || []);
        // VERA_DEMO_SHOP_HARDEN_20260904 — curly/smart quotes → ASCII before confirm regex
        const apostropheNorm = (s) => String(s || '').replace(/[\u2018\u2019\u201A\u201B\u2032\u2035\u02BC]/g, "'");
        const transcript = list.map((t) => `${t.role}: ${t.content}`).join('\n');
        const fullText = apostropheNorm(list.map((t) => String(t.content || '')).join('\n'));
        const userText = apostropheNorm(list.filter((t) => t.role === 'user').map((t) => String(t.content || '')).join('\n'));
        const assistantText = apostropheNorm(list.filter((t) => t.role === 'assistant').map((t) => String(t.content || '')).join('\n'));

        const confirmPatterns = [
            /\b(your\s+)?(demo|appointment|booking)\s+is\s+booked\b/i,
            /\b(demo|appointment)\s+is\s+(confirmed|set|locked\s+in)\b/i,
            /\byou('re| are)\s+(all\s+set|booked|confirmed)\b/i,
            /\b(locked\s+in|confirmed\s+for|booked\s+for)\b/i,
            /\bi('ve| have)\s+(booked|got\s+you\s+down|scheduled)\b/i,
            /\bi('ll| will)\s+book\b/i,
            /\bi('ll| will)\s+(go ahead and\s+)?schedule\b/i,
            /\blet me book\b/i,
            /\bscheduled?\s+(your|the)\s+(demo|appointment)\b/i,
        ];
        let confirmSignal = null;
        for (const re of confirmPatterns) {
            const m = re.exec(assistantText) || re.exec(fullText);
            if (m) {
                confirmSignal = m[0];
                break;
            }
        }
        const confirmed = !!confirmSignal;

        const months = {
            january: 0, february: 1, march: 2, april: 3, may: 4, june: 5,
            july: 6, august: 7, september: 8, october: 9, november: 10, december: 11,
            jan: 0, feb: 1, mar: 2, apr: 3, jun: 5, jul: 6, aug: 7,
            sep: 8, sept: 8, oct: 9, nov: 10, dec: 11,
        };
        const weekdays = {
            sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6,
        };
        const pad = (n) => String(n).padStart(2, '0');
        const parseAmPmHour = (hourRaw, minuteRaw, ampmRaw) => {
            let hour = parseInt(hourRaw, 10);
            const minute = parseInt(minuteRaw || '0', 10);
            const ampm = String(ampmRaw || '').toLowerCase().replace(/\./g, '');
            if (ampm.startsWith('p') && hour < 12)
                hour += 12;
            if (ampm.startsWith('a') && hour == 12)
                hour = 0;
            return { hour, minute };
        };
        const toIsoPt = (year, monthIndex, day, hour, minute) => {
            const startIso = `${year}-${pad(monthIndex + 1)}-${pad(day)}T${pad(hour)}:${pad(minute)}:00-07:00`;
            const endMinuteTotal = minute + 30;
            const endHour = hour + Math.floor(endMinuteTotal / 60);
            const endMin = endMinuteTotal % 60;
            const endIso = `${year}-${pad(monthIndex + 1)}-${pad(day)}T${pad(endHour)}:${pad(endMin)}:00-07:00`;
            return { start: startIso, end: endIso };
        };
        // PT wall-clock "now" via fixed -07 offset (Demo Shop hours are PDT season)
        const now = new Date();
        const ptNow = new Date(now.getTime() - 7 * 3600 * 1000);
        const ptY = ptNow.getUTCFullYear();
        const ptM = ptNow.getUTCMonth();
        const ptD = ptNow.getUTCDate();
        const ptDow = ptNow.getUTCDay();
        const ptMins = ptNow.getUTCHours() * 60 + ptNow.getUTCMinutes();

        // VERA_DEMO_SHOP_BOOKTRUTH_20260905 — reject business-hours line bleed ("9 AM to 5 PM")
        const isBusinessHoursBleed = (src, matchStart, matchEnd) => {
            const left = src.slice(Math.max(0, matchStart - 56), matchStart);
            const right = src.slice(matchEnd, Math.min(src.length, matchEnd + 56));
            const around = (left + ' ' + right).toLowerCase();
            if (/\b(open|hours|between|from)\b/.test(around) && /\b(to|through|thru|until|-)\b/.test(around))
                return true;
            const matched = src.slice(matchStart, matchEnd);
            if (/\b(through|thru|to|until)\b/i.test(matched) && !/\bat\b/i.test(matched))
                return true;
            if (/\b(to|through|thru|until)\s+\d{1,2}/i.test(right) && !/\bat\b/i.test(src.slice(Math.max(0, matchStart - 8), matchStart + 4)))
                return true;
            if (/\d{1,2}(?:[:.\s]?\d{2})?\s*(a\.?m\.?|p\.?m\.?)\s*(to|through|thru|until|-)\s*$/i.test(left))
                return true;
            return false;
        };

        const monthRe = /\b(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)\s+(\d{1,2})(?:st|nd|rd|th)?(?:\s*,?\s*(\d{4}))?\s*(?:at\s+)?(\d{1,2})(?:[:.](\d{2})|([0-5]\d))?\s*(a\.?m\.?|p\.?m\.?)/i;
        const wdRe = /\b(?:this\s+(?:coming\s+)?)?(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b(?:[^\d]{0,48}?)(?:at\s+)?(\d{1,2})(?:[:.](\d{2})|([0-5]\d))?\s*(a\.?m\.?|p\.?m\.?)/i;
        const relRe = /\b(today|tomorrow|next\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday))\b(?:[^\d]{0,48}?)(?:at\s+)?(\d{1,2})(?:[:.](\d{2})|([0-5]\d))?\s*(a\.?m\.?|p\.?m\.?)/i;

        const tryResolveFrom = (src, labelPrefix) => {
            if (!src || !String(src).trim())
                return null;

            // VERA_DEMO_SHOP_CONTACTCLOCK_20260905 — "Tuesday at noon" / "tomorrow at midnight"
            const namedToHm = (word) => {
                const w = String(word || '').toLowerCase();
                if (w === 'noon')
                    return { hour: 12, minute: 0 };
                if (w === 'midnight')
                    return { hour: 0, minute: 0 };
                return null;
            };
            const resolveWeekdayHm = (weekdayRaw, hour, minute, source) => {
                const targetDow = weekdays[String(weekdayRaw).toLowerCase()];
                if (targetDow == null)
                    return null;
                let delta = (targetDow - ptDow + 7) % 7;
                if (delta === 0 && ptMins >= hour * 60 + minute)
                    delta = 7;
                const target = new Date(Date.UTC(ptY, ptM, ptD + delta));
                const iso = toIsoPt(target.getUTCFullYear(), target.getUTCMonth(), target.getUTCDate(), hour, minute);
                return { ...iso, startSource: source };
            };
            const namedWd = /\b(?:this\s+(?:coming\s+)?)?(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b(?:[^\n]{0,40}?)(?:at\s+)?(noon|midnight)\b/i.exec(src);
            if (namedWd) {
                const hm = namedToHm(namedWd[2]);
                if (hm) {
                    const resolvedNamed = resolveWeekdayHm(namedWd[1], hm.hour, hm.minute, `${labelPrefix}_weekday_named_clock`);
                    if (resolvedNamed)
                        return resolvedNamed;
                }
            }
            const namedRel = /\b(today|tomorrow|next\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday))\b(?:[^\n]{0,40}?)(?:at\s+)?(noon|midnight)\b/i.exec(src);
            if (namedRel) {
                const hm = namedToHm(namedRel[3]);
                if (hm) {
                    let delta = 0;
                    const kind = namedRel[1].toLowerCase();
                    if (kind === 'tomorrow')
                        delta = 1;
                    else if (kind.startsWith('next ')) {
                        const targetDow = weekdays[namedRel[2].toLowerCase()];
                        delta = (targetDow - ptDow + 7) % 7;
                        if (delta === 0)
                            delta = 7;
                    }
                    const target = new Date(Date.UTC(ptY, ptM, ptD + delta));
                    const iso = toIsoPt(target.getUTCFullYear(), target.getUTCMonth(), target.getUTCDate(), hm.hour, hm.minute);
                    return { ...iso, startSource: `${labelPrefix}_relative_named_clock` };
                }
            }

            // Prefer explicit "at <clock>" with optional weekday (anti hours-bleed)
            const atClock = /(?:\b(?:this\s+(?:coming\s+)?)?(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b[^\d]{0,40}?)?\bat\s+(\d{1,2})(?:[:.](\d{2})|([0-5]\d))?\s*(a\.?m\.?|p\.?m\.?)\b/i.exec(src);
            if (atClock && atClock[5]) {
                const minuteRaw = atClock[3] || atClock[4] || '0';
                const { hour, minute } = parseAmPmHour(atClock[2], minuteRaw, atClock[5]);
                if (atClock[1]) {
                    const targetDow = weekdays[atClock[1].toLowerCase()];
                    let delta = (targetDow - ptDow + 7) % 7;
                    if (delta === 0 && ptMins >= hour * 60 + minute)
                        delta = 7;
                    const target = new Date(Date.UTC(ptY, ptM, ptD + delta));
                    const iso = toIsoPt(target.getUTCFullYear(), target.getUTCMonth(), target.getUTCDate(), hour, minute);
                    return { ...iso, startSource: `${labelPrefix}_at_weekday_clock` };
                }
            }

            const mm = monthRe.exec(src);
            if (mm && mm[7]) {
                const month = months[mm[1].toLowerCase()];
                const day = parseInt(mm[2], 10);
                let year = mm[3] ? parseInt(mm[3], 10) : ptY;
                const minuteRaw = mm[5] || mm[6] || '0';
                const { hour, minute } = parseAmPmHour(mm[4], minuteRaw, mm[7]);
                if (!isBusinessHoursBleed(src, mm.index, mm.index + mm[0].length)) {
                    const guess = Date.UTC(year, month, day, hour + 7, minute);
                    if (!mm[3] && guess < now.getTime() - 86400000)
                        year += 1;
                    const iso = toIsoPt(year, month, day, hour, minute);
                    return { ...iso, startSource: `${labelPrefix}_month_day_time` };
                }
            }

            const w = wdRe.exec(src);
            if (w && w[5]) {
                if (!isBusinessHoursBleed(src, w.index, w.index + w[0].length)) {
                    const targetDow = weekdays[w[1].toLowerCase()];
                    const minuteRaw = w[3] || w[4] || '0';
                    const { hour, minute } = parseAmPmHour(w[2], minuteRaw, w[5]);
                    let delta = (targetDow - ptDow + 7) % 7;
                    if (delta === 0 && ptMins >= hour * 60 + minute)
                        delta = 7;
                    const target = new Date(Date.UTC(ptY, ptM, ptD + delta));
                    const iso = toIsoPt(target.getUTCFullYear(), target.getUTCMonth(), target.getUTCDate(), hour, minute);
                    return { ...iso, startSource: `${labelPrefix}_weekday_time` };
                }
            }

            const r = relRe.exec(src);
            if (r && r[3] && r[6]) {
                if (!isBusinessHoursBleed(src, r.index, r.index + r[0].length)) {
                    const minuteRaw = r[4] || r[5] || '0';
                    const { hour, minute } = parseAmPmHour(r[3], minuteRaw, r[6]);
                    let delta = 0;
                    const kind = r[1].toLowerCase();
                    if (kind === 'tomorrow')
                        delta = 1;
                    else if (kind.startsWith('next ')) {
                        const targetDow = weekdays[r[2].toLowerCase()];
                        delta = (targetDow - ptDow + 7) % 7;
                        if (delta === 0)
                            delta = 7;
                    }
                    const target = new Date(Date.UTC(ptY, ptM, ptD + delta));
                    const iso = toIsoPt(target.getUTCFullYear(), target.getUTCMonth(), target.getUTCDate(), hour, minute);
                    return { ...iso, startSource: `${labelPrefix}_relative_time` };
                }
            }
            return null;
        };

        // Prefer user-spoken clock over assistant hours / confirmation echo
        let resolved = tryResolveFrom(userText, 'user') || tryResolveFrom(fullText, 'full');
        if (!resolved)
            resolved = tryResolveFrom(assistantText, 'assistant');

        let startIso = resolved ? resolved.start : null;
        let endIso = resolved ? resolved.end : null;
        let startSource = resolved ? resolved.startSource : null;

        let name = this.extractDemoShopCallerName(list);
        let phone = this.demoShopDtmfPhone || this.extractDemoShopPhone(userText) || this.extractDemoShopPhone(fullText);
        let email = null;
        const em = /([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})/i.exec(userText) ||
            /([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})/i.exec(fullText);
        if (em)
            email = em[1];

        // VERA_DEMO_SHOP_TURN_20260905 — hangup junk blocked by PT-offset start (no UTC invent).
        // VERA_DEMO_SHOP_BOOKTRUTH_20260905 — write needs name + (phone|email).
        // VERA_DEMO_SHOP_PLAYSERIAL_20260907 — name+contact+PT start is enough (no magic confirm
        // phrase). Confirm regex looked at assistant "I've got you down", which rewrite strips,
        // so a complete booking never became writable.
        const startIsPt = !!(startIso && (String(startIso).includes('-07:00') || String(startIso).includes('-08:00') || /America\/Los_Angeles/i.test(String(startIso))));
        const hasName = !!name;
        const hasContact = !!(phone || email);
        const slotReady = !!(startIso && startIsPt);
        const scheduleable = !!(slotReady && (confirmed || (hasName && hasContact)));
        const writable = !!(slotReady && hasName && hasContact);
        return {
            start: startIso,
            end: endIso,
            name,
            phone,
            email,
            confirmed,
            confirmSignal,
            startSource,
            transcript,
            scheduleable,
            hasName,
            hasContact,
            writable,
        };
    }
    maybeDemoShopMidCallBook(_assistantText) {
        // VERA_DEMO_SHOP_BOOKTRUTH_20260905 — POST /book only when scheduleable + name + (phone|email)
        if (this.tenantId !== 'demo-shop')
            return Promise.resolve(false);
        if (this.fullTenantConfig?.usageLimits?.features?.calendarIntegration === false)
            return Promise.resolve(false);
        if (this.demoShopMidCallBookPosted)
            return Promise.resolve(true);
        if (this.demoShopMidCallBookInFlight && this.demoShopMidCallBookPromise)
            return this.demoShopMidCallBookPromise;
        const booking = this.normalizeDemoShopBooking(this.conversationHistory);
        if (!booking.writable) {
            if (booking.confirmed && !booking.start) {
                log_1.log.info({
                    event: 'demo_shop_midcall_book_skip_no_start',
                    confirm_signal: booking.confirmSignal,
                    ...this.logContext,
                }, 'demo shop mid-call book skipped — confirmed but no resolvable start');
            }
            else if (booking.scheduleable && (!booking.hasName || !booking.hasContact)) {
                log_1.log.info({
                    event: 'demo_shop_midcall_book_skip_no_contact',
                    confirm_signal: booking.confirmSignal,
                    start: booking.start,
                    start_source: booking.startSource,
                    has_name: !!booking.hasName,
                    has_contact: !!booking.hasContact,
                    name: booking.name || null,
                    ...this.logContext,
                }, 'demo shop mid-call book skipped — need name + phone/email (bare Yes must not book)');
            }
            return Promise.resolve(false);
        }
        this.demoShopMidCallBookInFlight = true;
        this.demoShopMidCallBookPromise = this.postDemoShopBook(booking).then((ok) => {
            if (!ok)
                this.demoShopMidCallBookPromise = null;
            return ok;
        }).finally(() => {
            this.demoShopMidCallBookInFlight = false;
        });
        return this.demoShopMidCallBookPromise;
    }
    maybeDemoShopHangupBook() {
        // VERA_DEMO_SHOP_TURN_20260905 — no UTC invent (start must be PT).
        // VERA_DEMO_SHOP_PLAYSERIAL_20260907 — hangup writes when name+contact+PT start exist
        // (same as mid-call). Confirm phrase is optional.
        if (this.tenantId !== 'demo-shop')
            return;
        if (this.demoShopMidCallBookPosted)
            return;
        if (this.demoShopMidCallBookInFlight)
            return;
        this.demoShopMidCallBookPromise = null;
        const booking = this.normalizeDemoShopBooking(this.conversationHistory);
        const startOk = this.isDemoShopResolvedPtStart(booking.start);
        // VERA_DEMO_SHOP_BOOKTRUTH_20260905 — hangup also needs name + (phone|email)
        if (!startOk || !booking.writable) {
            log_1.log.info({
                event: 'demo_shop_hangup_book_skip',
                confirmed: !!booking.confirmed,
                confirm_signal: booking.confirmSignal,
                start: booking.start,
                start_source: booking.startSource,
                start_ok_pt: startOk,
                scheduleable: !!booking.scheduleable,
                writable: !!booking.writable,
                has_name: !!booking.hasName,
                has_contact: !!booking.hasContact,
                ...this.logContext,
            }, 'demo shop hangup book skipped — need resolved PT start + name + contact');
            return;
        }
        this.demoShopMidCallBookInFlight = true;
        this.demoShopMidCallBookPromise = this.postDemoShopBook(booking).then((ok) => {
            if (!ok)
                this.demoShopMidCallBookPromise = null;
            return ok;
        }).finally(() => {
            this.demoShopMidCallBookInFlight = false;
        });
        return this.demoShopMidCallBookPromise;
    }
    async postDemoShopBook(extracted) {
        const url = 'http://demo-shop-book-helper:8791/book';
        const body = {
            tenantId: this.tenantId,
            callControlId: this.callControlId,
            callId: this.callControlId,
            callerId: this.from,
            name: extracted.name,
            phone: extracted.phone,
            email: extracted.email,
            start: extracted.start,
            end: extracted.end,
            title: extracted.name
                ? `Demo Shop booking — ${extracted.name}`
                : `Demo Shop booking — ${this.from || 'Caller'}`,
            transcript: extracted.transcript,
            // VERA_DEMO_SHOP_BOOKCONFIRM_20260907 — complete slot is the confirm
            confirmSignal: extracted.confirmSignal || extracted.writable || false,
            startSource: extracted.startSource,
        };
        try {
            const resp = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
                signal: AbortSignal.timeout(15000),
            });
            const text = await resp.text().catch(() => '');
            let json = {};
            try {
                json = text ? JSON.parse(text) : {};
            }
            catch {
                json = {};
            }
            if (resp.ok && json.ok) {
                this.demoShopMidCallBookPosted = true;
                log_1.log.info({
                    event: 'demo_shop_midcall_book_ok',
                    eventId: json.eventId,
                    leadId: json.lead && json.lead.leadId,
                    duplicate: !!json.duplicate,
                    start: extracted.start,
                    confirm_signal: extracted.confirmSignal,
                    start_source: extracted.startSource,
                    name: extracted.name || null,
                    ...this.logContext,
                }, 'demo shop book succeeded');
                return true;
            }
            log_1.log.warn({
                event: 'demo_shop_midcall_book_failed',
                status: resp.status,
                body_snippet: text.slice(0, 400),
                ...this.logContext,
            }, 'demo shop book failed');
            return false;
        }
        catch (error) {
            log_1.log.warn({
                err: serializeCaughtError(error),
                event: 'demo_shop_midcall_book_error',
                ...this.logContext,
            }, 'demo shop book error');
            return false;
        }
    }

    /**
     * VERA_DEMO_SHOP_FIX_20260904
     * Running control-plane only fires call_ended workflows when an in-memory call
     * exists for this callId. Runtime currently POSTs action=end with the Telnyx
     * call_control_id, which was never created (start mints a UUID). Result: hangup
     * reports OK but store_lead / book-helper never run, including when the last
     * assistant turn was fallback_error. Register a call, attach transcript history,
     * then end so handleCallEnded actually enqueues.
     */
    async ensureCallEndedWorkflowFires() {
        if (this.callEndedWorkflowEnsured)
            return;
        this.callEndedWorkflowEnsured = true;
        const base = (env_1.env.CONTROL_PLANE_URL || '').replace(/\/$/, '');
        const apiKey = env_1.env.CONTROL_PLANE_API_KEY;
        if (!base || !apiKey)
            return;
        const snapshot = this.getCallTranscript();
        if (!snapshot.turns || snapshot.turns.length === 0)
            return;
        const transcriptText = `call_control_id: ${this.callControlId}\n` + snapshot.turns.map((t) => `${t.role}: ${t.content}`).join('\n');
        const url = `${base}/api/runtime/calls`;
        const headers = {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
        };
        const post = async (body) => {
            const resp = await fetch(url, {
                method: 'POST',
                headers,
                body: JSON.stringify(body),
                signal: AbortSignal.timeout(10000),
            });
            const text = await resp.text().catch(() => '');
            let json = {};
            try {
                json = text ? JSON.parse(text) : {};
            }
            catch {
                json = {};
            }
            if (!resp.ok) {
                log_1.log.warn({
                    event: 'call_ended_workflow_post_failed',
                    action: body.action,
                    status: resp.status,
                    body_snippet: text.slice(0, 300),
                    ...this.logContext,
                }, 'call_ended workflow register post failed');
            }
            return { ok: resp.ok, status: resp.status, json };
        };
        try {
            const started = await post({
                tenantId: this.tenantId,
                action: 'start',
                callState: { callerId: this.from },
            });
            const registeredId = started.json?.callId;
            if (!registeredId) {
                log_1.log.warn({ event: 'call_ended_workflow_missing_call_id', ...this.logContext }, 'control plane start did not return callId');
                return;
            }
            await post({
                tenantId: this.tenantId,
                callId: registeredId,
                action: 'update',
                callState: {
                    callerId: this.from,
                    stage: 'end',
                    history: snapshot.turns,
                },
            });
            const ended = await post({
                tenantId: this.tenantId,
                callId: registeredId,
                action: 'end',
                transcript: transcriptText,
                callState: {
                    callerId: this.from,
                    stage: 'end',
                    history: snapshot.turns,
                },
            });
            log_1.log.info({
                event: 'call_ended_workflow_ensured',
                workflow_call_id: registeredId,
                telnyx_call_control_id: this.callControlId,
                turns: snapshot.turns.length,
                end_ok: ended.ok,
                ...this.logContext,
            }, 'call_ended workflow ensured from hangup transcript');
        }
        catch (error) {
            log_1.log.warn({
                err: serializeCaughtError(error),
                event: 'call_ended_workflow_ensure_error',
                ...this.logContext,
            }, 'call_ended workflow ensure failed');
        }
    }
    getState() {
        return this.state;
    }
    getTransport() {
        return this.transport;
    }
    /**
     * Transfer the call to another number or SIP URI. Only supported on PSTN (Telnyx).
     * After transfer, Telnyx will send call.bridged or call.hangup; session teardown is handled normally.
     */
    async transferCall(to, options) {
        if (!this.transport.transfer) {
            log_1.log.warn({ event: 'transfer_not_supported', mode: this.transport.mode, ...this.logContext }, 'transfer not supported on this transport');
            return;
        }
        if (!this.active) {
            log_1.log.warn({ event: 'transfer_ignored_inactive', ...this.logContext }, 'transfer ignored: call inactive');
            return;
        }
        try {
            const awaitTargetOutcome = Boolean(options?.targetLegClientState);
            if (awaitTargetOutcome) {
                this.transferPending = true;
                this.clearDeadAirTimer();
            }
            else {
                this.markEnded('transfer');
            }
            await this.transport.transfer(to, options);
            log_1.log.info({ event: 'call_transfer_requested', to, ...this.logContext }, 'call transfer requested');
        }
        catch (error) {
            log_1.log.error({ err: error, to, ...this.logContext }, 'call transfer failed');
            this.transferPending = false;
            this.active = true; // revert markEnded so session can continue
            throw error;
        }
    }
    onTransferAnswered() {
        if (!this.transferPending)
            return;
        this.transferPending = false;
        this.markEnded('transfer_answered');
        this.end();
    }
    async onTransferFailed(reason) {
        if (!this.transferPending)
            return;
        this.transferPending = false;
        this.active = true;
        await this.playAssistantTurn("I couldn't reach the on-call person. I've created an urgent task for the shop instead.", `transfer-failed-${this.nextTurnId()}`);
        if (this.active && this.state !== 'ENDED') {
            this.enterListeningState(true);
        }
        log_1.log.warn({ event: 'oncall_transfer_failed_resumed', reason, ...this.logContext }, 'on-call transfer failed; caller session resumed');
    }
    isActive() {
        return this.active;
    }
    markEnded(reason) {
        if (!this.active) {
            if (!this.endedReason) {
                this.endedReason = reason;
            }
            return;
        }
        this.active = false;
        this.endedAt = Date.now();
        // If Whisper is in-flight, allow a brief window to accept the FINAL transcript.
        // This is log/history only — no assistant reply, no TTS.
        if (this.sttInFlightCount > 0) {
            this.lateFinalGraceUntilMs = this.endedAt + this.lateFinalGraceMs;
            log_1.log.info({
                event: 'late_final_grace_armed',
                reason,
                stt_in_flight: this.sttInFlightCount,
                grace_ms: this.lateFinalGraceMs,
                grace_until_ms: this.lateFinalGraceUntilMs,
                ...this.logContext,
            }, 'late final grace armed');
        }
        this.endedReason = reason;
        this.audioCoordinator.onHangup(this.endedAt, reason);
        log_1.log.info({ event: 'call_marked_inactive', reason, ...this.logContext }, 'call marked inactive');
        this.emitLatencyReport(reason);
    }
    getEndInfo() {
        return {
            endedAt: this.endedAt,
            endedReason: this.endedReason,
        };
    }
    getMetrics() {
        return {
            createdAt: new Date(this.metrics.createdAt),
            lastHeardAt: this.metrics.lastHeardAt ? new Date(this.metrics.lastHeardAt) : undefined,
            turns: this.metrics.turns,
            transcriptsTotal: this.metrics.transcriptsTotal,
            transcriptsEmpty: this.metrics.transcriptsEmpty,
            totalUtteranceMs: this.metrics.totalUtteranceMs,
            totalTranscribedChars: this.metrics.totalTranscribedChars,
        };
    }
    getTenantRuntimeConfig() {
        return this.fullTenantConfig;
    }
    snapshotQualitySignals() {
        const audioInvariants = this.ensureAudioInvariantReport('teardown');
        return {
            ...this.qualitySignals,
            sttLatencyMs: [...this.qualitySignals.sttLatencyMs],
            ttsLatencyMs: [...this.qualitySignals.ttsLatencyMs],
            llmLatencyMs: [...this.qualitySignals.llmLatencyMs],
            audioInvariants,
        };
    }
    ensureAudioInvariantReport(reason) {
        // VERA_DEMO_SHOP_AUDIOINV_20260907 — classify SID vs product-class audio fails; do not retune decode
        if (this.audioInvariantReportLast)
            return this.audioInvariantReportLast;
        const report = (0, audioInvariantReport_1.buildAudioInvariantReport)({
            counters: (0, audioInvariantReport_1.snapshotAudioInvariantCounters)(this.callControlId),
            callDurationMs: Date.now() - (this.callStartedAtMs || this.metrics.createdAt.getTime()),
            playbackPstnSampleRateHz: env_1.env.PLAYBACK_PSTN_SAMPLE_RATE,
            aecEnabled: env_1.env.STT_AEC_ENABLED === true,
            transportMode: this.transport.mode,
        });
        this.audioInvariantReportLast = report;
        (0, audioInvariantReport_1.clearAudioInvariantCounters)(this.callControlId);
        log_1.log.info({
            event: 'audio_invariant_report',
            reason: reason || 'teardown',
            ...report,
            ...this.logContext,
        }, 'audio invariant report');
        return report;
    }
    getLastActivityAt() {
        return this.metrics.lastHeardAt ?? this.metrics.createdAt;
    }
    appendTranscriptSegment(segment) {
        if (segment.trim() === '') {
            return;
        }
        this.transcriptBuffer.push(segment);
    }
    captureLateFinalTranscript(text) {
        const trimmed = text.trim();
        if (!trimmed)
            return;
        // Keep a record for debugging + analytics:
        this.appendTranscriptSegment(trimmed);
        this.appendHistory({ role: 'user', content: trimmed, timestamp: new Date() });
        const preview = trimmed.length <= this.logPreviewChars
            ? trimmed
            : `${trimmed.slice(0, this.logPreviewChars - 3)}...`;
        log_1.log.info({
            event: 'late_final_captured',
            transcript_length: trimmed.length,
            transcript_preview: preview,
            ended_reason: this.endedReason,
            ended_at: this.endedAt,
            stt_in_flight: this.sttInFlightCount,
            ...this.logContext,
        }, 'late final transcript captured after hangup');
        // Try to get an assistant reply and play it before teardown (media may already be closed).
        void this.tryRespondToLateFinal(trimmed);
    }
    /** Merges Redis assistantContext with derived business-hours status for the brain. */
    brainAssistantContext() {
        const base = {};
        if (this.assistantContext) {
            for (const [k, v] of Object.entries(this.assistantContext)) {
                if (typeof v === 'string' && v.trim()) {
                    base[k] = v;
                }
            }
        }
        const bh = this.fullTenantConfig?.llmContext?.businessHours;
        const ev = (0, shared_1.evaluateBusinessHours)(bh, new Date());
        const features = this.fullTenantConfig?.usageLimits?.features;
        const afterHoursEnabled = features?.afterHoursMode !== false;
        const lines = [
            ev.isOpen ? 'Current status: OPEN (within scheduled hours).' : 'Current status: CLOSED (outside scheduled hours).',
            ev.summary ? `Weekly schedule:\n${ev.summary}` : '',
            afterHoursEnabled && !ev.isOpen && ev.afterHoursMessage ? `After-hours message for callers: ${ev.afterHoursMessage}` : '',
        ].filter(Boolean);
        if (lines.length) {
            base['Business schedule'] = lines.join('\n\n');
        }
        if (features) {
            base['Calendar'] = features.calendarIntegration
                ? 'Booking is enabled. Collect a preferred time and confirm the appointment.'
                : 'Booking is not included on this plan. Take a message instead of promising a calendar slot.';
            base['SMS follow-up'] = features.smsFollowup
                ? 'A confirmation text is sent after the call when a caller number is known.'
                : 'Do not promise a text follow-up. This plan does not include SMS follow-up.';
            base['Call recording'] = features.callRecording
                ? 'This call is recorded. Mention recording only if the caller asks.'
                : 'This call is not recorded. Do not tell the caller they are being recorded.';
            base['Priority support'] = features.prioritySupport
                ? 'On-call paging is allowed, including during quiet hours.'
                : 'On-call paging is blocked during quiet hours.';
            base['Transfer lines'] = features.multiLocation
                ? 'Transfer to a person or desk when the caller asks to be connected.'
                : 'Transfers are not included. Take a message instead of handing the caller off.';
        }
        if (this.cidMatch?.name) {
            base['Existing customer'] = this.cidMatch.name;
        }
        if (this.cidMatch?.openJobs?.length) {
            base['Open jobs'] = this.cidMatch.openJobs.map((job) => job.title || job.id).join(', ');
        }
        if (this.cidMatch?.membership) {
            base['Membership'] = this.cidMatch.membership;
        }
        if (this.cidMatch?.warranty) {
            base['Warranty'] = this.cidMatch.warranty;
        }
        // VERA_DEMO_SHOP_TURN_20260905 — keep voice turns short; never invent services
        // VERA_DEMO_SHOP_MUSTBOOK_20260905 — book demos on this call; never handoff/callback to schedule
        // VERA_DEMO_SHOP_CONVOFEEL_20260906 — night-desk conversational, not one-slot form-fill
        if (this.tenantId === 'demo-shop') {
            base['Demo Shop voice rules'] = [
                'Sound like a warm night-desk receptionist on a live phone, not a form.',
                'Brief acknowledgments are good. You may combine related asks in one short turn (name + phone/email, or day + morning/afternoon).',
                'Do not interrogate one field per turn unless the caller is confused.',
                'Keep spoken answers short and phone-natural — one breath, then a question. No list cadence.',
                'Never invent services or products the caller did not mention (no "spiritual demo", spa packages, etc.).',
                'Allowed topics: demo, appointment, booking, name, phone, email, day/time.',
                'If the caller is unclear, ask: Are you calling to book a demo?',
                'You ARE the receptionist who books demos on this call.',
                'NEVER say you will have Nicholas / a human / someone follow up, call back, or schedule later instead of booking now.',
                'Obey the Call board. HAVE is done — do not re-ask. Phone OR email is enough; never ask for the other once one is HAVE.',
                'They may say a ten-digit phone number or tap it on the keypad. Either is enough. Do not ask them to do both.',
                'Never say they are booked, all set, or that you scheduled them unless the Call board says the write succeeded.',
                'NEXT is the only question. No bullet lists. No extra fields.',
                'Do not offer handoff/callback as the path to schedule.',
                // VERA_DEMO_SHOP_NO_REGREET_20260906
                'After you first greet the caller by name, do not start later turns with Hi, Hello, or Hey plus their name, or Great to meet you. Continue the conversation. Use the name later only sparingly (final booking confirm), never as a default turn opener.',
                // VERA_DEMO_SHOP_PICKUP_HISTORY_20260906
                'The pickup greeting was already spoken to the caller. You are mid-call. Do not re-open with Hi/Hello/Hey, do not introduce yourself, and do not say your name. Continue from the caller\'s last line.',
            ].join(' ');
        }
        const board = this.buildTalkerBoardText();
        if (board) {
            base['Call board'] = board;
        }
        return base;
    }
    buildTalkerBoardText() {
        if (this.tenantId !== 'demo-shop')
            return null;
        const booking = this.normalizeDemoShopBooking(this.conversationHistory);
        const slots = (0, talkerBoard_1.buildDemoShopTalkerBoard)({
            name: booking.name || null,
            start: booking.start || null,
            startSpeak: booking.start ? this.formatDemoShopConfirmDateFromIso(booking.start) : null,
            phone: booking.phone || null,
            email: booking.email || null,
            writable: !!booking.writable,
            posted: !!this.demoShopMidCallBookPosted,
        });
        const text = (0, talkerBoard_1.formatTalkerBoard)(slots);
        const key = `${slots.next}|${slots.missing.join(',')}|${!!this.demoShopMidCallBookPosted}`;
        if (key !== this.lastTalkerBoardKey) {
            this.lastTalkerBoardKey = key;
            log_1.log.info({
                event: 'talker_board',
                marker: 'VERA_DEMO_SHOP_SLOTCARD_20260907',
                next: slots.next,
                missing: slots.missing,
                have_labels: slots.have.map((line) => String(line).split(':')[0]),
                writable: !!booking.writable,
                posted: !!this.demoShopMidCallBookPosted,
                ...this.logContext,
            }, 'talker call board');
        }
        return text;
    }
    async applyNightDeskGate(userText, replyText) {
        const lead = (0, shopGate_1.extractNightDeskLead)({
            history: this.conversationHistory,
            callerId: this.from,
            existingCustomerName: this.cidMatch?.name,
            membership: this.cidMatch?.membership,
        });
        if (this.cidMatch?.warranty)
            lead.warranty = this.cidMatch.warranty;
        if (this.demoShopMidCallBookPosted)
            lead.bookingAdapter = 'gcal_helper';
        const hours = (0, shared_1.evaluateBusinessHours)(this.fullTenantConfig?.llmContext?.businessHours, new Date());
        const remote = await (0, controlPlane_1.evaluateNightDeskTurn)({
            tenantId: this.tenantId || '',
            callId: this.callControlId,
            callerId: this.from,
            utterance: userText,
            proposedReply: replyText,
            transcript: this.conversationHistory.map((turn) => `${turn.role}: ${turn.content}`).join('\n'),
            lead,
            afterHours: this.fullTenantConfig?.usageLimits?.features?.afterHoursMode !== false && !hours.isOpen,
            existingOpenJobs: this.cidMatch?.openJobs?.length,
            membership: this.cidMatch?.membership,
        });
        if (remote) {
            if (remote.persisted && remote.completion) {
                this.nightDeskCompletion = remote.completion;
            }
            return {
                text: remote.text,
                transferTo: remote.transfer?.to,
                timeoutSecs: remote.transfer?.timeoutSecs,
                pageId: remote.transfer?.pageId,
            };
        }
        const local = (0, shopGate_1.applyShopSpeakGate)({
            playbookRaw: (0, shopGate_1.playbookFromTenant)(this.fullTenantConfig),
            transferProfiles: this.transferProfiles,
            userText,
            replyText,
            existingOpenJobs: this.cidMatch?.openJobs?.length,
            membership: this.cidMatch?.membership,
        });
        if (local.completion === 'booked' || local.completion === 'approval_held') {
            return {
                text: 'I cannot write that next step right now, so I will not claim it is booked or held. Please try again.',
            };
        }
        return {
            text: local.text,
            transferTo: local.transferTo,
            timeoutSecs: local.timeoutSecs,
        };
    }
    /**
     * When we capture a late final (transcript arrived after hangup), try to respond so the user
     * might still hear an answer if the media path is briefly open. Always calls settleLateFinalGrace
     * when done so teardown runs.
     */
    async tryRespondToLateFinal(transcript) {
        this.isRespondingToLateFinal = true;
        try {
            if (this.fullTenantConfig?.shopPlaybook)
                return;
            let response = '';
            try {
                const quick = this.tryMatchQuickReply(transcript);
                if (quick) {
                    response = quick.text;
                }
                else {
                    const reply = await (0, brainClient_1.generateAssistantReply)({
                        tenantId: this.tenantId,
                        tenantConfig: this.fullTenantConfig,
                        callControlId: this.callControlId,
                        transcript,
                        history: this.conversationHistory,
                        transferProfiles: this.transferProfiles,
                        assistantContext: this.brainAssistantContext(),
                        prompts: this.tenantPrompts,
                    });
                    response = reply.text;
                }
                log_1.log.info({
                    event: 'late_final_assistant_reply',
                    transcript_length: transcript.length,
                    reply_length: response.length,
                    ...this.logContext,
                }, 'late final assistant reply generated');
            }
            catch (error) {
                log_1.log.warn({ err: error, transcript_length: transcript.length, ...this.logContext }, 'late final assistant reply failed');
            }
            if (response.trim()) {
                this.appendHistory({ role: 'assistant', content: response, timestamp: new Date() });
                await this.playText(response, `late-final-${this.nextTurnId()}`, {
                    allowWhenEndedForLateFinal: true,
                });
            }
        }
        catch (error) {
            log_1.log.warn({ err: error, ...this.logContext }, 'late final response (play) failed');
        }
        finally {
            this.isRespondingToLateFinal = false;
            this.settleLateFinalGrace();
        }
    }
    appendHistory(turn) {
        this.conversationHistory.push(turn);
        this.metrics.turns += 1;
        if (turn.role === 'assistant') {
            const c = typeof turn.content === 'string' ? turn.content.trim() : '';
            if (c.length > 0)
                this.pushAssistantEchoReference(c);
            // VERA_DEMO_SHOP_NORMALIZE_20260904 — normalize-then-write mid-call
            if (c.length > 0)
                this.maybeDemoShopMidCallBook(c);
            // VERA_DEMO_SHOP_HARDEN_20260904 — raise STT max-utt while collecting phone/email
            if (c.length > 0)
                this.syncDemoShopContactMaxUtt(c);
        }
    }
    pushAssistantEchoReference(text) {
        const t = text.trim();
        if (t.length < 2)
            return;
        this.assistantEchoReferenceLines.unshift(t);
        if (this.assistantEchoReferenceLines.length > 10)
            this.assistantEchoReferenceLines.length = 10;
    }
    getAssistantEchoCandidates() {
        return [...this.assistantEchoReferenceLines];
    }
    /** Full call transcript (caller + assistant text only, no audio). Use at teardown for summarizer / logs. */
    getCallTranscript(endedAt) {
        const now = endedAt ?? new Date();
        const turns = this.conversationHistory.map((t) => ({
            role: t.role,
            content: t.content,
            timestamp: t.timestamp instanceof Date ? t.timestamp.toISOString() : String(t.timestamp),
        }));
        const startedAt = this.metrics.createdAt;
        const durationMs = now.getTime() - startedAt.getTime();
        return {
            callControlId: this.callControlId,
            tenantId: this.tenantId,
            from: this.from,
            to: this.to,
            startedAt: startedAt.toISOString(),
            endedAt: now.toISOString(),
            durationMs,
            turns,
        };
    }
    // ==================== Voice Mode Management (Hot-Swap) ====================
    /**
     * Get the current voice mode ('preset' or 'cloned').
     * Meaningful for XTTS and Chatterbox HTTP (reference-audio) modes.
     */
    getVoiceMode() {
        return this.currentVoiceMode;
    }
    /**
     * Set the voice mode for this call session. Enables hot-swap between preset and cloned voices.
     * Takes effect on the next TTS synthesis (ongoing playback is not interrupted).
     *
     * @param mode 'preset' to use built-in voice_id, 'cloned' to use reference audio
     * @param speakerWavUrl Optional override URL for cloned voice (if not using tenant config)
     */
    setVoiceMode(mode, speakerWavUrl) {
        const previousMode = this.currentVoiceMode;
        this.currentVoiceMode = mode;
        if (speakerWavUrl) {
            this.voiceModeOverrideSpeakerWavUrl = speakerWavUrl;
        }
        log_1.log.info({
            event: 'voice_mode_changed',
            previous_mode: previousMode,
            new_mode: mode,
            has_override_url: !!speakerWavUrl,
            ...this.logContext,
        }, 'voice mode changed');
    }
    /**
     * Check if voice cloning is available for this session.
     * Returns true if XTTS or Chatterbox mode and a reference speaker URL is configured.
     */
    isVoiceCloningAvailable() {
        if (this.ttsConfig?.mode !== 'coqui_xtts' &&
            this.ttsConfig?.mode !== 'chatterbox_http') {
            return false;
        }
        return !!(this.voiceModeOverrideSpeakerWavUrl ||
            this.ttsConfig.clonedVoice?.speakerWavUrl ||
            this.ttsConfig.speakerWavUrl);
    }
    /**
     * Get the effective speakerWavUrl for the current voice mode.
     * Returns undefined for 'preset' mode (uses voice_id), or the cloned voice URL for 'cloned' mode.
     */
    getCurrentSpeakerWavUrl() {
        // Override takes precedence
        if (this.currentVoiceMode === 'cloned' && this.voiceModeOverrideSpeakerWavUrl) {
            return this.voiceModeOverrideSpeakerWavUrl;
        }
        // Use helper to get from tenant config
        return (0, tenantConfig_1.getEffectiveSpeakerWavUrl)(this.ttsConfig, this.currentVoiceMode);
    }
    /**
     * Get voice mode info for external visibility (API, brain responses, etc.)
     */
    getVoiceModeInfo() {
        const available = this.isVoiceCloningAvailable();
        const clonedVoiceLabel = this.ttsConfig?.mode === 'coqui_xtts' ||
            this.ttsConfig?.mode === 'chatterbox_http'
            ? this.ttsConfig.clonedVoice?.label
            : undefined;
        return {
            mode: this.currentVoiceMode,
            available,
            clonedVoiceLabel,
        };
    }
    // Called specifically when Telnyx sends call.playback.ended webhook
    onTelnyxPlaybackEnded(meta) {
        // 🔒 PLAYBACK_END_TRANSITION (authoritative: pstn=webhook, webrtc=transport)
        if (this.transport.mode !== 'pstn') {
            log_1.log.warn({
                event: 'telnyx_playback_ended_ignored_non_pstn',
                requestId: meta?.requestId,
                source: meta?.source ?? 'unknown',
                mode: this.transport.mode,
                state: this.state,
                ...this.logContext,
            }, 'ignoring telnyx playback ended for non-pstn transport');
            return;
        }
        // Optional: log the authoritative webhook arrival
        log_1.log.info({
            event: 'telnyx_playback_ended_webhook',
            requestId: meta?.requestId,
            source: meta?.source ?? 'unknown',
            state: this.state,
            playback_active: this.playbackState.active,
            tts_queue_depth: this.ttsSegmentQueueDepth,
            ...this.logContext,
        }, 'telnyx playback ended (webhook)');
        (0, audioForensics_1.forensicsTimeline)(this.callControlId, {
            event: 'playback_ended_webhook',
            wallClockMs: Date.now(),
            audioClockMs: (0, audioForensics_1.getForensicsSession)(this.callControlId)?.sessionAudioClockMs ?? null,
            state: this.state,
            playbackActive: this.playbackState.active,
            listening: this.isListening(),
        });
        // VERA_DEMO_SHOP_PSTN_WAIT_20260905 — release per-segment waiter before full end
        this.resolveDemoShopPstnSegmentWait('webhook');
        this.endPlaybackAuthoritatively('webhook');
    }
    onPlaybackEnded() {
        // 🔒 PSTN AUTHORITY GUARD
        // 🔒 PSTN AUTHORITY GUARD (with failsafe)
        // Primary path: only accept playback end via endPlaybackAuthoritatively().
        // Failsafe: if playback is still active, accept and clean up anyway to avoid stuck state.
        if (this.transport.mode === 'pstn' && this.pstnPlaybackEndAuthority === null) {
            if (!this.playbackState.active) {
                log_1.log.warn({ event: 'playback_end_ignored_non_authoritative', state: this.state, ...this.logContext }, 'ignoring onPlaybackEnded() on pstn (non-authoritative caller)');
                return;
            }
            // Failsafe: accept cleanup to prevent permanent stuck playback gate
            log_1.log.warn({ event: 'playback_end_non_authoritative_failsafe', state: this.state, ...this.logContext }, 'accepting onPlaybackEnded() on pstn without authority (failsafe)');
        }
        const now = Date.now();
        // ✅ CLEAR watchdog (do NOT arm it here)
        if (this.pstnPlaybackWatchdog) {
            clearTimeout(this.pstnPlaybackWatchdog);
            this.pstnPlaybackWatchdog = undefined;
        }
        this.pstnPlaybackWatchdogFor = undefined;
        // If playback already inactive, just normalize state + notify coordinator
        if (!this.playbackState.active) {
            log_1.log.info({ event: 'playback_end_ignored_already_inactive', state: this.state, ...this.logContext }, 'playback end ignored (already inactive)');
            if (this.active && this.state === 'SPEAKING') {
                this.state = 'ANSWERED';
                this.listeningSinceAtMs = 0;
            }
            this.audioCoordinator.onPlaybackEnded(now);
            return;
        }
        // ✅ If streaming segments are still queued, do NOT end playback yet.
        // Segment queue drain will call onPlaybackEnded() (non-PSTN) when depth hits 0.
        // VERA_DEMO_SHOP_PSTN_WAIT_20260905 — mid-chain webhook already resolved the segment
        // waiter; keep gate open and re-arm watchdog for the next segment.
        if (this.ttsSegmentQueueDepth > 0 && !this.playbackState.interrupted) {
            if (this.tenantId === 'demo-shop' && this.transport.mode === 'pstn') {
                this.armPstnPlaybackWatchdog();
            }
            return;
        }
        const wasInterrupted = this.playbackState.interrupted;
        // Tier 2: capture segment duration for measured listen-after-playback grace
        const segMs = this.playbackState.segmentDurationMs;
        if (segMs != null && segMs > 0) {
            this.lastPlaybackSegmentDurationMs = segMs;
        }
        // ✅ ALWAYS clear playback flags FIRST
        this.playbackState.active = false;
        this.playbackState.interrupted = false;
        this.playbackState.segmentId = undefined;
        this.playbackState.segmentDurationMs = undefined;
        // VERA_DEMO_SHOP_SPEAKERPHONE_20260905
        this.demoShopTtsPlaybackStartAtMs = 0;
        this.demoShopTelnyxPlayStartedAtMs = 0;
        // VERA_DEMO_SHOP_LISTENOPEN_20260907 — leftover greeting far-end still AEC-cancels the next user turn
        if (this.tenantId === 'demo-shop') {
            let leftoverFarEnd = 0;
            while ((0, farEndReference_1.pullFarEndFrame)(this.callControlId))
                leftoverFarEnd += 1;
            (0, aecProcessor_1.resetAecProcessor)(this.callControlId);
            if (leftoverFarEnd > 0) {
                log_1.log.info({
                    event: 'demo_shop_far_end_flushed_on_playback_end',
                    marker: 'VERA_DEMO_SHOP_LISTENOPEN_20260907',
                    leftover_frames: leftoverFarEnd,
                    leftover_ms: leftoverFarEnd * 20,
                    ...this.logContext,
                }, 'flushed leftover AEC far-end after playback end');
            }
        }
        // ✅ resolve + clear stop signal
        this.resolvePlaybackStopSignal();
        this.playbackStopSignal = undefined;
        if (wasInterrupted) {
            log_1.log.info({ event: 'playback_ended_after_barge_in', ...this.logContext }, 'playback ended after barge-in');
            // VERA_DEMO_SHOP_BARGE_SUSTAIN_20260906 — wait local stop + short settle
            // before LISTENING / deferred finals (aborted mouth-noise must not become a turn).
            if (this.tenantId === 'demo-shop') {
                this.demoShopLastBargeAtMs = now;
                this.demoShopBargeSettleUntilMs = 0;
                this.enterListeningState(false);
            }
            else if (this.active && this.state !== 'ENDED') {
                this.enterListeningState(false);
            }
            if (this.active && this.tenantId !== 'demo-shop') {
                this.flushDeferredTranscript();
                if (!this.isHandlingTranscript && this.state === 'LISTENING') {
                    this.scheduleDeadAirTimer();
                }
            }
            this.markLatency('playback_ended_at_ms');
            this.finalizeLatencyTurn('barge_in');
            this.startRxDumpAfterPlayback();
            this.audioCoordinator.onPlaybackEnded(now);
            return;
        }
        // ✅ normal playback end: enter LISTENING (but don't arm dead-air immediately)
        if (this.active && this.state !== 'ENDED') {
            this.enterListeningState(false);
        }
        // ✅ consume deferred FINAL immediately (no reprompt racing)
        if (this.active) {
            this.flushDeferredTranscript();
            if (!this.isHandlingTranscript && this.state === 'LISTENING') {
                this.scheduleDeadAirTimer();
            }
        }
        this.markLatency('playback_ended_at_ms');
        this.finalizeLatencyTurn('playback_ended');
        this.startRxDumpAfterPlayback();
        this.audioCoordinator.onPlaybackEnded(now);
    }
    createPlaybackStopSignal() {
        let resolve;
        const promise = new Promise((resolver) => {
            resolve = resolver;
        });
        return { promise, resolve: resolve };
    }
    /** Tier 2: compute listen-after-playback grace (300–900ms) from last segment length. */
    computePostPlaybackGraceMs() {
        // VERA_DEMO_SHOP_CONVOFEEL_20260906 — Demo Shop only: tighter 240–420ms so the line
        // does not sit idle ~0.7–0.9s after she finishes (SPEAKERPHONE loud-flush still wins).
        const demoShop = this.tenantId === 'demo-shop';
        const minMs = demoShop ? 240 : (env_1.env.STT_POST_PLAYBACK_GRACE_MIN_MS ?? 300);
        const maxMs = demoShop ? 420 : (env_1.env.STT_POST_PLAYBACK_GRACE_MAX_MS ?? 900);
        const fixedMs = demoShop ? undefined : env_1.env.STT_POST_PLAYBACK_GRACE_MS;
        let base;
        if (this.lastPlaybackSegmentDurationMs <= 0) {
            base = fixedMs ?? minMs;
        }
        else {
            const growth = (this.lastPlaybackSegmentDurationMs / 4000) * (maxMs - minMs);
            base = Math.round(Math.min(maxMs, Math.max(minMs, minMs + growth)));
        }
        const mode = (0, echoSuppression_1.getEchoSuppressionMode)();
        if (!demoShop && mode === 'conservative')
            return Math.round(base * 1.18);
        if (mode === 'permissive')
            return Math.round(base * 0.93);
        return base;
    }
    armPstnPlaybackWatchdog() {
        if (this.transport.mode !== 'pstn')
            return;
        if (this.pstnPlaybackWatchdog) {
            clearTimeout(this.pstnPlaybackWatchdog);
            this.pstnPlaybackWatchdog = undefined;
        }
        this.pstnPlaybackWatchdogFor = this.playbackState.segmentId;
        this.pstnPlaybackWatchdog = setTimeout(() => {
            if (!this.active || this.state === 'ENDED')
                return;
            if (!this.playbackState.active)
                return;
            // ✅ stale watchdog guard
            // If playback was interrupted, segmentId may be cleared; still allow watchdog cleanup.
            if (!this.playbackState.interrupted && this.pstnPlaybackWatchdogFor !== this.playbackState.segmentId) {
                return;
            }
            log_1.log.warn({ event: 'pstn_playback_watchdog_fired', state: this.state, ...this.logContext }, 'forcing playback end (telnyx playback.ended webhook missing/delayed)');
            this.endPlaybackAuthoritatively('watchdog');
        }, this.pstnPlaybackWatchdogMs);
        this.pstnPlaybackWatchdog.unref?.();
    }
    beginPlayback(segmentId) {
        if (this.playbackState.active) {
            (0, audioInvariantReport_1.recordStackedPlay)(this.callControlId);
        }
        if (!this.playbackState.active) {
            this.playbackStopSignal = this.createPlaybackStopSignal();
        }
        this.playbackState.active = true;
        (0, aecProcessor_1.resetAecProcessor)(this.callControlId);
        this.playbackState.interrupted = false;
        this.playbackState.segmentId = segmentId;
        this.state = 'SPEAKING';
        this.clearDeadAirTimer();
        this.resetRxDump();
        // ✅ PSTN safety: don't let playback gate stay closed forever if webhook is missed
        this.armPstnPlaybackWatchdog();
    }
    resolvePlaybackStopSignal() {
        if (this.playbackStopSignal) {
            this.playbackStopSignal.resolve();
            this.playbackStopSignal = undefined;
        }
    }
    clearTtsQueue() {
        this.ttsSegmentChainEpoch = (this.ttsSegmentChainEpoch || 0) + 1;
        // VERA_DEMO_SHOP_PLAYSERIAL_20260907 — drop in-flight playText after rewrite/stop
        this.demoShopPlayEpoch = (this.demoShopPlayEpoch || 0) + 1;
        this.ttsSegmentChain = Promise.resolve();
        this.ttsSegmentQueueDepth = 0;
        // VERA_DEMO_SHOP_PSTN_WAIT_20260905
        this.resolveDemoShopPstnSegmentWait('clear_queue');
    }
    invalidateTranscriptHandling() {
        this.transcriptHandlingToken += 1;
        this.isHandlingTranscript = false;
    }
    flushDeferredTranscript() {
        if (!this.deferredTranscript) {
            return;
        }
        if (!this.active || this.state === 'ENDED' || this.isHandlingTranscript) {
            return;
        }
        const deferred = this.deferredTranscript;
        this.deferredTranscript = undefined;
        void this.handleTranscript(deferred.text, deferred.source);
    }
    logTtsBytesReady(id, audio, contentType) {
        const header = (0, wavInfo_1.describeWavHeader)(audio);
        log_1.log.info({
            event: 'tts_bytes_ready',
            id,
            bytes: audio.length,
            riff: header.riff,
            wave: header.wave,
            ...this.logContext,
        }, 'tts bytes ready');
        if (!header.riff || !header.wave) {
            log_1.log.warn({
                event: 'tts_non_wav_warning',
                id,
                content_type: contentType,
                first16_hex: header.first16Hex,
                bytes: audio.length,
                ...this.logContext,
            }, 'tts bytes are not wav');
        }
        const audioLogContext = { ...this.logContext, tts_id: id };
        const baseMeta = {
            callId: this.callControlId,
            tenantId: this.tenantId,
            format: 'wav',
            logContext: audioLogContext,
            lineage: ['tts:output'],
            kind: id,
        };
        (0, audioProbe_1.attachAudioMeta)(audio, baseMeta);
        (0, audioProbe_1.probeWav)('tts.out.raw', audio, baseMeta);
        this.logWavInfo('kokoro', id, audio);
    }
    logWavInfo(source, id, audio) {
        try {
            const info = (0, wavInfo_1.parseWavInfo)(audio);
            log_1.log.info({
                event: 'wav_info',
                source,
                id,
                sample_rate_hz: info.sampleRateHz,
                channels: info.channels,
                bits_per_sample: info.bitsPerSample,
                data_bytes: info.dataBytes,
                duration_ms: info.durationMs,
                ...this.logContext,
            }, 'wav info');
        }
        catch (error) {
            log_1.log.warn({
                event: 'wav_info_parse_failed',
                source,
                id,
                reason: getErrorMessage(error),
                ...this.logContext,
            }, 'wav info parse failed');
        }
    }
    resetTranscriptTracking() {
        this.transcriptAcceptedForUtterance = false;
        this.deferredTranscript = undefined;
        this.firstPartialAt = undefined;
        this.userTurnFinalAcceptedAtMs = null;
        this.userTurnPlaybackLatencyRecorded = false;
    }
    /** SLO: once per user turn, ms from final accepted to first assistant playback.play. */
    maybeRecordTurnFinalToFirstPlaybackMs(tenantLabel) {
        if (this.userTurnFinalAcceptedAtMs == null || this.userTurnPlaybackLatencyRecorded)
            return;
        (0, metrics_1.observeTurnFinalToFirstPlaybackMs)(tenantLabel, Date.now() - this.userTurnFinalAcceptedAtMs);
        this.userTurnPlaybackLatencyRecorded = true;
        this.markLatency('first_audio_at_ms');
        this.logLatencyTurn('first_audio');
    }
    beginLatencyTurn(turnId, extra) {
        if (this.latencyCurrent)
            this.finalizeLatencyTurn('superseded');
        this.latencyCurrent = {
            turn_id: turnId || `turn-${this.turnSequence || 0}`,
            speech_start_at_ms: this.lastSpeechStartAtMs || null,
            final_accepted_at_ms: Date.now(),
            first_token_at_ms: null,
            tts_queued_at_ms: null,
            tts_ready_at_ms: null,
            play_http_at_ms: null,
            first_audio_at_ms: null,
            playback_ended_at_ms: null,
            transcript_chars: extra?.transcript_chars ?? null,
        };
    }
    markLatency(field) {
        if (!this.latencyCurrent || this.latencyCurrent[field] != null)
            return;
        this.latencyCurrent[field] = Date.now();
    }
    latencyDeltas(t) {
        const d = (a, b) => (typeof a === 'number' && typeof b === 'number' ? Math.round(b - a) : null);
        return {
            speech_to_final_ms: d(t.speech_start_at_ms, t.final_accepted_at_ms),
            final_to_first_token_ms: d(t.final_accepted_at_ms, t.first_token_at_ms),
            first_token_to_tts_queued_ms: d(t.first_token_at_ms, t.tts_queued_at_ms),
            tts_queued_to_ready_ms: d(t.tts_queued_at_ms, t.tts_ready_at_ms),
            tts_ready_to_play_http_ms: d(t.tts_ready_at_ms, t.play_http_at_ms),
            final_to_first_audio_ms: d(t.final_accepted_at_ms, t.first_audio_at_ms),
            play_to_ended_ms: d(t.first_audio_at_ms, t.playback_ended_at_ms),
        };
    }
    logLatencyTurn(reason) {
        if (!this.latencyCurrent)
            return;
        const t = this.latencyCurrent;
        log_1.log.info({
            event: 'call_latency_turn',
            reason,
            ...t,
            ...this.latencyDeltas(t),
            ...this.logContext,
        }, 'call latency turn');
    }
    finalizeLatencyTurn(reason) {
        if (!this.latencyCurrent)
            return;
        this.logLatencyTurn(reason);
        this.latencyTurns.push({ ...this.latencyCurrent, ...this.latencyDeltas(this.latencyCurrent), reason });
        this.latencyCurrent = null;
    }
    emitLatencyReport(reason) {
        if (this.latencyReportEmitted)
            return;
        this.latencyReportEmitted = true;
        if (this.latencyCurrent)
            this.finalizeLatencyTurn(`incomplete_${reason}`);
        const turns = this.latencyTurns;
        const nums = (k) => turns.map((t) => t[k]).filter((n) => typeof n === 'number');
        const avg = (arr) => arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : null;
        const min = (arr) => arr.length ? Math.min(...arr) : null;
        const max = (arr) => arr.length ? Math.max(...arr) : null;
        const stat = (k) => {
            const arr = nums(k);
            return { avg: avg(arr), min: min(arr), max: max(arr), n: arr.length };
        };
        log_1.log.info({
            event: 'call_latency_report',
            reason,
            call_duration_ms: Date.now() - this.callStartedAtMs,
            turn_count: turns.length,
            feel_final_to_first_audio_ms: stat('final_to_first_audio_ms'),
            speech_to_final_ms: stat('speech_to_final_ms'),
            final_to_first_token_ms: stat('final_to_first_token_ms'),
            first_token_to_tts_queued_ms: stat('first_token_to_tts_queued_ms'),
            tts_queued_to_ready_ms: stat('tts_queued_to_ready_ms'),
            tts_ready_to_play_http_ms: stat('tts_ready_to_play_http_ms'),
            play_to_ended_ms: stat('play_to_ended_ms'),
            turns,
            ...this.logContext,
        }, 'call latency report');
        this.ensureAudioInvariantReport(reason);
    }
    getUnclearRepromptPhrases() {
        if (this.unclearPhrasesCache)
            return this.unclearPhrasesCache;
        const raw = env_1.env.STT_UNCLEAR_REPROMPT_PHRASES?.trim();
        if (raw) {
            this.unclearPhrasesCache = raw.split('|').map((s) => s.trim()).filter(Boolean);
        }
        if (!this.unclearPhrasesCache?.length) {
            this.unclearPhrasesCache = [...DEFAULT_UNCLEAR_REPROMPT_PHRASES];
        }
        return this.unclearPhrasesCache;
    }
    /**
     * TTS reprompt when STT did not yield usable text (empty/error after retries, filler-only final, etc.).
     */
    async tryPlayUnclearReprompt(reason, detail) {
        if (!env_1.env.STT_UNCLEAR_REPROMPT_ENABLED)
            return;
        if (!this.active || this.state === 'ENDED')
            return;
        if (this.repromptInFlight || this.isHandlingTranscript)
            return;
        // VERA_DEMO_SHOP_SPEAKERPHONE_20260905 — never "I didn't catch that" for empty/near-silent barge-handoff scraps
        // VERA_DEMO_SHOP_LISTENFINAL_20260905 — long empty finals get one re-ask (not 14s dead air)
        if (this.tenantId === 'demo-shop' && reason === 'stt_empty_final') {
            const uttMs = Number(detail?.utterance_ms ?? detail?.utteranceMs ?? 0);
            const nearSilentOrShort = !Number.isFinite(uttMs) || uttMs <= 0 || uttMs < 450;
            if (nearSilentOrShort) {
                log_1.log.info({
                    event: 'demo_shop_silent_empty_final',
                    reason,
                    utterance_ms: Number.isFinite(uttMs) ? uttMs : null,
                    near_silent_or_short: true,
                    state: this.state,
                    ...this.logContext,
                    ...detail,
                }, 'demo-shop: discard empty final silently (no unclear reprompt)');
                if (this.active && this.state === 'LISTENING') {
                    this.scheduleDeadAirTimer();
                }
                return;
            }
            if (this.demoShopEmptyReaskThisListen) {
                log_1.log.info({
                    event: 'demo_shop_empty_final_reask_capped',
                    reason,
                    utterance_ms: Number.isFinite(uttMs) ? uttMs : null,
                    state: this.state,
                    ...this.logContext,
                    ...detail,
                }, 'demo-shop: already re-asked this listen window; stay silent');
                if (this.active && this.state === 'LISTENING') {
                    this.scheduleDeadAirTimer();
                }
                return;
            }
            this.demoShopEmptyReaskThisListen = true;
            log_1.log.info({
                event: 'demo_shop_empty_final_reask',
                reason,
                utterance_ms: Number.isFinite(uttMs) ? uttMs : null,
                near_silent_or_short: false,
                state: this.state,
                ...this.logContext,
                ...detail,
            }, 'demo-shop: long empty final — one unclear re-ask');
        }
        if (this.isPlaybackActive()) {
            log_1.log.debug({ event: 'unclear_reprompt_skipped_playback', reason, ...this.logContext, ...detail }, 'skip unclear reprompt during playback');
            return;
        }
        const max = env_1.env.STT_UNCLEAR_REPROMPT_MAX_PER_CALL;
        if (max > 0 && this.unclearRepromptCount >= max) {
            log_1.log.warn({
                event: 'unclear_reprompt_cap',
                reason,
                max_per_call: max,
                ...this.logContext,
                ...detail,
            }, 'unclear reprompt cap reached');
            return;
        }
        const now = Date.now();
        const cooldown = env_1.env.STT_UNCLEAR_REPROMPT_COOLDOWN_MS;
        if (this.lastUnclearRepromptAtMs > 0 && now - this.lastUnclearRepromptAtMs < cooldown) {
            log_1.log.debug({
                event: 'unclear_reprompt_skipped_cooldown',
                reason,
                cooldown_ms: cooldown,
                ...this.logContext,
            }, 'unclear reprompt cooldown');
            return;
        }
        const phrases = this.getUnclearRepromptPhrases();
        const phrase = phrases[this.unclearRepromptCount % phrases.length] ?? phrases[0];
        this.unclearRepromptCount += 1;
        this.lastUnclearRepromptAtMs = now;
        (0, metrics_1.incUnclearReprompt)(reason);
        this.repromptInFlight = true;
        const turnId = `unclear-${reason}-${this.nextTurnId()}`;
        log_1.log.info({
            event: 'call_session_unclear_reprompt',
            reason,
            phrase_index: this.unclearRepromptCount - 1,
            ...this.logContext,
            ...detail,
        }, 'playing unclear-transcript reprompt');
        try {
            await this.playText(phrase, turnId);
        }
        catch (error) {
            log_1.log.warn({ err: error, reason, ...this.logContext }, 'unclear reprompt playText failed');
        }
        finally {
            this.repromptInFlight = false;
            this.resetTranscriptTracking();
            if (this.active && this.state === 'LISTENING') {
                this.scheduleDeadAirTimer();
            }
        }
    }
    async onFinalPipelineOutcome(outcome) {
        if (outcome.kind === 'success')
            return;
        try {
            await this.tryPlayUnclearReprompt(outcome.kind === 'empty' ? 'stt_empty_final' : 'stt_provider_error', {
                attempts: outcome.attempts,
                utterance_ms: outcome.utteranceMs,
                ...(outcome.kind === 'error' ? { error: getErrorMessage(outcome.error) } : {}),
            });
        }
        catch (error) {
            log_1.log.warn({ err: error, ...this.logContext }, 'onFinalPipelineOutcome failed');
        }
    }
    shouldTriggerPartialFastPath(text) {
        // VERA_DEMO_SHOP_BARGE_SUSTAIN_20260906 — never promote aborted fragments via partial fast path
        if (this.tenantId === 'demo-shop')
            return false;
        const trimmed = text.trim();
        if (!trimmed)
            return false;
        if (/[.!?]$/.test(trimmed))
            return true;
        return trimmed.length >= PARTIAL_FAST_PATH_MIN_CHARS;
    }
    handleSpeechStart(info) {
        if (!this.active || this.state === 'ENDED') {
            return;
        }
        this.lastSpeechStartAtMs = Date.now();
        this.audioCoordinator.onSpeechStart(info.prependedMs ?? 0, this.lastSpeechStartAtMs);
        this.resetTranscriptTracking();
        const playbackActive = this.isPlaybackActive();
        if (!playbackActive || this.playbackState.interrupted) {
            return;
        }
        // VERA_DEMO_SHOP_SPEAKERPHONE_20260905 — defense in depth: same early-ignore as onBargeInDetected
        if (this.tenantId === 'demo-shop') {
            const now = Date.now();
            const startedAt = this.demoShopTtsPlaybackStartAtMs || 0;
            const telnyxStartedAt = this.demoShopTelnyxPlayStartedAtMs || 0;
            const msSinceTtsStart = startedAt > 0 ? now - startedAt : null;
            const telnyxPlayNotStarted = startedAt > 0 && telnyxStartedAt <= 0;
            const inEarlyWindow = startedAt > 0 && msSinceTtsStart != null && msSinceTtsStart < 500;
            if (telnyxPlayNotStarted || inEarlyWindow) {
                log_1.log.info({
                    event: 'stt_barge_in_ignored_speakerphone_protect',
                    path: 'handleSpeechStart',
                    rms: info?.rms,
                    peak: info?.peak,
                    streak: info?.streak,
                    ms_since_tts_playback_start: msSinceTtsStart,
                    telnyx_play_started: telnyxStartedAt > 0,
                    ...this.logContext,
                }, 'demo-shop speakerphone: ignoring early barge-stop path');
                return;
            }
            const frameMs = Number(info?.frameMs) > 0 ? Number(info.frameMs) : 20;
            const streak = Number(info?.streak) > 0 ? Number(info.streak) : 0;
            const sustainMs = Math.round(streak * frameMs);
            const rms = Number(info?.rms);
            if (sustainMs < 280 || (Number.isFinite(rms) && rms < 0.032)) {
                log_1.log.info({
                    event: 'stt_barge_in_ignored_unsustained',
                    marker: 'VERA_DEMO_SHOP_BARGE_SUSTAIN_20260906',
                    path: 'handleSpeechStart',
                    rms: info?.rms,
                    peak: info?.peak,
                    streak,
                    frame_ms: Math.round(frameMs),
                    sustain_ms: sustainMs,
                    sustain_threshold_ms: 280,
                    ...this.logContext,
                }, 'demo-shop: ignoring unsustained speech-start barge');
                return;
            }
        }
        log_1.log.info({
            event: 'barge_in',
            reason: 'speech_start',
            state: this.state,
            speech_rms: info.rms,
            speech_peak: info.peak,
            speech_frame_ms: Math.round(info.frameMs),
            speech_frame_streak: info.streak,
            ...this.logContext,
        }, 'barge in');
        this.qualitySignals.bargeInDuringPlayback += 1;
        // ✅ mark interrupted, but DO NOT clear active here.
        // onPlaybackEnded() needs active=true to run its cleanup.
        this.playbackState.interrupted = true;
        this.resolvePlaybackStopSignal();
        // ✅ Cancel queued segments without double-manipulating the counter
        // clearTtsQueue() already sets queue depth to 0.
        this.clearTtsQueue();
        this.invalidateTranscriptHandling();
        // ✅ Stop playback first; onPlaybackEnded() will re-enter LISTENING and start rx dump.
        // Avoid double transitions + weird flush timing.
        void this.stopPlayback();
        // VERA_DEMO_SHOP_DUPLEX_20260907 — listen immediately after yield; do not wait 280ms settle
        if (this.tenantId === 'demo-shop') {
            this.demoShopBargeSettleUntilMs = 0;
            if (this.demoShopBargeSettleTimer) {
                clearTimeout(this.demoShopBargeSettleTimer);
                this.demoShopBargeSettleTimer = null;
            }
            log_1.log.info({
                event: 'demo_shop_duplex_listen',
                marker: 'VERA_DEMO_SHOP_DUPLEX_20260907',
                ...this.logContext,
            }, 'demo-shop duplex: listen while her clip yields');
            this.enterListeningState(false);
        }
    }
    async stopPlayback() {
        // We want to stop playback, but we MUST NOT rely on Telnyx webhook timing to unblock state.
        // So on PSTN we perform an authoritative local cleanup after attempting stop().
        try {
            await this.transport.playback.stop();
        }
        catch (error) {
            log_1.log.warn({ err: error, ...this.logContext }, 'playback stop failed');
        }
        finally {
            if (this.transport.mode === 'pstn') {
                // ✅ Authoritative local cleanup (even if webhook is late/missed)
                this.endPlaybackAuthoritatively('watchdog');
                return;
            }
            // Non-PSTN: transport completion is authoritative
            this.onPlaybackEnded();
        }
    }
    enterListeningState(armDeadAir = true, opts) {
        if (!this.active || this.state === 'ENDED') {
            return;
        }
        // VERA_DEMO_SHOP_BARGE_SUSTAIN_20260906 — never arm a new user turn while TTS is playing
        // (true barge stops playback first, then settle-arms). Coordinator / finally must not overlap.
        if (this.tenantId === 'demo-shop' && this.isPlaybackActive() && !this.playbackState.interrupted) {
            log_1.log.info({
                event: 'listening_arm_blocked_playback_active',
                marker: 'VERA_DEMO_SHOP_BARGE_SUSTAIN_20260906',
                state: this.state,
                playback_active: true,
                ...this.logContext,
            }, 'demo-shop: skip listen arm while playback active');
            return;
        }
        if (this.tenantId === 'demo-shop' && !(opts && opts.forceAfterSettle) && this.demoShopBargeSettleUntilMs > Date.now()) {
            this.scheduleDemoShopBargeSettleListen(armDeadAir);
            return;
        }
        this.state = 'LISTENING';
        this.listeningSinceAtMs = Date.now();
        this.demoShopEmptyReaskThisListen = false;
        this.deadAirEligible = false;
        (0, audioForensics_1.forensicsTimeline)(this.callControlId, {
            event: 'listening_armed',
            wallClockMs: Date.now(),
            audioClockMs: (0, audioForensics_1.getForensicsSession)(this.callControlId)?.sessionAudioClockMs ?? null,
            state: this.state,
            playbackActive: this.isPlaybackActive(),
            listening: true,
        });
        if (armDeadAir) {
            if (this.audioCoordinator.isMediaReady()) {
                this.deadAirEligible = true;
                this.scheduleDeadAirTimer();
            }
        }
    }
    /** VERA_DEMO_SHOP_BARGE_SUSTAIN_20260906 — playback stopped + short settle, then listen. */
    scheduleDemoShopBargeSettleListen(armDeadAir) {
        if (this.tenantId !== 'demo-shop')
            return;
        if (this.demoShopBargeSettleTimer) {
            clearTimeout(this.demoShopBargeSettleTimer);
            this.demoShopBargeSettleTimer = null;
        }
        const wait = Math.max(0, this.demoShopBargeSettleUntilMs - Date.now());
        log_1.log.info({
            event: 'demo_shop_barge_settle_armed',
            marker: 'VERA_DEMO_SHOP_BARGE_SUSTAIN_20260906',
            settle_ms: wait,
            ...this.logContext,
        }, 'demo-shop: barge settle before listen / deferred final');
        this.demoShopBargeSettleTimer = setTimeout(() => {
            this.demoShopBargeSettleTimer = null;
            this.demoShopBargeSettleUntilMs = 0;
            if (!this.active || this.state === 'ENDED')
                return;
            if (this.isPlaybackActive() && !this.playbackState.interrupted) {
                log_1.log.info({
                    event: 'listening_arm_blocked_playback_active',
                    marker: 'VERA_DEMO_SHOP_BARGE_SUSTAIN_20260906',
                    path: 'barge_settle',
                    ...this.logContext,
                }, 'demo-shop: settle complete but playback active — skip listen');
                return;
            }
            this.enterListeningState(armDeadAir, { forceAfterSettle: true });
            if (this.deferredTranscript) {
                const pending = this.deferredTranscript;
                if (this.shouldDiscardDemoShopBargeBlip(pending.text)) {
                    log_1.log.info({
                        event: 'demo_shop_barge_blip_discarded',
                        marker: 'VERA_DEMO_SHOP_BARGE_SUSTAIN_20260906',
                        path: 'deferred_flush',
                        transcript_preview: String(pending.text || '').slice(0, 80),
                        ...this.logContext,
                    }, 'demo-shop: discarded aborted barge fragment');
                    this.deferredTranscript = undefined;
                }
                else {
                    this.flushDeferredTranscript();
                }
            }
            if (!this.isHandlingTranscript && this.state === 'LISTENING') {
                this.scheduleDeadAirTimer();
            }
        }, wait);
        this.demoShopBargeSettleTimer.unref?.();
    }
    scheduleDeadAirTimer() {
        if (!this.active || this.state !== 'LISTENING') {
            return;
        }
        if (!this.deadAirEligible) {
            return;
        }
        this.clearDeadAirTimer();
        this.deadAirTimer = setTimeout(() => {
            void this.handleDeadAirTimeout();
        }, this.deadAirMs);
        this.deadAirTimer.unref?.();
        (0, audioForensics_1.forensicsTimeline)(this.callControlId, {
            event: 'dead_air_timer_armed',
            wallClockMs: Date.now(),
            audioClockMs: (0, audioForensics_1.getForensicsSession)(this.callControlId)?.sessionAudioClockMs ?? null,
            state: this.state,
            playbackActive: this.isPlaybackActive(),
            listening: true,
            reason: `dead_air_ms=${this.deadAirMs}`,
        });
    }
    clearDeadAirTimer() {
        if (this.deadAirTimer) {
            clearTimeout(this.deadAirTimer);
            this.deadAirTimer = undefined;
        }
    }
    startRxDumpAfterPlayback() {
        if (!env_1.env.STT_DEBUG_DUMP_RX_WAV) {
            return;
        }
        // clear any prior timer
        if (this.rxDumpFlushTimer) {
            clearTimeout(this.rxDumpFlushTimer);
            this.rxDumpFlushTimer = undefined;
        }
        this.rxDumpActive = true;
        // Flush once we have ~0.8s of post-playback RX (enough for diagnosis); timer below catches partial captures.
        this.rxDumpSamplesTarget = Math.max(1, Math.round(this.rxSampleRateHz * 0.8));
        this.rxDumpSamplesCollected = 0;
        this.rxDumpBuffers = [];
        // Guaranteed flush: write whatever was captured after T+2s so short/silent tails still produce a WAV when any audio arrived.
        this.rxDumpFlushTimer = setTimeout(() => {
            if (this.rxDumpActive && this.rxDumpSamplesCollected > 0) {
                void this.flushRxDump();
            }
            else {
                this.rxDumpActive = false;
            }
        }, 2000);
        this.rxDumpFlushTimer.unref?.();
    }
    resetRxDump() {
        if (this.rxDumpFlushTimer) {
            clearTimeout(this.rxDumpFlushTimer);
            this.rxDumpFlushTimer = undefined;
        }
        this.rxDumpActive = false;
        this.rxDumpSamplesCollected = 0;
        this.rxDumpSamplesTarget = 0;
        this.rxDumpBuffers = [];
    }
    maybeCaptureRxDump(frame) {
        if (!this.rxDumpActive) {
            return;
        }
        const sampleCount = Math.floor(frame.length / 2);
        if (sampleCount <= 0) {
            return;
        }
        this.rxDumpBuffers.push(Buffer.from(frame));
        this.rxDumpSamplesCollected += sampleCount;
        if (this.rxDumpSamplesCollected >= this.rxDumpSamplesTarget) {
            void this.flushRxDump();
        }
    }
    async flushRxDump() {
        if (!this.rxDumpActive) {
            return;
        }
        this.rxDumpActive = false;
        if (this.rxDumpFlushTimer) {
            clearTimeout(this.rxDumpFlushTimer);
            this.rxDumpFlushTimer = undefined;
        }
        const pcmBuffer = Buffer.concat(this.rxDumpBuffers);
        this.rxDumpBuffers = [];
        if (pcmBuffer.length === 0) {
            return;
        }
        const dir = resolveDebugDir();
        const filePath = path_1.default.join(dir, `rx_after_playback_${this.callControlId}_${Date.now()}.wav`);
        try {
            await fs_1.default.promises.mkdir(dir, { recursive: true });
            const wav = encodePcm16Wav(pcmBuffer, this.rxSampleRateHz);
            await fs_1.default.promises.writeFile(filePath, wav);
            log_1.log.info({
                event: 'stt_debug_rx_wav_written',
                file_path: filePath,
                sample_rate_hz: this.rxSampleRateHz,
                bytes: wav.length,
                ...this.logContext,
            }, 'stt debug rx wav written');
        }
        catch (error) {
            log_1.log.warn({ err: error, file_path: filePath, ...this.logContext }, 'stt debug rx wav write failed');
        }
    }
    async handleDeadAirTimeout() {
        if (!this.active || this.state !== 'LISTENING' || this.repromptInFlight) {
            return;
        }
        // If STT is running / request in flight, don't reprompt.
        // (Stronger than isHandlingTranscript. Keep both if you want.)
        if (this.sttInFlightCount && this.sttInFlightCount > 0) {
            this.scheduleDeadAirTimer();
            return;
        }
        if (this.isHandlingTranscript) {
            this.scheduleDeadAirTimer();
            return;
        }
        const now = Date.now();
        log_1.log.info({
            event: 'dead_air_check',
            now,
            state: this.state,
            listening_since_ms: this.listeningSinceAtMs,
            last_inbound_media_ms: this.lastInboundMediaAtMs,
            last_decoded_frame_ms: this.lastDecodedFrameAtMs,
            stt_in_flight: this.sttInFlightCount,
            is_handling_transcript: this.isHandlingTranscript,
            playback_active: this.isPlaybackActive(),
            dead_air_ms: this.deadAirMs,
            dead_air_no_frames_ms: this.deadAirNoFramesMs,
            ...this.logContext,
        }, 'dead air check');
        // 1) Grace right after we enter LISTENING
        if (this.listeningSinceAtMs > 0 && now - this.listeningSinceAtMs < this.deadAirListeningGraceMs) {
            this.scheduleDeadAirTimer();
            return;
        }
        // 2) Grace after speech start (STT might be behind)
        if (this.lastSpeechStartAtMs > 0 && now - this.lastSpeechStartAtMs < this.deadAirAfterSpeechStartGraceMs) {
            this.scheduleDeadAirTimer();
            return;
        }
        // 3) If we recently received inbound media, don't reprompt
        // VERA_DEMO_SHOP_LISTENFINAL_20260905 — PSTN RTP is continuous; do not treat
        // inbound frames as user presence. Keep STT-gate / speech-start deferrals below.
        if (this.tenantId !== 'demo-shop' &&
            this.lastInboundMediaAtMs > 0 && now - this.lastInboundMediaAtMs < this.deadAirNoFramesMs) {
            this.scheduleDeadAirTimer();
            return;
        }
        // 3a) Recent STT gate energy / speech classification but no finalized transcript — avoid reprompt loop
        if (this.lastSttGatePositiveAtMs > 0 &&
            now - this.lastSttGatePositiveAtMs < this.deadAirDeferRecentSttSignalMs) {
            log_1.log.info({
                event: 'dead_air_deferred_recent_speech',
                ms_since_stt_gate_positive: Math.round(now - this.lastSttGatePositiveAtMs),
                defer_window_ms: this.deadAirDeferRecentSttSignalMs,
                stt_in_flight: this.sttInFlightCount,
                ...this.logContext,
            }, 'dead air deferred: recent likely speech at STT gate');
            this.scheduleDeadAirTimer();
            return;
        }
        // 3b) If we have NOT received inbound media since entering LISTENING, never reprompt yet
        if (this.listeningSinceAtMs > 0 &&
            (this.lastInboundMediaAtMs === 0 || this.lastInboundMediaAtMs < this.listeningSinceAtMs)) {
            this.scheduleDeadAirTimer();
            return;
        }
        // 4) Never reprompt during playback/tts
        if (this.isPlaybackActive()) {
            this.scheduleDeadAirTimer();
            return;
        }
        (0, audioForensics_1.forensicsTimeline)(this.callControlId, {
            event: 'dead_air_timer_fired',
            wallClockMs: Date.now(),
            audioClockMs: (0, audioForensics_1.getForensicsSession)(this.callControlId)?.sessionAudioClockMs ?? null,
            state: this.state,
            playbackActive: this.isPlaybackActive(),
            listening: true,
        });
        this.qualitySignals.deadAirFired += 1;
        this.repromptInFlight = true;
        try {
            await this.playText('Are you still there?', `reprompt-${this.nextTurnId()}`);
            log_1.log.info({ event: 'call_session_reprompt', ...this.logContext }, 'dead air reprompt');
        }
        finally {
            this.repromptInFlight = false;
            if (this.state === 'LISTENING') {
                this.listeningSinceAtMs = Date.now(); // ✅ reset grace window baseline
                this.scheduleDeadAirTimer();
            }
        }
    }
    nextForensicsPolicyKey() {
        this.forensicsPolicySeq += 1;
        return `pol-${this.forensicsPolicySeq}`;
    }
    fireForensicsPolicy(payload) {
        const key = this.nextForensicsPolicyKey();
        const s = (0, audioForensics_1.getForensicsSession)(this.callControlId);
        if (!s)
            return;
        void s.writeJson(`transcripts/008_transcript_policy_${key}.json`, payload).catch(() => undefined);
    }
    writeAssistantEchoPolicyArtifact(userFinal, echo) {
        const key = this.nextForensicsPolicyKey();
        const s = (0, audioForensics_1.getForensicsSession)(this.callControlId);
        if (!s)
            return;
        void s
            .writeJson(`transcripts/008_transcript_policy_${key}.json`, {
            decision: 'rejected',
            reason: 'assistant_echo',
            similarity_score: echo.score,
            match_method: echo.method,
            matched_assistant_line: echo.matchedAssistantText ?? null,
            normalized_caller_stt: (0, assistantEcho_1.normalizeForEchoCompare)(userFinal),
            normalized_matched: echo.matchedAssistantText
                ? (0, assistantEcho_1.normalizeForEchoCompare)(echo.matchedAssistantText)
                : null,
            raw_caller_stt: userFinal,
            echo_suppression_mode: (0, echoSuppression_1.getEchoSuppressionMode)(),
        })
            .catch(() => undefined);
    }
    forensicsTranscriptSnippet(text) {
        if (env_1.env.AUDIO_FORENSICS_ALLOW_PII)
            return text;
        return String((0, redaction_1.redactValue)(text, { redactTranscripts: false }));
    }
    buildLlmForensicsHooks(turnId) {
        const safeTurn = turnId.replace(/[^a-zA-Z0-9._-]/g, '_');
        return {
            turnId: safeTurn,
            recordLlmRequestPayload: async (body) => {
                const s = (0, audioForensics_1.getForensicsSession)(this.callControlId);
                if (!s)
                    return;
                await s.writeJson(`llm/009_llm_request_${safeTurn}.json`, body);
                const sessAudio = s.sessionAudioClockMs;
                (0, audioForensics_1.forensicsTimeline)(this.callControlId, {
                    event: 'llm_request_sent',
                    turnId: safeTurn,
                    wallClockMs: Date.now(),
                    audioClockMs: sessAudio,
                    state: this.state,
                    playbackActive: this.isPlaybackActive(),
                    listening: this.isListening(),
                });
            },
            recordLlmResponse: async ({ text, source }) => {
                const s = (0, audioForensics_1.getForensicsSession)(this.callControlId);
                if (!s)
                    return;
                await s.writeText(`llm/010_llm_response_${safeTurn}.txt`, this.forensicsTranscriptSnippet(text));
                await s.writeJson(`llm/010_llm_response_meta_${safeTurn}.json`, { source });
                (0, audioForensics_1.forensicsTimeline)(this.callControlId, {
                    event: 'llm_response_received',
                    turnId: safeTurn,
                    wallClockMs: Date.now(),
                    audioClockMs: s.sessionAudioClockMs,
                    state: this.state,
                    playbackActive: this.isPlaybackActive(),
                    listening: this.isListening(),
                    reason: source,
                });
            },
        };
    }
    async handleTranscript(text, transcriptSource) {
        const now = Date.now();
        const isFinal = transcriptSource === 'final';
        // Allow FINAL transcript briefly after hangup if grace window is armed.
        // NOTE: This is capture-only; we do NOT respond or play audio.
        const allowLateFinalCapture = !this.active &&
            isFinal &&
            this.lateFinalGraceUntilMs > 0 &&
            now <= this.lateFinalGraceUntilMs;
        if (!this.active || this.state === 'ENDED' || this.isHandlingTranscript || this.audioCoordinator.isEnding()) {
            if (allowLateFinalCapture) {
                this.captureLateFinalTranscript(text);
                // After we capture one, close the window to avoid multiple finals.
                this.lateFinalGraceUntilMs = 0;
                return;
            }
            const reason = !this.active
                ? 'inactive'
                : this.state === 'ENDED'
                    ? 'ended'
                    : this.audioCoordinator.isEnding()
                        ? 'ending'
                        : 'already_handling';
            log_1.log.info({
                event: 'transcript_ignored',
                reason,
                transcript_length: text.length,
                transcript_source: transcriptSource ?? 'unknown',
                ...this.logContext,
            }, 'transcript ignored');
            this.fireForensicsPolicy({
                decision: 'rejected',
                reason,
                transcript_source: transcriptSource ?? null,
            });
            return;
        }
        const trimmed = text.trim();
        if (this.tenantId === 'demo-shop' && trimmed && this.shouldDiscardDemoShopBargeBlip(trimmed)) {
            log_1.log.info({
                event: 'demo_shop_barge_blip_discarded',
                marker: 'VERA_DEMO_SHOP_BARGE_SUSTAIN_20260906',
                transcript_preview: trimmed.slice(0, 80),
                transcript_source: transcriptSource ?? 'unknown',
                ...this.logContext,
            }, 'demo-shop: discarded aborted barge fragment (no LLM turn)');
            this.fireForensicsPolicy({
                decision: 'rejected',
                reason: 'demo_shop_barge_blip',
                transcript_source: transcriptSource ?? null,
            });
            return;
        }
        if (this.tenantId === 'demo-shop' && trimmed && this.demoShopBargeSettleUntilMs > Date.now()) {
            this.deferredTranscript = { text: trimmed, source: isFinal ? 'final' : (transcriptSource || 'final') };
            log_1.log.info({
                event: 'transcript_deferred_barge_settle',
                marker: 'VERA_DEMO_SHOP_BARGE_SUSTAIN_20260906',
                transcript_preview: trimmed.slice(0, 80),
                settle_remaining_ms: this.demoShopBargeSettleUntilMs - now,
                ...this.logContext,
            }, 'demo-shop: defer final until barge settle');
            return;
        }
        if (trimmed === '') {
            log_1.log.info({
                event: 'transcript_ignored_empty',
                transcript_length: text.length,
                transcript_source: transcriptSource ?? 'unknown',
                ...this.logContext,
            }, 'transcript ignored (empty)');
            this.fireForensicsPolicy({
                decision: 'rejected',
                reason: 'empty_after_trim',
                transcript_source: transcriptSource ?? null,
            });
            (0, audioForensics_1.forensicsTimeline)(this.callControlId, {
                event: 'transcript_empty',
                wallClockMs: Date.now(),
                state: this.state,
                playbackActive: this.isPlaybackActive(),
                listening: this.isListening(),
            });
            return;
        }
        const isPartial = transcriptSource === 'partial_fallback';
        if (isFinal &&
            env_1.env.STT_UNCLEAR_REPROMPT_ENABLED &&
            ((0, transcriptClarity_1.isFillerOrNoiseTranscript)(trimmed) ||
                (env_1.env.STT_UNCLEAR_MIN_LETTERS > 0 && (0, transcriptClarity_1.isTooShortForIntent)(trimmed, env_1.env.STT_UNCLEAR_MIN_LETTERS)))) {
            log_1.log.info({
                event: 'transcript_unclear_filler_or_short',
                transcript_preview: trimmed.length <= this.logPreviewChars
                    ? trimmed
                    : `${trimmed.slice(0, this.logPreviewChars - 3)}...`,
                min_letters: env_1.env.STT_UNCLEAR_MIN_LETTERS,
                ...this.logContext,
            }, 'final transcript treated as unclear (filler/short); reprompting');
            await this.tryPlayUnclearReprompt('stt_filler_or_short', {
                transcript_preview: trimmed.length <= this.logPreviewChars
                    ? trimmed
                    : `${trimmed.slice(0, this.logPreviewChars - 3)}...`,
            });
            this.fireForensicsPolicy({
                decision: 'rejected',
                reason: 'unclear_filler_or_short',
                transcript_preview_snippet: this.forensicsTranscriptSnippet(trimmed).slice(0, 200),
            });
            (0, audioForensics_1.forensicsTimeline)(this.callControlId, {
                event: 'transcript_rejected',
                wallClockMs: Date.now(),
                reason: 'unclear_filler_or_short',
                state: this.state,
                playbackActive: this.isPlaybackActive(),
                listening: this.isListening(),
            });
            return;
        }
        const trigger = isPartial ? 'partial' : 'final';
        // If we've already accepted a transcript for this utterance, ignore anything else.
        if (this.transcriptAcceptedForUtterance) {
            const src = transcriptSource ?? 'unknown';
            (0, metrics_1.incTranscriptIgnoredAfterAccept)(src);
            log_1.log.info({
                event: 'transcript_ignored_duplicate',
                duplicate_gate: 'utterance_already_accepted',
                transcript_length: trimmed.length,
                transcript_source: src,
                ...this.logContext,
            }, 'transcript ignored (duplicate)');
            this.fireForensicsPolicy({
                decision: 'rejected',
                reason: 'utterance_already_accepted',
                transcript_source: src,
            });
            (0, audioForensics_1.forensicsTimeline)(this.callControlId, {
                event: 'transcript_rejected',
                wallClockMs: Date.now(),
                reason: 'utterance_already_accepted',
                state: this.state,
                playbackActive: this.isPlaybackActive(),
                listening: this.isListening(),
            });
            return;
        }
        // ===== CHANGE #1 (CORE FIX): partials DO NOT trigger a turn =====
        // We only buffer partials for debugging/visibility. The agent reply + TTS is final-only.
        if (isPartial) {
            if (!this.firstPartialAt) {
                this.firstPartialAt = Date.now();
            }
            // Keep the latest partial around (useful for debugging and optional future fallback logic)
            this.deferredTranscript = { text: trimmed, source: 'partial_fallback' };
            const partialPreview = trimmed.length <= this.logPreviewChars
                ? trimmed
                : `${trimmed.slice(0, this.logPreviewChars - 3)}...`;
            log_1.log.info({
                event: 'partial_buffered_no_turn',
                trigger: 'partial',
                transcript_length: trimmed.length,
                transcript_preview: partialPreview,
                state: this.state,
                ...this.logContext,
            }, 'partial buffered (final-only turn policy)');
            // IMPORTANT: do not set transcriptAcceptedForUtterance here.
            return;
        }
        // ===== From here on: FINAL ONLY =====
        // If playback is active and not interrupted, defer the FINAL until playback ends.
        const playbackActive = this.isPlaybackActive();
        if (playbackActive && !this.playbackState.interrupted) {
            this.deferredTranscript = { text: trimmed, source: 'final' };
            log_1.log.info({
                event: 'transcript_deferred_playback',
                trigger: 'final',
                transcript_length: trimmed.length,
                state: this.state,
                playback_active: this.playbackState.active,
                tts_queue_depth: this.ttsSegmentQueueDepth,
                ...this.logContext,
            }, 'final transcript deferred during playback');
            this.fireForensicsPolicy({
                decision: 'deferred',
                reason: 'playback_active',
                transcript_preview_snippet: this.forensicsTranscriptSnippet(trimmed).slice(0, 200),
            });
            this.qualitySignals.transcriptDeferred += 1;
            (0, audioForensics_1.forensicsTimeline)(this.callControlId, {
                event: 'transcript_deferred',
                wallClockMs: Date.now(),
                reason: 'playback_active',
                state: this.state,
                playbackActive: true,
                listening: this.isListening(),
            });
            return;
        }
        if (isFinal && env_1.env.STT_TRANSCRIPT_DEDUPE_ENABLED && this.lastUserFinalForDedupeAtMs > 0) {
            const nearDupKind = this.lastUserFinalForDedupeText.length > 0 &&
                Date.now() - this.lastUserFinalForDedupeAtMs <= env_1.env.STT_TRANSCRIPT_DEDUPE_WINDOW_MS
                ? (0, transcriptClarity_1.classifyNearDuplicateMatch)(trimmed, this.lastUserFinalForDedupeText, env_1.env.STT_TRANSCRIPT_DEDUPE_SIMILARITY)
                : null;
            if (nearDupKind) {
                (0, metrics_1.incTranscriptNearDuplicateSuppressed)(nearDupKind);
                log_1.log.info({
                    event: 'transcript_near_duplicate_suppressed',
                    duplicate_gate: 'near_duplicate_transcript',
                    near_duplicate_match_kind: nearDupKind,
                    transcript_preview: trimmed.length <= this.logPreviewChars
                        ? trimmed
                        : `${trimmed.slice(0, this.logPreviewChars - 3)}...`,
                    prior_preview: this.lastUserFinalForDedupeText.length <= this.logPreviewChars
                        ? this.lastUserFinalForDedupeText
                        : `${this.lastUserFinalForDedupeText.slice(0, this.logPreviewChars - 3)}...`,
                    window_ms: env_1.env.STT_TRANSCRIPT_DEDUPE_WINDOW_MS,
                    ...this.logContext,
                }, 'suppressing near-duplicate final transcript (same utterance / echo)');
                this.fireForensicsPolicy({
                    decision: 'rejected',
                    reason: 'near_duplicate_transcript',
                    near_duplicate_match_kind: nearDupKind,
                });
                (0, audioForensics_1.forensicsTimeline)(this.callControlId, {
                    event: 'transcript_rejected',
                    wallClockMs: Date.now(),
                    reason: 'near_duplicate',
                    state: this.state,
                    playbackActive: this.isPlaybackActive(),
                    listening: this.isListening(),
                });
                this.qualitySignals.transcriptNearDuplicateRejected += 1;
                return;
            }
        }
        if (isFinal) {
            const mode = (0, echoSuppression_1.getEchoSuppressionMode)();
            const echo = (0, assistantEcho_1.matchAssistantEcho)(trimmed, this.getAssistantEchoCandidates(), mode);
            if (echo.isAssistantEcho) {
                log_1.log.info({
                    event: 'assistant_echo_rejected',
                    similarity: echo.score,
                    match_method: echo.method,
                    echo_suppression_mode: mode,
                    transcript_preview: trimmed.length <= this.logPreviewChars
                        ? trimmed
                        : `${trimmed.slice(0, this.logPreviewChars - 3)}...`,
                    ...this.logContext,
                }, 'final transcript rejected as assistant echo');
                this.writeAssistantEchoPolicyArtifact(trimmed, echo);
                (0, audioForensics_1.forensicsTimeline)(this.callControlId, {
                    event: 'transcript_rejected_assistant_echo',
                    wallClockMs: Date.now(),
                    audioClockMs: (0, audioForensics_1.getForensicsSession)(this.callControlId)?.sessionAudioClockMs ?? null,
                    similarity_score: echo.score,
                    match_method: echo.method,
                    state: this.state,
                    playbackActive: this.isPlaybackActive(),
                    listening: this.isListening(),
                    reason: 'assistant_echo',
                });
                this.qualitySignals.assistantEchoRejected += 1;
                return;
            }
        }
        const tenantLabel = this.tenantId ?? 'unknown';
        const responseStartAt = Date.now();
        this.userTurnFinalAcceptedAtMs = responseStartAt;
        this.userTurnPlaybackLatencyRecorded = false;
        // timing metric: if we had partials, measure partial->response
        if (this.firstPartialAt) {
            (0, metrics_1.observeStageDuration)('stt_first_partial_to_response_ms', tenantLabel, responseStartAt - this.firstPartialAt);
        }
        else {
            (0, metrics_1.observeStageDuration)('stt_final_to_response_ms', tenantLabel, 0);
        }
        log_1.log.info({
            event: 'turn_trigger',
            trigger: 'final',
            transcript_length: trimmed.length,
            ...this.logContext,
        }, 'turn trigger');
        // Accept this FINAL as the utterance we will respond to.
        const assistantTurnId = `turn-${this.nextTurnId()}`;
        this.beginLatencyTurn(assistantTurnId, { transcript_chars: trimmed.length });
        this.transcriptAcceptedForUtterance = true;
        this.isHandlingTranscript = true;
        this.audioCoordinator.onRespondingStart(Date.now());
        const handlingToken = (this.transcriptHandlingToken += 1);
        this.clearDeadAirTimer();
        // ✅ If we were capturing post-playback RX audio, force-write it now.
        // This guarantees we get an rx_after_playback_*.wav even on short turns.
        if (this.rxDumpActive && this.rxDumpSamplesCollected > 0) {
            await this.flushRxDump();
        }
        try {
            const transcriptPreview = trimmed.length <= this.logPreviewChars
                ? trimmed
                : `${trimmed.slice(0, this.logPreviewChars - 3)}...`;
            log_1.log.info({
                event: 'transcript_received',
                transcript_length: trimmed.length,
                transcript_preview: transcriptPreview,
                ...this.logContext,
            }, 'final transcript received');
            const safeAssistantTurn = assistantTurnId.replace(/[^a-zA-Z0-9._-]/g, '_');
            const sTxt = (0, audioForensics_1.getForensicsSession)(this.callControlId);
            if (sTxt) {
                void sTxt
                    .writeText(`llm/009_transcript_to_llm_${safeAssistantTurn}.txt`, this.forensicsTranscriptSnippet(trimmed))
                    .catch(() => undefined);
            }
            this.fireForensicsPolicy({
                decision: 'accepted',
                reason: 'final_turn_trigger',
                turn_id: safeAssistantTurn,
            });
            (0, audioForensics_1.forensicsTimeline)(this.callControlId, {
                event: 'transcript_accepted',
                turnId: safeAssistantTurn,
                wallClockMs: Date.now(),
                audioClockMs: (0, audioForensics_1.getForensicsSession)(this.callControlId)?.sessionAudioClockMs ?? null,
                state: this.state,
                playbackActive: this.isPlaybackActive(),
                listening: this.isListening(),
            });
            const llmHooks = this.buildLlmForensicsHooks(safeAssistantTurn);
            await this.cidLookupPromise;
            this.state = 'THINKING';
            this.appendTranscriptSegment(trimmed);
            this.appendHistory({ role: 'user', content: trimmed, timestamp: new Date() });
            this.lastUserFinalForDedupeText = trimmed;
            this.lastUserFinalForDedupeAtMs = Date.now();
            if (this.tenantId === 'demo-shop')
                this.syncDemoShopContactMaxUtt('');
            // VERA_DEMO_SHOP_HARDEN_20260904 — bye / incomplete contact before LLM
            // VERA_DEMO_SHOP_TURN_20260905 — nonsense / hallucinated STT gate (early turns)
            if (this.tenantId === 'demo-shop') {
                if (this.isDemoShopNonsenseTranscript(trimmed)) {
                    const clarify = "Sorry — I didn't catch that. Are you calling to book a demo?";
                    log_1.log.info({
                        event: 'demo_shop_nonsense_stt_clarify',
                        transcript_preview: trimmed.slice(0, 80),
                        ...this.logContext,
                    }, 'demo shop nonsense STT — clarify, skip LLM invent');
                    this.appendHistory({ role: 'assistant', content: clarify, timestamp: new Date() });
                    await this.playAssistantTurn(clarify, assistantTurnId);
                    return;
                }
                if (this.isDemoShopGoodbye(trimmed)) {
                    const bye = 'Thanks for calling Demo Shop. Goodbye.';
                    log_1.log.info({
                        event: 'demo_shop_goodbye_close',
                        transcript_preview: trimmed.slice(0, 80),
                        ...this.logContext,
                    }, 'demo shop goodbye — skip LLM and close');
                    this.appendHistory({ role: 'assistant', content: bye, timestamp: new Date() });
                    await this.playAssistantTurn(bye, assistantTurnId);
                    try {
                        this.markEnded('demo_shop_goodbye');
                        if (typeof this.transport?.stop === 'function')
                            await this.transport.stop('demo_shop_goodbye');
                    }
                    catch (error) {
                        log_1.log.warn({
                            err: serializeCaughtError(error),
                            event: 'demo_shop_goodbye_hangup_failed',
                            ...this.logContext,
                        }, 'demo shop goodbye hangup failed');
                    }
                    return;
                }
                if (this.demoShopDtmfBuffer && !this.demoShopDtmfPhone && !this.extractDemoShopPhone(trimmed)) {
                    log_1.log.info({
                        event: 'demo_shop_dtmf_speech_ignored',
                        marker: 'VERA_DEMO_SHOP_DTMF_20260907',
                        buffer_len: this.demoShopDtmfBuffer.length,
                        ...this.logContext,
                    }, 'demo shop ignoring speech while keypad digits are in progress');
                    return;
                }
                const spokenTen = this.extractDemoShopPhone(trimmed);
                if (spokenTen && this.demoShopDtmfBuffer && !this.demoShopDtmfPhone) {
                    this.demoShopDtmfBuffer = '';
                }
                if (this.isDemoShopIncompleteContact(trimmed)) {
                    const reask = "You can say the ten digits, or tap them on the keypad.";
                    log_1.log.info({
                        event: 'demo_shop_incomplete_contact_reask',
                        transcript_preview: trimmed.slice(0, 80),
                        digit_count: this.demoShopDigitCount(trimmed),
                        ...this.logContext,
                    }, 'demo shop incomplete contact — re-ask, skip LLM confirm');
                    this.demoShopAwaitingContact = true;
                    this.syncDemoShopContactMaxUtt('what is the best phone number to reach you');
                    this.appendHistory({ role: 'assistant', content: reask, timestamp: new Date() });
                    await this.playAssistantTurn(reask, assistantTurnId);
                    return;
                }
            }
            if (typeof shared_1.planReceptionistTurn === 'function') {
                const hoursEv = (0, shared_1.evaluateBusinessHours)(this.fullTenantConfig?.llmContext?.businessHours, new Date());
                const afterHours = this.fullTenantConfig?.usageLimits?.features?.afterHoursMode !== false && !hoursEv.isOpen;
                const transfersAllowed = this.fullTenantConfig?.usageLimits?.features?.multiLocation !== false
                    && (this.transferProfiles?.length || 0) > 0;
                const quickHit = this.tryMatchQuickReply(trimmed);
                const deskPlan = shared_1.planReceptionistTurn({
                    utterance: trimmed,
                    history: this.conversationHistory,
                    callerId: this.from,
                    dtmfPhone: this.demoShopDtmfPhone,
                    existing: this.cidMatch,
                    profile: typeof shared_1.normalizeIntakeProfile === 'function'
                        ? shared_1.normalizeIntakeProfile(this.fullTenantConfig?.intakeProfile, this.tenantId)
                        : undefined,
                    tenantId: this.tenantId,
                    playbook: this.fullTenantConfig?.shopPlaybook,
                    afterHours,
                    transfersAllowed,
                    transferProfiles: this.transferProfiles,
                    posted: !!this.demoShopMidCallBookPosted,
                    pricingItems: this.fullTenantConfig?.llmContext?.pricing?.items,
                    quickReply: quickHit ? quickHit.text : undefined,
                });
                if (deskPlan.skipLlm && deskPlan.speak) {
                    let deskText = deskPlan.speak;
                    if (deskPlan.writeBook) {
                        const booked = await this.maybeDemoShopMidCallBook(deskText);
                        if (this.demoShopMidCallBookPosted && deskPlan.slots && deskPlan.slots.startSpeak) {
                            deskText = `You're booked for ${deskPlan.slots.startSpeak}.`;
                        }
                        else if (!booked && !this.demoShopMidCallBookPosted) {
                            deskText = "One moment while I write that down.";
                            void this.maybeDemoShopMidCallBook(deskText);
                        }
                    }
                    const nightDesk = await this.applyNightDeskGate(trimmed, deskText);
                    deskText = nightDesk.text;
                    this.appendHistory({ role: 'assistant', content: deskText, timestamp: new Date() });
                    await this.playAssistantTurn(deskText, assistantTurnId);
                    const transferTo = nightDesk.transferTo || deskPlan.transferTo;
                    if (transferTo) {
                        try {
                            await this.transferCall(transferTo, { timeoutSecs: nightDesk.timeoutSecs || deskPlan.timeoutSecs, commandId: (0, crypto_1.randomUUID)() });
                        }
                        catch (error) {
                            log_1.log.error({ err: serializeCaughtError(error), to: transferTo, ...this.logContext }, 'desk transfer failed');
                        }
                    }
                    return;
                }
            }
            let response = '';
            let replySource = 'unknown';
            let playbackDone;
            let replyResult;
            try {
                // Hard shop-law gates must finish before any audio is queued.
                // Shop playbook normally forces non-stream (night-desk rewrite-before-audio).
                // VERA_DEMO_SHOP_CONVOFEEL_20260906 / STREAMTTS: Demo Shop is the exception —
                // shop-law rewrites still run on stream segments + post-stream choke points.
                const allowBrainStream = env_1.env.BRAIN_STREAMING_ENABLED &&
                    (!this.fullTenantConfig?.shopPlaybook || this.tenantId === 'demo-shop');
                if (this.tenantId === 'demo-shop' && !allowBrainStream) {
                    log_1.log.info({
                        event: 'demo_shop_streamtts_blocked',
                        marker: 'VERA_DEMO_SHOP_CONVOFEEL_20260906',
                        brain_streaming: !!env_1.env.BRAIN_STREAMING_ENABLED,
                        has_shop_playbook: !!this.fullTenantConfig?.shopPlaybook,
                        ...this.logContext,
                    }, 'demo shop STREAMTTS skipped (brain stream off or gated)');
                }
                if (allowBrainStream) {
                    const streamResult = await this.streamAssistantReply(trimmed, handlingToken, llmHooks, assistantTurnId);
                    replyResult = streamResult.reply;
                    response = streamResult.reply.text;
                    replySource = streamResult.reply.source;
                    playbackDone = streamResult.playbackDone;
                }
                else {
                    const quick = this.tryMatchQuickReply(trimmed);
                    if (quick) {
                        replyResult = quick;
                        response = quick.text;
                        replySource = quick.source;
                    }
                    else {
                        const endLlm = (0, metrics_1.startStageTimer)('llm', tenantLabel);
                        const llmT0 = Date.now();
                        try {
                            const reply = await (0, brainClient_1.generateAssistantReply)({
                                tenantId: this.tenantId,
                                tenantConfig: this.fullTenantConfig,
                                callControlId: this.callControlId,
                                transcript: trimmed,
                                history: this.conversationHistory,
                                transferProfiles: this.transferProfiles,
                                assistantContext: this.brainAssistantContext(),
                                prompts: this.tenantPrompts,
                                forensics: llmHooks,
                            });
                            endLlm();
                            const dt = Date.now() - llmT0;
                            if (dt >= 0 && dt < 300000)
                                this.qualitySignals.llmLatencyMs.push(dt);
                            replyResult = reply;
                            response = reply.text;
                            replySource = reply.source;
                        }
                        catch (error) {
                            (0, metrics_1.incStageError)('llm', tenantLabel);
                            endLlm();
                            throw error;
                        }
                    }
                }
            }
            catch (error) {
                response = shared_1.ASSISTANT_VOICE_LLM_ERROR_FALLBACK;
                replySource = 'fallback_error';
                log_1.log.error({
                    err: serializeCaughtError(error),
                    err_message: error instanceof Error ? error.message : String(error),
                    assistant_reply_source: replySource,
                    ...this.logContext,
                }, 'assistant reply generation failed');
            }
            if (handlingToken !== this.transcriptHandlingToken) {
                return;
            }
            (0, audioProbe_1.markAudioSpan)('llm_result', {
                callId: this.callControlId,
                tenantId: this.tenantId,
                logContext: this.logContext,
            });
            const replyPreview = response.length <= this.logPreviewChars
                ? response
                : `${response.slice(0, this.logPreviewChars - 3)}...`;
            log_1.log.info({
                event: 'assistant_reply_generated',
                assistant_reply_length: response.length,
                assistant_reply_source: replySource,
                assistant_reply_preview: replyPreview,
                ...this.logContext,
            }, 'assistant reply generated');
            log_1.log.info({
                event: 'assistant_reply_text',
                assistant_reply_text: replyPreview,
                assistant_reply_length: response.length,
                assistant_reply_source: replySource,
                ...this.logContext,
            }, 'assistant reply text');
            if (handlingToken !== this.transcriptHandlingToken) {
                return;
            }
            // VERA_DEMO_SHOP_HARDEN_20260904 — never speak fake Got-it / email-on-file without contact
            // VERA_DEMO_SHOP_PSTN_WAIT_20260905 — rewrite must clear+stop already-queued stream segments
            // VERA_DEMO_SHOP_DATECONFIRM_20260905 — concrete PT calendar date on slot confirms
            if (this.tenantId === 'demo-shop' && response) {
                // VERA_DEMO_SHOP_TTS_REPLYTEXT_UNWRAP_20260906 — plain replyText before rewrites + TTS
                const unwrappedSpeak = this.extractDemoShopSpokenText(response);
                if (unwrappedSpeak !== response) {
                    response = unwrappedSpeak;
                    if (replyResult && typeof replyResult === 'object')
                        replyResult = { ...replyResult, text: unwrappedSpeak };
                }
                let demoShopRewrote = false;
                const productSafe = this.maybeRewriteDemoShopInventedProduct(response);
                if (productSafe !== response) {
                    response = productSafe;
                    replySource = 'demo_shop_product_rewrite';
                    demoShopRewrote = true;
                    if (replyResult && typeof replyResult === 'object')
                        replyResult = { ...replyResult, text: productSafe, source: replySource };
                }
                const rewritten = this.maybeRewriteDemoShopFakeConfirm(response);
                if (rewritten !== response) {
                    response = rewritten;
                    replySource = 'demo_shop_contact_reask';
                    demoShopRewrote = true;
                    if (replyResult && typeof replyResult === 'object')
                        replyResult = { ...replyResult, text: rewritten, source: replySource };
                }
                const handoffSafe = this.maybeRewriteDemoShopHandoff(response);
                if (handoffSafe !== response) {
                    response = handoffSafe;
                    replySource = 'demo_shop_handoff_rewrite';
                    demoShopRewrote = true;
                    if (replyResult && typeof replyResult === 'object')
                        replyResult = { ...replyResult, text: handoffSafe, source: replySource };
                }
                const needTimeSafe = this.maybeRewriteDemoShopNeedDatetime(response);
                if (needTimeSafe !== response) {
                    response = needTimeSafe;
                    replySource = 'demo_shop_need_datetime_rewrite';
                    demoShopRewrote = true;
                    if (replyResult && typeof replyResult === 'object')
                        replyResult = { ...replyResult, text: needTimeSafe, source: replySource };
                }
                // VERA_DEMO_SHOP_DATECONFIRM_20260905 — inject concrete PT calendar date into confirm speak
                // VERA_DEMO_SHOP_PLAYSERIAL_20260907 — do not mark rewrote / interrupt for dateconfirm
                // alone (stream segs already dateconfirmed; interrupt restacks a second clip).
                const dateConfirmSafe = this.maybeRewriteDemoShopDateConfirm(response);
                if (dateConfirmSafe !== response) {
                    response = dateConfirmSafe;
                    replySource = 'demo_shop_dateconfirm_rewrite';
                    if (replyResult && typeof replyResult === 'object')
                        replyResult = { ...replyResult, text: dateConfirmSafe, source: replySource };
                }
                // VERA_DEMO_SHOP_NO_REGREET_20260906 — strip Hi/Hello/Hey + name after first ack
                // VERA_DEMO_SHOP_NONAMEHALLUC_20260907 — do not interrupt stream for opener-only strip
                // (that restacked turn-1 on top of already-playing segs and spoke leftover "Mo,")
                const regreetSafe = this.maybeRewriteDemoShopRegreet(response);
                if (regreetSafe !== response) {
                    response = regreetSafe || 'Could I have your name?';
                    replySource = 'demo_shop_regreet_rewrite';
                    if (replyResult && typeof replyResult === 'object')
                        replyResult = { ...replyResult, text: response, source: replySource };
                }
                // VERA_DEMO_SHOP_NAMETRUTH_20260905 — never speak "I've booked" until /book succeeds
                const bookedSafe = await this.finalizeDemoShopBookedSpeak(response);
                if (bookedSafe !== response) {
                    response = bookedSafe;
                    replySource = 'demo_shop_booked_after_write';
                    demoShopRewrote = true;
                    if (replyResult && typeof replyResult === 'object')
                        replyResult = { ...replyResult, text: bookedSafe, source: replySource };
                }
                if (demoShopRewrote) {
                    await this.interruptDemoShopQueuedTts('post_stream_rewrite');
                    playbackDone = undefined;
                }
            }
            // Apply voice directive from brain (hot-swap voice mode)
            if (replyResult?.voiceDirective) {
                log_1.log.info({
                    event: 'brain_voice_directive_received',
                    directive_mode: replyResult.voiceDirective.mode,
                    has_speaker_wav_url: !!replyResult.voiceDirective.speakerWavUrl,
                    ...this.logContext,
                }, 'brain voice directive received');
                this.setVoiceMode(replyResult.voiceDirective.mode, replyResult.voiceDirective.speakerWavUrl);
            }
            const nightDesk = await this.applyNightDeskGate(trimmed, response);
            response = nightDesk.text;
            const transferTo = nightDesk.transferTo || replyResult?.transfer?.to;
            const transferTimeout = nightDesk.timeoutSecs || replyResult?.transfer?.timeoutSecs;
            // AI or shop-law requested transfer: play reply text then transfer the call.
            if (transferTo) {
                this.appendHistory({ role: 'assistant', content: response, timestamp: new Date() });
                if (env_1.env.BRAIN_STREAMING_ENABLED && playbackDone) {
                    await playbackDone;
                }
                else {
                    await this.playAssistantTurn(response, assistantTurnId);
                }
                try {
                    const targetLegClientState = nightDesk.pageId
                        ? Buffer.from(JSON.stringify({
                            kind: 'veralux_oncall_transfer',
                            tenantId: this.tenantId,
                            tenant_id: this.tenantId,
                            callId: this.callControlId,
                            pageId: nightDesk.pageId,
                        })).toString('base64')
                        : undefined;
                    await this.transferCall(transferTo, {
                        audioUrl: replyResult?.transfer?.audioUrl,
                        timeoutSecs: transferTimeout,
                        targetLegClientState,
                        commandId: (0, crypto_1.randomUUID)(),
                    });
                    if (nightDesk.transferTo)
                        this.nightDeskCompletion = this.nightDeskCompletion || 'on_call_paged';
                    log_1.log.info({ event: 'ai_transfer_completed', to: transferTo, ...this.logContext }, 'AI requested transfer completed');
                }
                catch (error) {
                    log_1.log.error({ err: error, to: transferTo, ...this.logContext }, 'AI transfer failed');
                    this.nightDeskCompletion = 'tasked';
                    if (nightDesk.pageId) {
                        await (0, controlPlane_1.reportOncallOutcome)({
                            tenantId: this.tenantId || '',
                            callId: this.callControlId,
                            status: 'failed',
                            reason: error instanceof Error ? error.message.slice(0, 500) : 'transfer_command_failed',
                        });
                    }
                    await this.playAssistantTurn("I wasn't able to complete the transfer. I've written a task for the shop.", assistantTurnId);
                }
                return;
            }
            this.appendHistory({ role: 'assistant', content: response, timestamp: new Date() });
            // Streaming path: await in-flight segment playback when present.
            // If stream died before any playbackDone (or fallback_error), always speak the reply.
            if (env_1.env.BRAIN_STREAMING_ENABLED && playbackDone) {
                await playbackDone;
            }
            else {
                await this.playAssistantTurn(response, assistantTurnId);
            }
        }
        catch (error) {
            log_1.log.error({ err: error, ...this.logContext }, 'call session transcript handling failed');
        }
        finally {
            if (handlingToken === this.transcriptHandlingToken) {
                // ✅ Reset utterance gating so next user turn isn't ignored
                this.resetTranscriptTracking();
                // reset handling flags and go back to listening
                this.isHandlingTranscript = false;
                if (this.active && !this.transferPending && this.state !== 'ENDED') {
                    // Only re-arm listening if we are NOT in playback and not already listening.
                    if (!this.isPlaybackActive() && this.state !== 'LISTENING') {
                        this.enterListeningState(true);
                    }
                    else if (this.state === 'LISTENING') {
                        // If we're already listening, just ensure the timer can run.
                        this.scheduleDeadAirTimer();
                    }
                    this.audioCoordinator.notifyListeningEligibilityChanged('transcript_complete');
                }
            }
        }
    }
    /**
     * Tenant-configured quick replies: substring match on normalized transcript.
     * First matching intent (and first matching phrase within it) wins.
     */
    tryMatchQuickReply(transcript) {
        if (!this.quickReplies?.length)
            return null;
        // VERA_DEMO_SHOP_NO_QR_LOOP_20260904
        // Mid-call "book"/"hours" keyword hits reset to stock openers (e.g. "Can I book 12:30"
        // → "What day and time work best?") and loop. First user turn only for Demo Shop.
        if (this.tenantId === 'demo-shop' && (this.conversationHistory?.length ?? 0) > 0)
            return null;
        const hit = (0, quickReplyMatch_1.matchQuickReply)(transcript, this.quickReplies);
        if (!hit)
            return null;
        log_1.log.info({
            event: 'quick_reply_hit',
            quick_reply_id: hit.intentId ?? null,
            ...this.logContext,
        }, 'quick reply matched; skipping LLM');
        return { text: hit.reply, source: 'quick_reply' };
    }
    async streamAssistantReply(transcript, handlingToken, llmForensics, playbackTurnId) {
        const quick = this.tryMatchQuickReply(transcript);
        if (quick) {
            return { reply: quick, playbackDone: this.playAssistantTurn(quick.text, playbackTurnId) };
        }
        let bufferedText = '';
        let firstTokenAt;
        let speakCursor = 0;
        let firstSegmentQueued = false;
        let segmentIndex = 0;
        let queuedSegments = 0;
        let baseTurnId;
        // VERA_DEMO_SHOP_TURN_20260905 — Demo Shop: short replies (1–2 sentences / ~200 chars), max 2 TTS segments
        // VERA_DEMO_SHOP_STREAMTTS_REMAINDER_20260906 — cap is first-audio only; leftover is a tail clip
        let demoShopSpeakCapHit = false;
        let demoShopStreamRewriteAbort = false;
        const demoShopQueuedSpeakParts = [];
        const demoShopMaxSpeakChars = 200;
        const demoShopMaxSegments = 2;
        // Demo Shop: short complete clause/sentence (not single-token blips). Defaults 120/180/2000.
        // VERA_DEMO_SHOP_STREAMTTS_REMAINDER_DEDUP_20260906 — don't radio-burst "Hi there!" alone
        const firstSegmentMin = this.tenantId === 'demo-shop' ? 64 : env_1.env.BRAIN_STREAM_SEGMENT_MIN_CHARS;
        const nextSegmentMin = this.tenantId === 'demo-shop' ? 90 : env_1.env.BRAIN_STREAM_SEGMENT_NEXT_CHARS;
        const firstAudioMaxMs = this.tenantId === 'demo-shop' ? 720 : env_1.env.BRAIN_STREAM_FIRST_AUDIO_MAX_MS;
        // === PSTN SAFETY: non-demo PSTN stays ONEWAV (no overlapping Telnyx play segments) ===
        // VERA_DEMO_SHOP_ONEWAV_20260905 — generation token / stale playback.ended guard retained.
        // VERA_DEMO_SHOP_CONVOFEEL_20260906 — Demo Shop PSTN is the STREAMTTS exception:
        // stream LLM + ≤2 Chatterbox segments; waitDemoShopPstnSegmentAudioEnd between segs
        // (playGen + segmentId). Do not use Track A pre-baked ack audio.
        if (this.transport.mode === 'pstn' && this.tenantId !== 'demo-shop') {
            const tenantLabel = this.tenantId ?? 'unknown';
            const endLlm = (0, metrics_1.startStageTimer)('llm', tenantLabel);
            let reply;
            try {
                reply = await (0, brainClient_1.generateAssistantReply)({
                    tenantId: this.tenantId,
                    tenantConfig: this.fullTenantConfig,
                    callControlId: this.callControlId,
                    transcript,
                    history: this.conversationHistory,
                    transferProfiles: this.transferProfiles,
                    assistantContext: this.brainAssistantContext(),
                    prompts: this.tenantPrompts,
                    forensics: llmForensics,
                });
                endLlm();
            }
            catch (error) {
                (0, metrics_1.incStageError)('llm', tenantLabel);
                endLlm();
                throw error;
            }
            // Play as a single turn (no segmentation) on PSTN.
            return { reply, playbackDone: this.playAssistantTurn(reply.text, playbackTurnId) };
        }
        // VERA_DEMO_SHOP_STREAMTTS_20260905 + VERA_DEMO_SHOP_CONVOFEEL_20260906 —
        // Demo Shop PSTN: stream + ≤2 clause segments, await real playback.ended
        // via waitDemoShopPstnSegmentAudioEnd (playGen + segmentId).
        // STREAMBUF/ONEWAV whole-turn wait is the overlap stopgap for other PSTN tenants.
        if (this.tenantId === 'demo-shop' && this.transport.mode === 'pstn') {
            log_1.log.info({
                event: 'demo_shop_streamtts_arm',
                marker: 'VERA_DEMO_SHOP_STREAMTTS_REMAINDER_20260906',
                first_audio_max_ms: firstAudioMaxMs,
                first_segment_min: firstSegmentMin,
                max_segments: demoShopMaxSegments,
                remainder_after_cap: true,
                ...this.logContext,
            }, 'demo shop PSTN streaming first-audio (Chatterbox segments, PSTN_WAIT between)');
        }
        // Returns consumed buffer chars (0 if not queued). Remainder tail bypasses first-audio cap.
        const queueSegment = (segment, opts) => {
            const allowRemainder = !!(opts && opts.remainder);
            if (handlingToken !== this.transcriptHandlingToken)
                return 0;
            if (this.tenantId === 'demo-shop' && !allowRemainder && (demoShopSpeakCapHit || queuedSegments >= demoShopMaxSegments))
                return 0;
            const consumeLen = segment.length;
            let trimmed = this.normalizeDemoShopSpeakText(String(segment || '').trim());
            if (!trimmed)
                return 0;
            if (this.tenantId === 'demo-shop') {
                // Belt-and-suspenders: streaming may queue invents before post-LLM rewrite
                const inventSafe = this.maybeRewriteDemoShopInventedProduct(trimmed);
                if (inventSafe !== trimmed) {
                    trimmed = inventSafe;
                    demoShopSpeakCapHit = true;
                    log_1.log.info({
                        event: 'demo_shop_stream_invent_blocked',
                        ...this.logContext,
                    }, 'demo shop blocked invented product in stream segment');
                }
                const handoffSeg = this.maybeRewriteDemoShopHandoff(trimmed);
                if (handoffSeg !== trimmed) {
                    trimmed = handoffSeg;
                    demoShopSpeakCapHit = true;
                    log_1.log.info({
                        event: 'demo_shop_stream_handoff_blocked',
                        ...this.logContext,
                    }, 'demo shop blocked handoff speak in stream segment');
                }
                const confirmSeg = this.maybeRewriteDemoShopFakeConfirm(trimmed);
                if (confirmSeg !== trimmed) {
                    trimmed = confirmSeg;
                    demoShopSpeakCapHit = true;
                    log_1.log.info({
                        event: 'demo_shop_stream_unposted_book_blocked',
                        ...this.logContext,
                    }, 'demo shop blocked unposted booked-claim in stream segment');
                }
                // VERA_DEMO_SHOP_DATECONFIRM_20260905 — concrete calendar date on stream confirm segments
                const dateConfirmSeg = this.maybeRewriteDemoShopDateConfirm(trimmed);
                if (dateConfirmSeg !== trimmed) {
                    trimmed = dateConfirmSeg;
                    log_1.log.info({
                        event: 'demo_shop_stream_dateconfirm',
                        ...this.logContext,
                    }, 'demo shop dateconfirm rewrite on stream segment');
                }
                const regreetSeg = this.maybeRewriteDemoShopRegreet(trimmed);
                if (regreetSeg !== trimmed) {
                    trimmed = regreetSeg;
                    log_1.log.info({
                        event: 'demo_shop_stream_regreet',
                        marker: 'VERA_DEMO_SHOP_NO_REGREET_20260906',
                        ...this.logContext,
                    }, 'demo shop stripped Hi+Name opener on stream segment');
                }
                // First-audio only: keep early clips short. Remainder tail speaks the leftover in full.
                if (!allowRemainder) {
                    const spokenSoFar = bufferedText.slice(0, speakCursor);
                    const room = demoShopMaxSpeakChars - spokenSoFar.length;
                    if (room <= 0) {
                        demoShopSpeakCapHit = true;
                        return 0;
                    }
                    if (trimmed.length > room) {
                        const cut = this.truncateDemoShopReply(trimmed, room);
                        if (!cut) {
                            demoShopSpeakCapHit = true;
                            return 0;
                        }
                        trimmed = cut;
                        demoShopSpeakCapHit = true;
                        log_1.log.info({
                            event: 'demo_shop_reply_truncated',
                            cap_chars: demoShopMaxSpeakChars,
                            segment_len: trimmed.length,
                            remainder_follows: true,
                            marker: 'VERA_DEMO_SHOP_STREAMTTS_REMAINDER_20260906',
                            ...this.logContext,
                        }, 'demo shop first-audio truncated; remainder will follow');
                    }
                }
            }
            if (!trimmed)
                return 0;
            const resolvedTurnId = baseTurnId ?? `turn-${this.nextTurnId()}`;
            baseTurnId = resolvedTurnId;
            segmentIndex += 1;
            queuedSegments += 1; // ✅ FIX: count queued segments
            const segmentId = allowRemainder ? `${resolvedTurnId}-remainder` : `${resolvedTurnId}-${segmentIndex}`;
            this.queueTtsSegment(trimmed, segmentId, handlingToken);
            if (this.tenantId === 'demo-shop')
                demoShopQueuedSpeakParts.push(trimmed);
            if (this.tenantId === 'demo-shop' && queuedSegments === 1) {
                log_1.log.info({
                    event: 'demo_shop_first_audio_queued',
                    marker: 'VERA_DEMO_SHOP_CONVOFEEL_20260906',
                    ms_since_first_token: firstTokenAt ? Date.now() - firstTokenAt : null,
                    seg_len: trimmed.length,
                    ...this.logContext,
                }, 'demo shop first Chatterbox segment queued');
            }
            if (this.tenantId === 'demo-shop' && !allowRemainder && queuedSegments >= demoShopMaxSegments) {
                demoShopSpeakCapHit = true;
                log_1.log.info({
                    event: 'demo_shop_segment_cap',
                    marker: 'VERA_DEMO_SHOP_STREAMTTS_REMAINDER_20260906',
                    max_segments: demoShopMaxSegments,
                    remainder_follows: true,
                    ...this.logContext,
                }, 'demo shop first-audio segment cap; remainder will be queued after stream');
            }
            return consumeLen;
        };
        const maybeQueueSegments = (force) => {
            if (!this.active) {
                return;
            }
            // VERA_DEMO_SHOP_TTS_REPLYTEXT_UNWRAP_20260906 — never mid-stream speak JSON keys/braces
            if (this.tenantId === 'demo-shop' && this.isDemoShopJsonSpeakEnvelope(bufferedText)) {
                const spoken = this.extractDemoShopSpokenText(bufferedText, { silent: !force });
                if (spoken && !this.isDemoShopJsonSpeakEnvelope(spoken) && spoken !== bufferedText.trim()) {
                    bufferedText = spoken;
                    speakCursor = demoShopQueuedSpeakParts.length
                        ? mapDemoShopSpeakCursorAfterUnwrap(spoken, demoShopQueuedSpeakParts)
                        : 0;
                }
                else if (!force) {
                    return;
                }
                else {
                    bufferedText = spoken || '';
                    speakCursor = demoShopQueuedSpeakParts.length
                        ? mapDemoShopSpeakCursorAfterUnwrap(bufferedText, demoShopQueuedSpeakParts)
                        : 0;
                    if (!bufferedText)
                        return;
                }
            }
            while (true) {
                const pending = bufferedText.slice(speakCursor);
                if (!pending) {
                    return;
                }
                if (!firstSegmentQueued) {
                    const boundary = this.findSentenceBoundary(pending);
                    // Combine a tiny first clause ("Hi there!") with the next sentence when both are in.
                    if (this.tenantId === 'demo-shop' && boundary !== null && boundary < firstSegmentMin) {
                        const rest = pending.slice(boundary);
                        const b2 = this.findSentenceBoundary(rest);
                        if (b2 !== null) {
                            const n = queueSegment(pending.slice(0, boundary + b2));
                            if (n <= 0)
                                return;
                            speakCursor += n;
                            firstSegmentQueued = true;
                            continue;
                        }
                    }
                    if (boundary !== null && (this.tenantId !== 'demo-shop' || boundary >= firstSegmentMin)) {
                        const n = queueSegment(pending.slice(0, boundary));
                        if (n <= 0)
                            return;
                        speakCursor += n;
                        firstSegmentQueued = true;
                        continue;
                    }
                    if (pending.length >= firstSegmentMin) {
                        const end = this.selectSegmentEnd(pending, firstSegmentMin);
                        const n = queueSegment(pending.slice(0, end));
                        if (n <= 0)
                            return;
                        speakCursor += n;
                        firstSegmentQueued = true;
                        continue;
                    }
                    if (force ||
                        (firstTokenAt && Date.now() - firstTokenAt >= firstAudioMaxMs)) {
                        const n = queueSegment(pending);
                        if (n <= 0)
                            return;
                        speakCursor += n;
                        firstSegmentQueued = true;
                        continue;
                    }
                    return;
                }
                const boundary = this.findSentenceBoundary(pending);
                if (boundary !== null) {
                    const n = queueSegment(pending.slice(0, boundary));
                    if (n <= 0)
                        return;
                    speakCursor += n;
                    continue;
                }
                if (pending.length >= nextSegmentMin) {
                    const end = this.selectSegmentEnd(pending, nextSegmentMin);
                    const n = queueSegment(pending.slice(0, end));
                    if (n <= 0)
                        return;
                    speakCursor += n;
                    continue;
                }
                if (force) {
                    const n = queueSegment(pending);
                    if (n > 0)
                        speakCursor += n;
                }
                return;
            }
        };
        const queueDemoShopStreamRemainder = (reason) => {
            if (this.tenantId !== 'demo-shop')
                return;
            if (handlingToken !== this.transcriptHandlingToken)
                return;
            if (demoShopStreamRewriteAbort) {
                log_1.log.info({
                    event: 'demo_shop_segment_remainder_skipped_rewrite_abort',
                    marker: 'VERA_DEMO_SHOP_STREAMTTS_REMAINDER_20260906',
                    reason,
                    ...this.logContext,
                }, 'demo shop remainder skipped (mid-stream rewrite abort)');
                return;
            }
            const fullSpoken = this.extractDemoShopSpokenText(bufferedText || '', { silent: true }).trim();
            const fromCursor = String(bufferedText || '').slice(speakCursor).trim();
            let remain = pickDemoShopStreamRemainder(fullSpoken, demoShopQueuedSpeakParts, fromCursor);
            remain = this.normalizeDemoShopSpeakText(remain);
            remain = this.extractDemoShopSpokenText(remain, { silent: true });
            remain = String(remain || '').trim();
            if (!remain || isDemoShopRemainderDuplicate(remain, fullSpoken, demoShopQueuedSpeakParts)) {
                log_1.log.info({
                    event: 'demo_shop_segment_remainder_skipped_duplicate',
                    marker: 'VERA_DEMO_SHOP_STREAMTTS_REMAINDER_DEDUP_20260906',
                    reason,
                    remainder_len: remain.length,
                    remainder_preview: remain.slice(0, 80),
                    full_len: fullSpoken.length,
                    queued_segments: queuedSegments,
                    speak_cursor: speakCursor,
                    ...this.logContext,
                }, 'demo shop remainder skipped (would re-speak already-queued text)');
                return;
            }
            log_1.log.info({
                event: 'demo_shop_segment_remainder_queued',
                marker: 'VERA_DEMO_SHOP_STREAMTTS_REMAINDER_DEDUP_20260906',
                reason,
                remainder_len: remain.length,
                remainder_preview: remain.slice(0, 120),
                queued_segments: queuedSegments,
                speak_cursor: speakCursor,
                ...this.logContext,
            }, 'demo shop STREAMTTS remainder queued as tail clip');
            const n = queueSegment(remain, { remainder: true });
            if (n > 0)
                speakCursor = String(bufferedText || '').length;
        };
        const tenantLabel = this.tenantId ?? 'unknown';
        const endLlm = (0, metrics_1.startStageTimer)('llm', tenantLabel);
        let reply;
        try {
            reply = await (0, brainClient_1.generateAssistantReplyStream)({
                tenantId: this.tenantId,
                tenantConfig: this.fullTenantConfig,
                callControlId: this.callControlId,
                transcript,
                history: this.conversationHistory,
                transferProfiles: this.transferProfiles,
                assistantContext: this.brainAssistantContext(),
                prompts: this.tenantPrompts,
                forensics: llmForensics,
            }, (chunk) => {
                if (!chunk)
                    return;
                if (!firstTokenAt) {
                    firstTokenAt = Date.now();
                    this.markLatency('first_token_at_ms');
                }
                // Demo Shop: normalize accumulating buffer so a.m./p.m. never becomes a sentence split.
                if (this.tenantId === 'demo-shop') {
                    const prefix = bufferedText.slice(0, speakCursor);
                    const pendingRaw = bufferedText.slice(speakCursor) + chunk;
                    const pendingNorm = this.normalizeDemoShopSpeakText(pendingRaw);
                    bufferedText = prefix + pendingNorm;
                    // VERA_DEMO_SHOP_PSTN_WAIT_20260905 — stop early if fake-confirm / invent mid-stream
                    if (!demoShopSpeakCapHit && this.shouldAbortDemoShopStreamForRewrite(bufferedText)) {
                        demoShopSpeakCapHit = true;
                        demoShopStreamRewriteAbort = true;
                        log_1.log.info({
                            event: 'demo_shop_stream_rewrite_abort',
                            buffered_len: bufferedText.length,
                            queued_segments: queuedSegments,
                            ...this.logContext,
                        }, 'demo shop aborting stream TTS for pending rewrite');
                        void this.interruptDemoShopQueuedTts('mid_stream_rewrite_detect');
                    }
                    else if (!demoShopSpeakCapHit) {
                        maybeQueueSegments(false);
                    }
                }
                else {
                    bufferedText += chunk;
                    maybeQueueSegments(false);
                }
            });
            endLlm();
        }
        catch (error) {
            (0, metrics_1.incStageError)('llm', tenantLabel);
            endLlm();
            // VERA_DEMO_SHOP_FIX_20260904: never throw; speak partial and/or fallback.
            const serialized = serializeCaughtError(error);
            log_1.log.error({
                err: serialized,
                err_message: serialized.message || String(error),
                event: 'stream_assistant_reply_error',
                buffered_len: bufferedText.trim().length,
                queued_segments: queuedSegments,
                ...this.logContext,
            }, 'stream assistant reply failed; speaking partial and/or fallback');
            const fallbackText = shared_1.ASSISTANT_VOICE_LLM_ERROR_FALLBACK;
            const partial = bufferedText.trim();
            if (partial) {
                try {
                    maybeQueueSegments(true);
                }
                catch (queueErr) {
                    log_1.log.warn({ err: serializeCaughtError(queueErr), ...this.logContext }, 'partial segment queue failed after stream error');
                }
            }
            const speakText = partial || fallbackText;
            reply = {
                text: speakText,
                source: partial ? 'openai_direct_stream' : 'fallback_error',
            };
            if (handlingToken !== this.transcriptHandlingToken) {
                return { reply };
            }
            if (queuedSegments > 0) {
                queueDemoShopStreamRemainder('stream_error');
                return { reply, playbackDone: this.waitForTtsSegmentQueue() };
            }
            return { reply, playbackDone: this.playAssistantTurn(speakText, playbackTurnId) };
        }
        if (handlingToken !== this.transcriptHandlingToken) {
            return { reply };
        }
        if (this.tenantId === 'demo-shop') {
            const fromReply = this.extractDemoShopSpokenText(reply.text || '', { silent: true });
            const fromBuf = this.extractDemoShopSpokenText(bufferedText || '', { silent: true });
            const spoken = String(fromReply || fromBuf || bufferedText || '').trim();
            if (spoken) {
                bufferedText = spoken;
                speakCursor = mapDemoShopSpeakCursorAfterUnwrap(spoken, demoShopQueuedSpeakParts);
            }
        }
        else if (reply.text.length > bufferedText.length) {
            bufferedText = reply.text;
        }
        maybeQueueSegments(true);
        // VERA_DEMO_SHOP_STREAMTTS_REMAINDER_20260906 — never silently drop leftover replyText
        queueDemoShopStreamRemainder('stream_complete');
        const isStreamSource = reply.source === 'brain_http_stream' || reply.source === 'openai_direct_stream';
        // VERA_DEMO_SHOP_PLAYSERIAL_20260907 — rewrite abort with 0 queued segs must NOT
        // playAssistantTurn(original). That raced the post-stream rewrite clip (v3:fJJo double speak).
        if (this.tenantId === 'demo-shop' && demoShopStreamRewriteAbort) {
            log_1.log.info({
                event: 'demo_shop_stream_complete_skip_original_play',
                marker: 'VERA_DEMO_SHOP_PLAYSERIAL_20260907',
                queued_segments: queuedSegments,
                ...this.logContext,
            }, 'demo shop stream rewrite abort — skip original play; post-stream rewrite speaks once');
            return { reply };
        }
        // Keep queued clause segments when streaming (incl. demo-shop openai_direct_stream).
        // If we already buffered/queued segments, drain the TTS queue rather than replaying full text.
        if (isStreamSource || queuedSegments > 0) {
            if (queuedSegments === 0) {
                if (handlingToken !== this.transcriptHandlingToken) {
                    return { reply };
                }
                return { reply, playbackDone: this.playAssistantTurn(reply.text, playbackTurnId) };
            }
            return { reply, playbackDone: this.waitForTtsSegmentQueue() };
        }
        if (handlingToken !== this.transcriptHandlingToken) {
            return { reply };
        }
        return { reply, playbackDone: this.playAssistantTurn(reply.text, playbackTurnId) };
    }
    async answerAndGreet() {
        try {
            const answerStarted = Date.now();
            if (this.transport.mode === 'pstn' && this.shouldSkipTelnyxAction('answer')) {
                return;
            }
            await this.transport.start();
            const answerDuration = Date.now() - answerStarted;
            if (this.transport.mode === 'pstn') {
                log_1.log.info({ event: 'telnyx_answer_duration', duration_ms: answerDuration, ...this.logContext }, 'telnyx answer completed');
            }
            log_1.log.info({ event: 'call_answered', ...this.logContext }, 'call answered');
            this.onAnswered();
            await this.cidLookupPromise;
            // Sprint 0 cohesion fix: prefer the per-tenant greeting (admin/owner edited,
            // published to Redis as `tenantcfg:<tenantId>.llmContext.prompts.greetingText`)
            // before falling back to the global env default. Previous behavior always
            // used env.GREETING_TEXT, so per-tenant greeting edits had no effect.
            const tenantGreeting = typeof this.tenantGreetingText === 'string' && this.tenantGreetingText.trim()
                ? this.tenantGreetingText.trim()
                : undefined;
            const baseGreeting = tenantGreeting ?? env_1.env.GREETING_TEXT ?? 'Hi! Thanks for calling. How can I help you today?';
            const greetingText = typeof shared_1.greetingWithCallerName === 'function'
                ? shared_1.greetingWithCallerName(baseGreeting, this.cidMatch?.name)
                : baseGreeting;
            this.beginLatencyTurn('greeting', { transcript_chars: greetingText.length });
            if (this.transport.mode === 'webrtc_hd') {
                await this.playText(greetingText, 'greeting');
                this.recordPickupGreetingInHistory(greetingText);
                return;
            }
            // PSTN: use live TTS for the greeting so it respects per-tenant Redis TTS (mode, speaker, URL).
            // Pre-baked `{AUDIO_PUBLIC_BASE_URL}/greeting.wav` is generated once at process startup from
            // env TTS_MODE / env voice only — it does not follow tenantcfg, so the opening line could
            // stay on the default (e.g. Kokoro female) after switching to Qwen3 or another voice.
            if (this.transport.mode === 'pstn') {
                if (this.shouldSkipTelnyxAction('playback_start')) {
                    return;
                }
                await this.playText(greetingText, 'greeting');
                this.recordPickupGreetingInHistory(greetingText);
                return;
            }
            log_1.log.warn({ transport_mode: this.transport.mode, ...this.logContext }, 'unexpected transport mode for greeting (expected pstn or webrtc_hd)');
        }
        catch (error) {
            log_1.log.error({ err: error, ...this.logContext }, 'call start greeting failed');
        }
    }
    async playAssistantTurn(text, forcedTurnId) {
        const turnId = forcedTurnId ?? `turn-${this.nextTurnId()}`;
        // VERA_DEMO_SHOP_TTS_REPLYTEXT_UNWRAP_20260906 — belt-and-suspenders before any playText/TTS
        if (this.tenantId === 'demo-shop' && text) {
            text = this.extractDemoShopSpokenText(text);
        }
        // VERA_DEMO_SHOP_DATECONFIRM_20260905 — belt-and-suspenders before TTS (non-stream / fallback)
        if (this.tenantId === 'demo-shop' && text) {
            const dateConfirmPlay = this.maybeRewriteDemoShopDateConfirm(text);
            if (dateConfirmPlay !== text)
                text = dateConfirmPlay;
            const regreetPlay = this.maybeRewriteDemoShopRegreet(text);
            if (regreetPlay !== text)
                text = regreetPlay;
            if (!String(text || '').trim())
                text = 'Could I have your name?';
        }
        // VERA_DEMO_SHOP_TURN_20260905 — cap non-stream full-reply speak length
        if (this.tenantId === 'demo-shop' && text && String(text).length > 220) {
            const cut = this.truncateDemoShopReply(text, 200);
            if (cut && cut !== text) {
                log_1.log.info({
                    event: 'demo_shop_reply_truncated',
                    cap_chars: 200,
                    original_len: String(text).length,
                    ...this.logContext,
                }, 'demo shop full-reply truncated before TTS');
                text = cut;
            }
        }
        await this.playText(text, turnId);
    }
    async playText(text, turnId, options) {
        const allowWhenEnded = options?.allowWhenEndedForLateFinal === true;
        if (!allowWhenEnded && (!this.active || this.state === 'ENDED')) {
            return;
        }
        text = this.normalizeDemoShopSpeakText(text);
        if (typeof this.refreshPublishedTts === 'function') {
            await this.refreshPublishedTts();
        }
        // VERA_DEMO_SHOP_PLAYSERIAL_20260907 — this play owns an epoch; rewrite/stop bumps it
        // so a slower in-flight synthesize cannot telnyx_play after a newer clip started.
        this.demoShopPlayEpoch = (this.demoShopPlayEpoch || 0) + 1;
        const playEpoch = this.demoShopPlayEpoch;
        this.beginPlayback(turnId);
        let playbackEndDeferred = false;
        let playbackEndHandled = false;
        const safeForensicsTurn = turnId.replace(/[^a-zA-Z0-9._-]/g, '_');
        const fosSession = (0, audioForensics_1.getForensicsSession)(this.callControlId);
        if (fosSession) {
            void fosSession.appendPlaybackJsonl(safeForensicsTurn, {
                event: 'playback_start_requested',
                turn_id: turnId,
                wallClockMs: Date.now(),
            });
            (0, audioForensics_1.forensicsTimeline)(this.callControlId, {
                event: 'playback_start_requested',
                turnId: safeForensicsTurn,
                wallClockMs: Date.now(),
                state: this.state,
                playbackActive: true,
                listening: this.isListening(),
            });
        }
        try {
            const tenantLabel = this.tenantId ?? 'unknown';
            const useQwenChunking = false;
            const splitChunks = useQwenChunking ? (0, qwen3Chunking_1.splitQwenStreamingChunks)(text) : [];
            const effectiveChunks = splitChunks.length > 0 ? splitChunks : [text];
            for (let ci = 0; ci < effectiveChunks.length; ci++) {
                const chunkText = effectiveChunks[ci];
                this.pushAssistantEchoReference(chunkText);
                const chunkPlaybackId = effectiveChunks.length === 1 ? turnId : `${turnId}-q${ci}`;
                const isLastChunk = ci === effectiveChunks.length - 1;
                const endTts = (0, metrics_1.startStageTimer)('tts', tenantLabel);
                const spanMeta = {
                    callId: this.callControlId,
                    tenantId: this.tenantId,
                    logContext: { ...this.logContext, tts_id: chunkPlaybackId },
                    kind: chunkPlaybackId,
                };
                (0, audioProbe_1.markAudioSpan)('tts_start', spanMeta);
                const ttsStart = Date.now();
                this.markLatency('tts_queued_at_ms');
                if (this.transport.mode === 'pstn') {
                    const streamed = await (0, tts_1.tryPlayKokoroStreamToTelnyx)({
                        callControlId: this.callControlId,
                        text: chunkText,
                        ttsConfig: this.ttsConfig,
                        logContext: this.logContext,
                        shouldAbort: () => !this.active ||
                            this.state === 'ENDED' ||
                            this.playbackState.interrupted ||
                            (this.tenantId === 'demo-shop' && playEpoch !== (this.demoShopPlayEpoch || 0)) ||
                            (this.shouldSkipTelnyxAction('playback_start') && !allowWhenEnded),
                        onFirstAudio: () => {
                            (0, audioProbe_1.markAudioSpan)('tts_ready', spanMeta);
                            (0, audioProbe_1.markAudioSpan)('tx_sent', spanMeta);
                            this.markLatency('tts_ready_at_ms');
                            this.maybeRecordTurnFinalToFirstPlaybackMs(tenantLabel);
                            (0, audioInvariantReport_1.recordPlayStart)(this.callControlId);
                            const playbackStart = Date.now();
                            if (this.tenantId === 'demo-shop') {
                                this.demoShopTtsPlaybackStartAtMs = playbackStart;
                                this.demoShopTelnyxPlayStartedAtMs = 0;
                            }
                            this.audioCoordinator.onTtsStart(playbackStart, 'tts_playback_start');
                        },
                        onDurationMs: (ms) => {
                            this.playbackState.segmentDurationMs = ms;
                        },
                    });
                    endTts();
                    if (streamed.ok) {
                        log_1.log.info({
                            event: 'tts_synthesized',
                            duration_ms: Date.now() - ttsStart,
                            stream_chunks: streamed.chunks,
                            first_audio_ms: streamed.firstAudioMs,
                            ...this.logContext,
                        }, 'tts synthesized');
                        if (isLastChunk)
                            playbackEndDeferred = true;
                        continue;
                    }
                }
                let result;
                try {
                    const currentSpeakerWavUrl = this.getCurrentSpeakerWavUrl();
                    result = await (0, tts_1.synthesizeSpeech)({
                        text: chunkText,
                        voice: this.ttsConfig?.voice,
                        format: this.ttsConfig?.format,
                        sampleRate: this.ttsConfig?.sampleRate,
                        speakerWavUrl: currentSpeakerWavUrl,
                    }, this.ttsConfig);
                    if (currentSpeakerWavUrl) {
                        log_1.log.info({
                            event: 'tts_voice_cloning_used',
                            voice_mode: this.currentVoiceMode,
                            turn_id: chunkPlaybackId,
                            ...this.logContext,
                        }, 'TTS using cloned voice');
                    }
                }
                catch (error) {
                    (0, metrics_1.incStageError)('tts', tenantLabel);
                    throw error;
                }
                finally {
                    endTts();
                }
                const ttsDuration = Date.now() - ttsStart;
                (0, audioProbe_1.markAudioSpan)('tts_ready', spanMeta);
                this.markLatency('tts_ready_at_ms');
                log_1.log.info({
                    event: 'tts_synthesized',
                    duration_ms: ttsDuration,
                    audio_bytes: result.audio.length,
                    qwen_chunk_index: effectiveChunks.length > 1 ? ci : undefined,
                    qwen_chunk_total: effectiveChunks.length > 1 ? effectiveChunks.length : undefined,
                    ...this.logContext,
                }, 'tts synthesized');
                const fos = (0, audioForensics_1.getForensicsSession)(this.callControlId);
                const safeChunkId = chunkPlaybackId.replace(/[^a-zA-Z0-9._-]/g, '_');
                if (fos) {
                    void fos
                        .writeJson(`tts/011_tts_request_${safeChunkId}.json`, {
                        text: chunkText,
                        voice: this.ttsConfig?.voice,
                        format: this.ttsConfig?.format,
                        content_type: result.contentType,
                        mode: this.ttsConfig?.mode,
                    })
                        .catch(() => undefined);
                    (0, audioForensics_1.forensicsTimeline)(this.callControlId, {
                        event: 'tts_request_sent',
                        turnId: safeChunkId,
                        wallClockMs: Date.now(),
                        state: this.state,
                        playbackActive: true,
                        listening: this.isListening(),
                    });
                    const rawExt = result.contentType?.includes('wav') ? 'wav' : 'bin';
                    void fos.writeBinary(`tts/012_tts_raw_${safeChunkId}.${rawExt}`, result.audio).catch(() => undefined);
                    (0, audioForensics_1.forensicsTimeline)(this.callControlId, {
                        event: 'tts_response_received',
                        turnId: safeChunkId,
                        wallClockMs: Date.now(),
                        audio_bytes: result.audio.length,
                        state: this.state,
                        playbackActive: true,
                        listening: this.isListening(),
                    });
                }
                if (!options?.allowWhenEndedForLateFinal && (!this.active || this.playbackState.interrupted)) {
                    return;
                }
                if (this.tenantId === 'demo-shop' && playEpoch !== (this.demoShopPlayEpoch || 0)) {
                    log_1.log.info({
                        event: 'demo_shop_play_dropped_stale_epoch',
                        marker: 'VERA_DEMO_SHOP_PLAYSERIAL_20260907',
                        play_epoch: playEpoch,
                        current_epoch: this.demoShopPlayEpoch,
                        turn_id: chunkPlaybackId,
                        ...this.logContext,
                    }, 'demo shop dropped stale TTS play after rewrite/stop');
                    (0, audioInvariantReport_1.recordStaleEpochDrop)(this.callControlId);
                    return;
                }
                this.logTtsBytesReady(chunkPlaybackId, result.audio, result.contentType);
                let playbackAudio = result.audio;
                const applyPstnPipeline = env_1.env.PLAYBACK_PROFILE === 'pstn' && this.transport.mode === 'pstn';
                if (applyPstnPipeline) {
                    const endPipeline = (0, metrics_1.startStageTimer)('tts_pipeline_ms', tenantLabel);
                    const pipelineResult = (0, playbackPipeline_1.runPlaybackPipeline)(playbackAudio, {
                        targetSampleRateHz: env_1.env.PLAYBACK_PSTN_SAMPLE_RATE,
                        enableHighpass: env_1.env.PLAYBACK_ENABLE_HIGHPASS,
                        logContext: this.logContext,
                    });
                    endPipeline();
                    playbackAudio = pipelineResult.audio;
                }
                if (applyPstnPipeline) {
                    this.logWavInfo('pipeline_output', chunkPlaybackId, playbackAudio);
                    const pipelineMeta = (0, audioProbe_1.getAudioMeta)(playbackAudio) ?? {
                        format: 'wav',
                        logContext: { ...this.logContext, tts_id: chunkPlaybackId },
                        lineage: ['pipeline:unknown'],
                    };
                    (0, audioProbe_1.probeWav)('tts.out.telephonyOptimized', playbackAudio, pipelineMeta);
                }
                result.audio = playbackAudio;
                if (fos && playbackAudio.length >= 12 && playbackAudio.toString('ascii', 0, 4) === 'RIFF') {
                    void fos.writeBinary(`playback/013_telnyx_playback_${safeChunkId}.wav`, playbackAudio).catch(() => undefined);
                }
                const playbackInput = this.transport.mode === 'pstn'
                    ? { kind: 'url', url: await (0, audioStore_1.storeWav)(this.callControlId, chunkPlaybackId, result.audio) }
                    : { kind: 'buffer', audio: result.audio, contentType: result.contentType };
                if (this.playbackState.interrupted) {
                    return;
                }
                if (this.tenantId === 'demo-shop' && playEpoch !== (this.demoShopPlayEpoch || 0)) {
                    log_1.log.info({
                        event: 'demo_shop_play_dropped_stale_epoch',
                        marker: 'VERA_DEMO_SHOP_PLAYSERIAL_20260907',
                        play_epoch: playEpoch,
                        current_epoch: this.demoShopPlayEpoch,
                        turn_id: chunkPlaybackId,
                        ...this.logContext,
                    }, 'demo shop dropped stale TTS play after rewrite/stop');
                    (0, audioInvariantReport_1.recordStaleEpochDrop)(this.callControlId);
                    return;
                }
                if (this.transport.mode === 'pstn' && this.shouldSkipTelnyxAction('playback_start')) {
                    this.endPlaybackAuthoritatively('watchdog');
                    playbackEndHandled = true;
                    return;
                }
                try {
                    const wavInfo = (0, wavInfo_1.parseWavInfo)(playbackAudio);
                    this.playbackState.segmentDurationMs = wavInfo.durationMs;
                }
                catch {
                    this.playbackState.segmentDurationMs = undefined;
                }
                (0, farEndReference_1.pushFarEndFrames)(this.callControlId, playbackAudio, this.logContext);
                log_1.log.info({
                    event: 'tts_playback_start',
                    turn_id: chunkPlaybackId,
                    playback_mode: this.transport.mode,
                    audio_url: this.transport.mode === 'pstn'
                        ? playbackInput.url
                        : undefined,
                    audio_bytes: this.transport.mode === 'pstn' ? undefined : playbackAudio.length,
                    ...this.logContext,
                }, 'tts playback start');
                const playbackStage = this.transport.mode === 'pstn' ? 'telnyx_playback' : 'webrtc_playback_ms';
                const endPlayback = (0, metrics_1.startStageTimer)(playbackStage, tenantLabel);
                const playbackStart = Date.now();
                // VERA_DEMO_SHOP_SPEAKERPHONE_20260905
                if (this.tenantId === 'demo-shop') {
                    this.demoShopTtsPlaybackStartAtMs = playbackStart;
                    this.demoShopTelnyxPlayStartedAtMs = 0;
                }
                this.audioCoordinator.onTtsStart(playbackStart, 'tts_playback_start');
                if (fos) {
                    void fos.appendPlaybackJsonl(safeChunkId, {
                        event: 'playback_started',
                        turn_id: chunkPlaybackId,
                        wallClockMs: playbackStart,
                    });
                    (0, audioForensics_1.forensicsTimeline)(this.callControlId, {
                        event: 'playback_started',
                        turnId: safeChunkId,
                        wallClockMs: playbackStart,
                        state: this.state,
                        playbackActive: true,
                        listening: this.isListening(),
                    });
                }
                try {
                    if (this.transport.mode === 'pstn') {
                        const txMeta = (0, audioProbe_1.getAudioMeta)(playbackAudio) ?? {
                            format: 'wav',
                            logContext: { ...this.logContext, tts_id: chunkPlaybackId },
                            lineage: ['tx:unknown'],
                        };
                        (0, audioProbe_1.probeWav)('tx.telnyx.payload', playbackAudio, { ...txMeta, kind: chunkPlaybackId });
                    }
                    (0, audioProbe_1.markAudioSpan)('tx_sent', spanMeta);
                    this.maybeRecordTurnFinalToFirstPlaybackMs(tenantLabel);
                    (0, audioInvariantReport_1.recordPlayStart)(this.callControlId);
                    await this.transport.playback.play(playbackInput);
                    this.markLatency('play_http_at_ms');
                    // VERA_DEMO_SHOP_SPEAKERPHONE_20260905 — telnyx play accept (HTTP returned); early-barge window uses this
                    if (this.tenantId === 'demo-shop') {
                        this.demoShopTelnyxPlayStartedAtMs = Date.now();
                    }
                    if (this.transport.mode === 'pstn') {
                        if (isLastChunk) {
                            playbackEndDeferred = true;
                        }
                    }
                    else if (isLastChunk) {
                        this.onPlaybackEnded();
                        playbackEndHandled = true;
                    }
                }
                catch (error) {
                    (0, metrics_1.incStageError)(playbackStage, tenantLabel);
                    if (!playbackEndHandled) {
                        if (this.transport.mode === 'pstn') {
                            this.endPlaybackAuthoritatively('watchdog');
                        }
                        else {
                            this.onPlaybackEnded();
                        }
                        playbackEndHandled = true;
                    }
                    throw error;
                }
                finally {
                    endPlayback();
                }
                const playbackDuration = Date.now() - playbackStart;
                if (this.transport.mode === 'pstn') {
                    log_1.log.info({
                        event: 'telnyx_playback_duration',
                        duration_ms: playbackDuration,
                        audio_url: playbackInput.url,
                        ...this.logContext,
                    }, 'telnyx playback completed');
                }
            }
        }
        catch (error) {
            log_1.log.error({ err: error, ...this.logContext }, 'call session tts playback failed');
        }
        finally {
            // ✅ Do NOT force LISTENING here.
            // onPlaybackEnded() is the single source of truth for clearing playback + entering LISTENING.
            // But if we returned early (e.g. interrupted) and somehow stayed SPEAKING/active, clean up.
            if (!playbackEndHandled && !playbackEndDeferred && (this.playbackState.active || this.state === 'SPEAKING')) {
                if (this.transport.mode === 'pstn') {
                    this.endPlaybackAuthoritatively('watchdog');
                }
                else {
                    this.onPlaybackEnded();
                }
            }
        }
    }
  
    queueTtsSegment(segmentText, segmentId, handlingToken) {
        if (!segmentText.trim()) {
            return;
        }
        if (!this.active || this.state === 'ENDED') {
            return;
        }
        if (handlingToken !== undefined && handlingToken !== this.transcriptHandlingToken) {
            return;
        }
        if (!this.playbackState.active) {
            this.beginPlayback(segmentId);
        }
        this.ttsSegmentQueueDepth += 1;
        const queueDepth = this.ttsSegmentQueueDepth;
        log_1.log.info({
            event: 'tts_segment_queued',
            seg_len: segmentText.length,
            queue_depth: queueDepth,
            segment_id: segmentId,
            ...this.logContext,
        }, 'tts segment queued');
        this.markLatency('tts_queued_at_ms');
        const chainEpoch = this.ttsSegmentChainEpoch || 0;
        this.ttsSegmentChain = this.ttsSegmentChain
            .then(async () => {
            await this.playTtsSegment(segmentText, segmentId);
        })
            .catch((error) => {
            log_1.log.error({ err: error, ...this.logContext }, 'tts segment playback failed');
        })
            .finally(() => {
            // VERA_DEMO_SHOP_PSTN_WAIT_20260905 — ignore superseded chain after clearTtsQueue/rewrite interrupt
            if (chainEpoch !== (this.ttsSegmentChainEpoch || 0)) {
                return;
            }
            this.ttsSegmentQueueDepth = Math.max(0, this.ttsSegmentQueueDepth - 1);
            // ✅ Playback ends ONCE when all queued segments are done
            if (this.ttsSegmentQueueDepth === 0) {
                if (this.transport.mode !== 'pstn') {
                    this.onPlaybackEnded();
                }
                else if (this.tenantId === 'demo-shop' && this.playbackState.active && !this.playbackState.interrupted) {
                    // VERA_DEMO_SHOP_PSTN_WAIT_20260905 — webhook may have arrived while depth>0
                    // (early-return); after drain, authoritatively end so we re-enter LISTENING.
                    this.endPlaybackAuthoritatively('segment_drain');
                }
            }
        });
    }
    
    async playTtsSegment(segmentText, segmentId) {
        const shouldAbort = !this.active || this.state === 'ENDED' || this.playbackState.interrupted;
        if (shouldAbort) {
            return;
        }
        if (typeof this.refreshPublishedTts === 'function') {
            await this.refreshPublishedTts();
        }
        const tenantLabel = this.tenantId ?? 'unknown';
        const endTts = (0, metrics_1.startStageTimer)('tts', tenantLabel);
        const spanMeta = {
            callId: this.callControlId,
            tenantId: this.tenantId,
            logContext: { ...this.logContext, tts_id: segmentId },
            kind: segmentId,
        };
        (0, audioProbe_1.markAudioSpan)('tts_start', spanMeta);
        const ttsStart = Date.now();
        if (this.transport.mode === 'pstn') {
            const streamed = await (0, tts_1.tryPlayKokoroStreamToTelnyx)({
                callControlId: this.callControlId,
                text: segmentText,
                ttsConfig: this.ttsConfig,
                logContext: this.logContext,
                shouldAbort: () => !this.active || this.state === 'ENDED' || this.playbackState.interrupted,
                onFirstAudio: () => {
                    (0, audioProbe_1.markAudioSpan)('tts_ready', spanMeta);
                    (0, audioProbe_1.markAudioSpan)('tx_sent', spanMeta);
                    this.markLatency('tts_ready_at_ms');
                    this.maybeRecordTurnFinalToFirstPlaybackMs(tenantLabel);
                    (0, audioInvariantReport_1.recordPlayStart)(this.callControlId);
                    this.audioCoordinator.onTtsStart(Date.now(), 'tts_segment_playback_start');
                },
                onDurationMs: (ms) => {
                    this.playbackState.segmentDurationMs = ms;
                },
            });
            endTts();
            if (streamed.ok) {
                log_1.log.info({
                    event: 'tts_synthesized',
                    duration_ms: Date.now() - ttsStart,
                    stream_chunks: streamed.chunks,
                    first_audio_ms: streamed.firstAudioMs,
                    ...this.logContext,
                }, 'tts synthesized');
                return;
            }
        }
        let result;
        try {
            const currentSpeakerWavUrl = this.getCurrentSpeakerWavUrl();
            result = await (0, tts_1.synthesizeSpeech)({
                text: segmentText,
                voice: this.ttsConfig?.voice,
                format: this.ttsConfig?.format,
                sampleRate: this.ttsConfig?.sampleRate,
                speakerWavUrl: currentSpeakerWavUrl,
            }, this.ttsConfig);
            if (currentSpeakerWavUrl) {
                log_1.log.info({
                    event: 'tts_voice_cloning_used',
                    voice_mode: this.currentVoiceMode,
                    segment_id: segmentId,
                    ...this.logContext,
                }, 'TTS segment using cloned voice');
            }
        }
        catch (error) {
            (0, metrics_1.incStageError)('tts', tenantLabel);
            throw error;
        }
        finally {
            endTts();
        }
        const ttsDuration = Date.now() - ttsStart;
        (0, audioProbe_1.markAudioSpan)('tts_ready', spanMeta);
        this.markLatency('tts_ready_at_ms');
        log_1.log.info({
            event: 'tts_synthesized',
            duration_ms: ttsDuration,
            audio_bytes: result.audio.length,
            ...this.logContext,
        }, 'tts synthesized');
        if (!this.active || this.state === 'ENDED' || this.playbackState.interrupted) {
            return;
        }
        this.logTtsBytesReady(segmentId, result.audio, result.contentType);
        let playbackAudio = result.audio;
        const applyPstnPipeline = env_1.env.PLAYBACK_PROFILE === 'pstn' && this.transport.mode === 'pstn';
        if (applyPstnPipeline) {
            const endPipeline = (0, metrics_1.startStageTimer)('tts_pipeline_ms', tenantLabel);
            const pipelineResult = (0, playbackPipeline_1.runPlaybackPipeline)(playbackAudio, {
                targetSampleRateHz: env_1.env.PLAYBACK_PSTN_SAMPLE_RATE,
                enableHighpass: env_1.env.PLAYBACK_ENABLE_HIGHPASS,
                logContext: this.logContext,
            });
            endPipeline();
            playbackAudio = pipelineResult.audio;
        }
        if (applyPstnPipeline) {
            this.logWavInfo('pipeline_output', segmentId, playbackAudio);
            const pipelineMeta = (0, audioProbe_1.getAudioMeta)(playbackAudio) ?? {
                format: 'wav',
                logContext: { ...this.logContext, tts_id: segmentId },
                lineage: ['pipeline:unknown'],
            };
            (0, audioProbe_1.probeWav)('tts.out.telephonyOptimized', playbackAudio, pipelineMeta);
        }
        result.audio = playbackAudio;
        const playbackInput = this.transport.mode === 'pstn'
            ? { kind: 'url', url: await (0, audioStore_1.storeWav)(this.callControlId, segmentId, result.audio) }
            : { kind: 'buffer', audio: result.audio, contentType: result.contentType };
        if (this.playbackState.interrupted) {
            return;
        }
        if (this.transport.mode === 'pstn') {
            log_1.log.info({
                event: 'tts_segment_play_start',
                seg_len: segmentText.length,
                segment_id: segmentId,
                audio_url: playbackInput.url,
                ...this.logContext,
            }, 'tts segment playback start');
        }
        // Tier 2: set segment duration for measured listen-after-playback grace
        try {
            const wavInfo = (0, wavInfo_1.parseWavInfo)(playbackAudio);
            this.playbackState.segmentDurationMs = wavInfo.durationMs;
        }
        catch {
            this.playbackState.segmentDurationMs = undefined;
        }
        // Tier 3: push far-end reference for AEC (decode WAV → 16k frames)
        (0, farEndReference_1.pushFarEndFrames)(this.callControlId, playbackAudio, this.logContext);
        const playbackStage = this.transport.mode === 'pstn'
            ? 'telnyx_playback'
            : 'webrtc_playback_ms';
        const endPlayback = (0, metrics_1.startStageTimer)(playbackStage, tenantLabel);
        const playbackStart = Date.now();
        this.audioCoordinator.onTtsStart(playbackStart, 'tts_segment_playback_start');
        try {
            if (this.transport.mode === 'pstn') {
                const txMeta = (0, audioProbe_1.getAudioMeta)(playbackAudio) ?? {
                    format: 'wav',
                    logContext: { ...this.logContext, tts_id: segmentId },
                    lineage: ['tx:unknown'],
                };
                (0, audioProbe_1.probeWav)('tx.telnyx.payload', playbackAudio, { ...txMeta, kind: segmentId });
            }
      (0, audioProbe_1.markAudioSpan)('tx_sent', spanMeta);
      this.maybeRecordTurnFinalToFirstPlaybackMs(tenantLabel);
      (0, audioInvariantReport_1.recordPlayStart)(this.callControlId);
      await this.transport.playback.play(playbackInput);
            this.markLatency('play_http_at_ms');
            // VERA_DEMO_SHOP_PSTN_WAIT_20260905 — Telnyx play() resolves on HTTP accept (~200ms),
            // NOT audio end. Await webhook / duration+margin / stop before chain advances.
            if (this.tenantId === 'demo-shop' && this.transport.mode === 'pstn') {
                this.playbackState.segmentId = segmentId;
                this.armPstnPlaybackWatchdog();
                await this.waitDemoShopPstnSegmentAudioEnd(this.playbackState.segmentDurationMs, segmentId);
            }
            // ✅ IMPORTANT: do NOT call onPlaybackEnded() here.
            // Streaming playback ends when the segment queue drains.
        }
        catch (error) {
            (0, metrics_1.incStageError)(playbackStage, tenantLabel);
            // ✅ IMPORTANT: do NOT call onPlaybackEnded() here either.
            throw error;
        }
        finally {
            endPlayback();
        }
        const playbackDuration = Date.now() - playbackStart;
        if (this.transport.mode === 'pstn') {
            log_1.log.info({
                event: 'tts_segment_play_end',
                seg_len: segmentText.length,
                segment_id: segmentId,
                duration_ms: playbackDuration,
                audio_url: playbackInput.url,
                ...this.logContext,
            }, 'tts segment playback end');
            if (this.tenantId === 'demo-shop' && String(segmentId).endsWith('-remainder')) {
                log_1.log.info({
                    event: 'demo_shop_segment_remainder_spoken',
                    marker: 'VERA_DEMO_SHOP_STREAMTTS_REMAINDER_20260906',
                    segment_id: segmentId,
                    seg_len: segmentText.length,
                    duration_ms: playbackDuration,
                    ...this.logContext,
                }, 'demo shop STREAMTTS remainder spoken');
            }
        }
    }
    waitForTtsSegmentQueue() {
        if (!this.playbackStopSignal) {
            return this.ttsSegmentChain;
        }
        return Promise.race([this.ttsSegmentChain, this.playbackStopSignal.promise]);
    }


    /**
     * VERA_DEMO_SHOP_TTS_REPLYTEXT_UNWRAP_20260906
     * Speak only replyText (or equivalent plain speak field) — never raw JSON schema envelopes.
     * Safe for complete JSON or regex fallback when replyText string is present.
     */
    isDemoShopJsonSpeakEnvelope(text) {
        const t = String(text || '').trim();
        return t.startsWith('{') && /"(?:replyText|reply_text|actions|stage|leadUpdates)"\s*:/.test(t);
    }
    extractDemoShopSpokenText(raw, options) {
        const silent = options && options.silent === true;
        if (!raw || this.tenantId !== 'demo-shop')
            return raw;
        const s = String(raw).trim();
        if (!s)
            return s;
        const tryParse = (text) => {
            try {
                const obj = JSON.parse(text);
                if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
                    for (const key of ['replyText', 'reply_text', 'spokenText', 'speak', 'message', 'text']) {
                        if (typeof obj[key] === 'string' && obj[key].trim())
                            return obj[key].trim();
                    }
                }
            }
            catch (_e) { /* incomplete or non-JSON */ }
            return null;
        };
        let extracted = tryParse(s);
        if (!extracted) {
            const m = s.match(/"replyText"\s*:\s*"((?:\\.|[^"\\])*)"/);
            if (m && m[1]) {
                extracted = m[1]
                    .replace(/\\n/g, ' ')
                    .replace(/\\r/g, ' ')
                    .replace(/\\t/g, ' ')
                    .replace(/\\"/g, '"')
                    .replace(/\\\\/g, '\\')
                    .trim();
            }
        }
        if (extracted) {
            if (!silent && extracted !== s) {
                log_1.log.info({
                    event: 'demo_shop_tts_replytext_unwrap',
                    marker: 'VERA_DEMO_SHOP_TTS_REPLYTEXT_UNWRAP_20260906',
                    original_len: s.length,
                    spoken_len: extracted.length,
                    ...this.logContext,
                }, 'demo shop unwrapped replyText before TTS');
            }
            return extracted;
        }
        if (this.isDemoShopJsonSpeakEnvelope(s)) {
            if (!silent) {
                log_1.log.warn({
                    event: 'demo_shop_tts_json_envelope_blocked',
                    marker: 'VERA_DEMO_SHOP_TTS_REPLYTEXT_UNWRAP_20260906',
                    original_len: s.length,
                    preview: s.slice(0, 96),
                    ...this.logContext,
                }, 'demo shop blocked unparseable JSON envelope from TTS');
            }
            return '';
        }
        return s;
    }

    /**
     * VERA_DEMO_SHOP_TTS_PREP_20260904 + VERA_DEMO_SHOP_HARDEN_20260904
     * Demo Shop only: strip markdown emphasis, unbroken AM/PM + digit-by-digit phone for TTS.
     * Does not alter conversationHistory (booking normalizer still sees raw text).
     */
    normalizeDemoShopSpeakText(text) {
        if (!text || this.tenantId !== 'demo-shop')
            return text;
        // VERA_DEMO_SHOP_TTS_REPLYTEXT_UNWRAP_20260906 — choke-point before any Chatterbox/TTS speak
        text = this.extractDemoShopSpokenText(text, { silent: true });
        if (!text)
            return text;
        const digitWords = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];
        const expandDigits = (digits) => String(digits).split('').map((d) => digitWords[Number(d)] ?? d).join(' ');
        let s = String(text);
        // Strip markdown emphasis so TTS does not speak star-star / read **September**
        s = s.replace(/\*\*([^*]+)\*\*/g, '$1');
        s = s.replace(/__([^_]+)__/g, '$1');
        s = s.replace(/\*\*/g, '').replace(/__/g, '');
        // Times: 2 p.m. / 2pm / 2:30 a.m. → "2 PM" / "2:30 AM" (no periods for chunker or Kokoro)
        s = s.replace(/\b(\d{1,2})(?::(\d{2}))?\s*([ap])\.?\s*m\.?\b/gi, (_m, h, mm, ap) => {
            const label = `${String(ap).toUpperCase()}M`;
            return mm ? `${h}:${mm} ${label}` : `${h} ${label}`;
        });
        // 10-digit phone: 208-625-1175 / 208.625.1175 / 208 625 1175
        s = s.replace(/\b(\d{3})[-.\s](\d{3})[-.\s](\d{4})\b/g, (_m, a, b, c) => `${expandDigits(a)}, ${expandDigits(b)}, ${expandDigits(c)}`);
        // 7-digit local: 625-1175 / 625 1175
        s = s.replace(/\b(\d{3})[-.\s](\d{4})\b/g, (_m, a, b) => `${expandDigits(a)}, ${expandDigits(b)}`);
        return s;
    }

    /** VERA_DEMO_SHOP_HARDEN_20260904 */
    demoShopDigitCount(text) {
        return (String(text || '').match(/\d/g) || []).length;
    }
    isDemoShopContactCollectionAsk(text) {
        const t = String(text || '').replace(/[\u2018\u2019\u201A\u201B\u2032\u2035\u02BC]/g, "'").toLowerCase();
        if (!t)
            return false;
        const contact = /\b(phone|phone number|mobile|cell|email|e-?mail|contact (number|info|details)|best number|callback number|reach you)\b/.test(t);
        if (!contact)
            return false;
        // Question / request cues (include trailing ? and "your phone/email")
        if (/[?]\s*$/.test(t))
            return true;
        if (/\b(what|what's|whats|may i|can i|could i|please|need|get|confirm|leave|share|give|spell|say|tell|your (phone|number|email|e-?mail))\b/.test(t))
            return true;
        return false;
    }
    isDemoShopGoodbye(text) {
        const raw = String(text || '').trim();
        if (!raw)
            return false;
        if (/^(bye\.?\s*)+$/i.test(raw))
            return true;
        const t = raw.toLowerCase().replace(/[.!,]+/g, ' ').replace(/\s+/g, ' ').trim();
        if (/^(good\s*bye|goodbye|bye bye|bye for now)(\s+now)?$/.test(t))
            return true;
        if (/^(that's all|that is all|hang ?up|i'm done|im done|all done|nothing else|no thanks?)$/.test(t))
            return true;
        return false;
    }
    isDemoShopIncompleteContact(text) {
        const raw = String(text || '').trim();
        if (!raw)
            return false;
        if (/^my (phone number|phone|number|email|e-?mail) is\.?\s*$/i.test(raw))
            return true;
        if (/^my phone( number)? is\b/i.test(raw) && this.demoShopDigitCount(raw) < 10)
            return true;
        if (/^my (number|email|e-?mail) is\b/i.test(raw)) {
            const after = raw.replace(/^my (?:number|email|e-?mail) is\.?\s*/i, '').trim();
            if (!after)
                return true;
            if (/^my (email|e-?mail) is\b/i.test(raw) && !/@/.test(raw) && after.length < 6)
                return true;
            if (/^my number is\b/i.test(raw) && this.demoShopDigitCount(raw) < 10)
                return true;
        }
        if (this.demoShopAwaitingContact && /^(uh+|um+|so+|it's|its)\s*$/i.test(raw))
            return true;
        // VERA_DEMO_SHOP_SLOTHEAR_20260907 — 4–9 digit fragments are not a phone.
        // Bare "208-621-175" used to skip HARDEN and reach the LLM, which invented a 10th digit.
        const digits = this.demoShopDigitCount(raw);
        if (digits >= 3 && digits <= 9 && !/@/.test(raw)) {
            const mostlyDigits = /^[\d\-().\s+]+$/.test(raw)
                || /^(?:it'?s|this is|my (?:phone(?: number)?|number) is)\s+[\d\-().\s+]+$/i.test(raw);
            if (mostlyDigits)
                return true;
            if (this.demoShopAwaitingContact && (raw.match(/[A-Za-z]/g) || []).length <= 12)
                return true;
        }
        return false;
    }
    demoShopHasRealContactInHistory() {
        if (this.demoShopDtmfPhone)
            return true;
        const hist = this.conversationHistory || [];
        const userText = hist.filter((t) => t.role === 'user').map((t) => String(t.content || '')).join('\n');
        if (this.extractDemoShopPhone(userText))
            return true;
        if (/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(userText))
            return true;
        return false;
    }
    syncDemoShopContactMaxUtt(assistantText) {
        if (this.tenantId !== 'demo-shop' || !this.stt)
            return;
        if (this._demoShopBaselineMaxUttMs == null) {
            const cur = Number(this.stt.maxUtteranceMs);
            this._demoShopBaselineMaxUttMs = Number.isFinite(cur) && cur > 0 ? cur : 6000;
        }
        if (this._demoShopBaselineSilenceMs == null) {
            const curS = Number(this.stt.silenceEndMs);
            this._demoShopBaselineSilenceMs = Number.isFinite(curS) && curS > 0 ? curS : 550;
        }
        if (this.isDemoShopContactCollectionAsk(assistantText))
            this.demoShopAwaitingContact = true;
        if (this.demoShopHasRealContactInHistory())
            this.demoShopAwaitingContact = false;
        // VERA_DEMO_SHOP_COLLECTPASS_20260907 + PERSONEND — v3:bZtq stacked name+date
        // hit a guessed 6s cap. Fuse until writable; endpoint is caller silence.
        // 1400ms silence stays contact-only (HARDEN/SLOTHEAR); name/date stay 550ms (CONVOFEEL).
        let bookingIncomplete = true;
        try {
            const booking = this.normalizeDemoShopBooking(this.conversationHistory);
            bookingIncomplete = !booking.writable;
            if (booking.hasContact)
                this.demoShopAwaitingContact = false;
        }
        catch (_err) {
            bookingIncomplete = true;
        }
        const wantLongMax = bookingIncomplete || !!this.demoShopAwaitingContact;
        // VERA_DEMO_SHOP_PERSONEND_20260907 — 60s is a runaway fuse, not a guessed
        // talk length. ChunkedSTT ends the turn when the caller goes silent.
        const next = wantLongMax ? 60000 : this._demoShopBaselineMaxUttMs;
        // VERA_DEMO_SHOP_CONVOFEEL_20260906 — contact silence must outlast spoken digit groups.
        // VERA_DEMO_SHOP_SLOTHEAR_20260907 — 800ms still split "208 … 625 … 1175" into finals.
        const nextSilence = this.demoShopAwaitingContact
            ? Math.max(this._demoShopBaselineSilenceMs, 1400)
            : 550;
        if (Number(this.stt.maxUtteranceMs) !== next) {
            this.stt.maxUtteranceMs = next;
            log_1.log.info({
                event: 'demo_shop_contact_max_utt',
                marker: 'VERA_DEMO_SHOP_COLLECTPASS_20260907',
                max_utt_ms: next,
                booking_incomplete: bookingIncomplete,
                awaiting_contact: this.demoShopAwaitingContact,
                ...this.logContext,
            }, 'demo shop collect-pass max utterance tuned');
        }
        if (Number(this.stt.silenceEndMs) !== nextSilence) {
            this.stt.silenceEndMs = nextSilence;
            log_1.log.info({
                event: 'demo_shop_silence_end',
                marker: 'VERA_DEMO_SHOP_CONVOFEEL_20260906',
                silence_end_ms: nextSilence,
                awaiting_contact: this.demoShopAwaitingContact,
                booking_incomplete: bookingIncomplete,
                ...this.logContext,
            }, 'demo shop STT silence tuned');
        }
    }
    /**
     * VERA_DEMO_SHOP_PSTN_WAIT_20260905 — await real PSTN audio end for one TTS segment.
     * Races: call.playback.ended (via resolveDemoShopPstnSegmentWait), durationMs+margin, stop/interrupt.
     */
    waitDemoShopPstnSegmentAudioEnd(durationMs, segmentId) {
        // VERA_DEMO_SHOP_ONEWAV_20260905 + VERA_DEMO_SHOP_STREAMTTS_20260905 —
        // Demo Shop PSTN segment path: ignore stale playback.ended until AFTER this
        // segment's play() armed the waiter (generation + segmentId token).
        if (this.playbackState.interrupted || !this.active || this.state === 'ENDED') {
            return Promise.resolve();
        }
        const marginMs = 400;
        const fallbackMs = (typeof durationMs === 'number' && durationMs > 0)
            ? Math.round(durationMs + marginMs)
            : 6000;
        const playGen = (this.demoShopPstnPlayGeneration = (this.demoShopPstnPlayGeneration || 0) + 1);
        return new Promise((resolve) => {
            let settled = false;
            const finish = (reason) => {
                if (settled)
                    return;
                settled = true;
                if (this.demoShopPstnSegmentWait && this.demoShopPstnSegmentWait.segmentId === segmentId) {
                    this.demoShopPstnSegmentWait = null;
                }
                clearTimeout(timer);
                log_1.log.info({
                    event: 'demo_shop_pstn_segment_wait_done',
                    reason,
                    segment_id: segmentId,
                    play_gen: playGen,
                    wait_budget_ms: fallbackMs,
                    duration_ms: durationMs ?? null,
                    ...this.logContext,
                }, 'demo shop PSTN segment audio wait settled');
                resolve();
            };
            // Arm only after play() returned (caller awaits play then this wait) so a webhook
            // that arrived before this segment's play cannot resolve us.
            this.demoShopPstnSegmentWait = {
                segmentId,
                playGen,
                armed: true,
                resolve: () => finish('webhook'),
            };
            const timer = setTimeout(() => finish('duration'), fallbackMs);
            timer.unref?.();
            if (this.playbackStopSignal) {
                void this.playbackStopSignal.promise.then(() => finish('stop_signal'));
            }
            if (this.playbackState.interrupted || !this.active) {
                finish('interrupted');
            }
        });
    }
    resolveDemoShopPstnSegmentWait(reason) {
        const w = this.demoShopPstnSegmentWait;
        if (!w)
            return;
        // VERA_DEMO_SHOP_ONEWAV_20260905 — stale webhook guard: only the armed waiter for the
        // current play generation / segmentId may settle (ignore pre-play or prior-segment ends).
        if (reason === 'webhook') {
            if (!w.armed)
                return;
            if (w.playGen != null && w.playGen !== this.demoShopPstnPlayGeneration)
                return;
            if (w.segmentId && this.playbackState?.segmentId && w.segmentId !== this.playbackState.segmentId)
                return;
        }
        this.demoShopPstnSegmentWait = null;
        try {
            w.resolve(reason);
        }
        catch {
            /* ignore */
        }
    }
    /**
     * VERA_DEMO_SHOP_PSTN_WAIT_20260905 — clear queued stream segments + stop Telnyx playback
     * before speaking a rewrite (fake-confirm / invented product).
     */
    async interruptDemoShopQueuedTts(reason) {
        if (this.tenantId !== 'demo-shop')
            return;
        log_1.log.info({
            event: 'demo_shop_tts_interrupt_for_rewrite',
            marker: 'VERA_DEMO_SHOP_PLAYSERIAL_20260907',
            reason,
            queue_depth: this.ttsSegmentQueueDepth,
            playback_active: !!this.playbackState?.active,
            ...this.logContext,
        }, 'demo shop clearing TTS queue and stopping playback for rewrite');
        this.playbackState.interrupted = true;
        this.resolvePlaybackStopSignal();
        this.clearTtsQueue();
        try {
            await this.stopPlayback();
        }
        catch (error) {
            log_1.log.warn({ err: serializeCaughtError(error), reason, ...this.logContext }, 'demo shop rewrite stopPlayback failed');
        }
    }
    /** VERA_DEMO_SHOP_PSTN_WAIT_20260905 — mid-stream detect fake confirm / invent before more segments queue. */
    shouldAbortDemoShopStreamForRewrite(text) {
        if (this.tenantId !== 'demo-shop' || !text)
            return false;
        const t = String(text);
        const inventRe = /\b(spiritual|spa|massage|yoga|tarot|psychic|reiki|chakra|crystal)\s+(demo|appointment|session|package|service)?\b/i;
        if (inventRe.test(t))
            return true;
        // VERA_DEMO_SHOP_BOOKTRUTH_20260905 + VERA_DEMO_SHOP_CONTACTCLOCK_20260905
        // + VERA_DEMO_SHOP_NAMETRUTH_20260905 — abort unposted booked-claim even with name+contact
        if (this.demoShopSpeakClaimsBooked(t) && !this.demoShopMidCallBookPosted)
            return true;
        const claimsGotIt = /\b(got it|gotcha|perfect[,.]? i (have|got)|confirmed|you're all set|email on file|number on file|i have (your|the) (number|email|phone)|on file|name and phone)\b/i.test(t);
        if (claimsGotIt && (!this.demoShopHasRealContactInHistory() || !this.demoShopHasCallerNameInHistory()))
            return true;
        // VERA_DEMO_SHOP_MUSTBOOK_20260905 — abort stream if LLM starts a handoff/callback instead of booking
        if (this.isDemoShopHandoffSpeak(t))
            return true;
        if (this.demoShopHasCallerNameInHistory() &&
            /\b(what (would you like to|do you (want to|want)|are you (hoping|looking) to) (demo|see|tour)|what (demo|technology|product)|which (demo|product|technology))\b/i.test(t))
            return true;
        return false;
    }
    maybeRewriteDemoShopFakeConfirm(response) {
        // VERA_DEMO_SHOP_HARDEN_20260904 + VERA_DEMO_SHOP_BOOKTRUTH_20260905
        // Block "on file" / "I've booked" close without real collected name+contact.
        if (this.tenantId !== 'demo-shop' || !response)
            return response;
        const text = String(response);
        const claimsGotIt = /\b(got it|gotcha|perfect[,.]? i (have|got)|confirmed|you're all set|email on file|number on file|i have (your|the) (number|email|phone))\b/i.test(text);
        const claimsOnFile = /\bon file\b/i.test(text) || /\b(name|phone|email|number).{0,48}\bon file\b/i.test(text);
        const claimsBooked = this.demoShopSpeakClaimsBooked(text);
        if (!(claimsGotIt || claimsOnFile || claimsBooked))
            return text;
        const hasContact = this.demoShopHasRealContactInHistory();
        const hasName = this.demoShopHasCallerNameInHistory();
        const bookedUnposted = claimsBooked && !this.demoShopMidCallBookPosted;
        if (hasContact && hasName && !bookedUnposted)
            return text;
        if (bookedUnposted && hasName && hasContact) {
            const hold = this.normalizeDemoShopBooking(this.conversationHistory);
            const holdSpeak = hold && hold.start ? this.formatDemoShopConfirmDateFromIso(hold.start) : null;
            log_1.log.info({
                event: 'demo_shop_unposted_book_rewritten',
                has_name: hasName,
                has_contact: hasContact,
                start: hold && hold.start,
                ...this.logContext,
            }, 'demo shop rewrote unposted booked-claim to booking-now');
            return holdSpeak
                ? `I'm booking ${holdSpeak} now.`
                : "I'm booking that now.";
        }
        log_1.log.info({
            event: 'demo_shop_fake_confirm_rewritten',
            claims_on_file: !!claimsOnFile,
            claims_booked: !!claimsBooked,
            has_name: hasName,
            has_contact: hasContact,
            ...this.logContext,
        }, 'demo shop rewrote fake confirm / on-file / booked-without-contact');
        this.demoShopAwaitingContact = true;
        const hold = this.normalizeDemoShopBooking(this.conversationHistory);
        const holdSpeak = hold && hold.start ? this.formatDemoShopConfirmDateFromIso(hold.start) : null;
        const holdPrefix = holdSpeak ? `Great — I can hold ${holdSpeak}. ` : 'Great — ';
        if (!hasName && !hasContact) {
            this.syncDemoShopContactMaxUtt('what is the best phone number to reach you');
            return `${holdPrefix}what's your name, and a phone or email I can reach you at?`;
        }
        if (!hasName) {
            this.syncDemoShopContactMaxUtt('may i get your name');
            return holdSpeak
                ? `I can hold ${holdSpeak}. And may I get your name?`
                : 'And may I get your name?';
        }
        this.syncDemoShopContactMaxUtt('what is the best phone number to reach you');
        return holdSpeak
            ? `I can hold ${holdSpeak}. You can say the ten digits, or tap them on the keypad.`
            : 'You can say the ten digits, or tap them on the keypad.';
    }
    /** VERA_DEMO_SHOP_MUSTBOOK_20260905 — detect LLM handoff/callback instead of on-call booking. */
    isDemoShopHandoffSpeak(text) {
        const t = String(text || '');
        if (!t.trim())
            return false;
        // Explicit handoff / follow-up / call-back-to-schedule patterns
        if (/\b(i('ll| will)|we('ll| will)|someone|a (human|person|teammate|colleague)|nicholas|nick)\b.{0,40}\b(follow[- ]?up|reach out|get back|call (you )?back|contact you)\b/i.test(t))
            return true;
        if (/\b(have|let)\s+(nicholas|nick|someone|a (human|person|teammate))\b.{0,40}\b(follow[- ]?up|reach out|call|contact|schedule|book)\b/i.test(t))
            return true;
        if (/\b(call you back|reach out|follow[- ]?up).{0,40}\b(to )?(set up|schedule|book|arrange)\b/i.test(t))
            return true;
        if (/\bsomeone will (reach out|call|contact|follow)\b/i.test(t))
            return true;
        if (/\b(schedule|book|set up).{0,30}\b(later|offline|after (this|the) call|separately)\b/i.test(t))
            return true;
        if (/\b(i('ll| will) have (someone|nicholas|nick|a human))\b/i.test(t))
            return true;
        return false;
    }
    /** VERA_DEMO_SHOP_NAMETRUTH_20260905 — booked-claim detector (shared abort + rewrite). */
    demoShopSpeakClaimsBooked(text) {
        // VERA_DEMO_SHOP_NAMETRUTH_20260905 + VERA_DEMO_SHOP_CONVOFEEL_20260906
        return /\b(i('ve| have) booked|i('ll| will) book|let me book|i('ll| will) (go ahead and )?schedule|schedule your demo|you'll receive a confirmation|your (demo|appointment|booking) is booked|booked (you|your)|you're all set|locked in|i('ve| have) got you down|got you down|penciled (you )?in)\b/i.test(String(text || ''));
    }
    /**
     * VERA_DEMO_SHOP_SLOTHEAR_20260907
     * US 10-digit phone from one utterance. Never stitch 9+5 across finals.
     * Strip spoken clocks so "1230 p.m." is not a phone.
     */
    extractDemoShopPhone(text) {
        const raw = String(text || '');
        if (!raw)
            return null;
        const noClock = raw
            .replace(/\b\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)\b/gi, ' ')
            .replace(/\b\d{3,4}\s*(?:a\.?m\.?|p\.?m\.?)\b/gi, ' ')
            .replace(/\b(?:january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{1,2}(?:st|nd|rd|th)?\b/gi, ' ');
        const tokens = noClock.split(/\s+/).filter(Boolean);
        for (const tok of tokens) {
            const d = tok.replace(/\D/g, '');
            if (d.length === 10)
                return d;
            if (d.length === 11 && d.charAt(0) === '1')
                return d.slice(1);
        }
        let acc = '';
        for (const tok of tokens) {
            const d = tok.replace(/\D/g, '');
            if (d.length >= 3 && d.length <= 4 && /^\d+$/.test(d)) {
                acc += d;
                if (acc.length === 10)
                    return acc;
                if (acc.length > 10)
                    acc = d;
            }
            else {
                acc = '';
            }
        }
        return null;
    }
    /**
     * VERA_DEMO_SHOP_DTMF_20260907
     * Telnyx call.dtmf.received — accumulate until 10 digits. First keypress does not
     * merge with spoken fragments. * clears. Spoken 10-digit still wins if it lands first.
     */
    async onDemoShopDtmf(rawDigit) {
        if (this.tenantId !== 'demo-shop' || !this.active || this.state === 'ENDED')
            return;
        const spokenAlready = this.extractDemoShopPhone((this.conversationHistory || [])
            .filter((t) => t && t.role === 'user')
            .map((t) => String(t.content || ''))
            .join('\n'));
        const next = (0, demoShopDtmf_1.ingestDemoShopDtmfDigit)({
            buffer: this.demoShopDtmfBuffer,
            phone: this.demoShopDtmfPhone,
            alreadyHasPhone: !!(this.demoShopDtmfPhone || spokenAlready),
        }, rawDigit);
        this.demoShopDtmfBuffer = next.buffer;
        if (next.action === 'ignore')
            return;
        this.demoShopAwaitingContact = true;
        this.syncDemoShopContactMaxUtt('what is the best phone number to reach you');
        log_1.log.info({
            event: 'demo_shop_dtmf',
            marker: 'VERA_DEMO_SHOP_DTMF_20260907',
            action: next.action,
            buffer_len: (next.buffer || '').length,
            ...this.logContext,
        }, 'demo shop keypad digit');
        if (next.action === 'clear') {
            this.demoShopDtmfPhone = null;
            return;
        }
        if (next.action !== 'complete' || !next.phone)
            return;
        this.demoShopDtmfPhone = next.phone;
        this.demoShopAwaitingContact = false;
        this.appendHistory({
            role: 'user',
            content: next.phone,
            timestamp: new Date(),
        });
        this.invalidateTranscriptHandling();
        try {
            await this.stopPlayback();
        }
        catch (error) {
            log_1.log.warn({
                err: serializeCaughtError(error),
                event: 'demo_shop_dtmf_stop_failed',
                ...this.logContext,
            }, 'demo shop DTMF stopPlayback failed');
        }
        const booking = this.normalizeDemoShopBooking(this.conversationHistory);
        const ack = booking.hasName
            ? 'Got those ten digits.'
            : "Got those ten digits. What's the name for the booking?";
        this.appendHistory({ role: 'assistant', content: ack, timestamp: new Date() });
        await this.playAssistantTurn(ack);
        void this.maybeDemoShopMidCallBook(ack);
    }
    demoShopNameParticle(word) {
        return /^(de|da|van|von|der|la|le|del|della|di|du|st|saint)$/i.test(String(word || ''));
    }
    /**
     * VERA_DEMO_SHOP_SLOTHEAR_20260907
     * "can we use Nick De Santis and September 8th" — keep particle last names.
     */
    takeDemoShopSpokenNameFromText(userText) {
        const text = String(userText || '').replace(/[\u2018\u2019\u201A\u201B\u2032\u2035\u02BC]/g, "'");
        if (!text)
            return null;
        const stop = /^(i|im|i'm|its|it's|this|that|yes|yeah|yep|yup|no|nope|ok|okay|sure|thanks|thank|please|hello|hi|hey|my|the|a|an|and|or|to|for|at|on|in|of|we|you|me|us|here|there|today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|am|pm|hoping|calling|trying|looking|interested|going|gonna|wanting|just|ooh|oh|um|uh|can|we|use|soon|well|demo|appointment|booking|call|phone|email|september|october|november|december|january|february|march|april|may|june|july|august)$/i;
        const months = /^(january|february|march|april|may|june|july|august|september|october|november|december)$/i;
        const weekdays = /^(monday|tuesday|wednesday|thursday|friday|saturday|sunday)$/i;
        const isNameToken = (token) => /^[A-Za-z]{2,20}(?:-[A-Za-z]{2,20})?$/.test(token);
        const filterParts = (raw) => {
            const parts = String(raw || '').trim().split(/[ \t]+/).filter((p) => {
                if (!p)
                    return false;
                if (this.demoShopNameParticle(p))
                    return true;
                return isNameToken(p) && !stop.test(p);
            });
            while (parts.length && this.demoShopNameParticle(parts[parts.length - 1]))
                parts.pop();
            return parts.length ? parts.join(' ') : null;
        };
        const cueRe = /\b(?:my\s+name\s+is|name\s+is|name's|this\s+is|use|under|as)\s+/ig;
        let cue;
        while ((cue = cueRe.exec(text))) {
            const rest = text.slice(cue.index + cue[0].length);
            const words = rest.split(/\s+/);
            const taken = [];
            for (let i = 0; i < words.length; i++) {
                const clean = String(words[i] || '').replace(/^[^A-Za-z]+|[^A-Za-z'-]+$/g, '');
                if (!clean)
                    continue;
                if (/^\d/.test(clean))
                    break;
                if (/^(and|on|at|for|this|tomorrow|today|next)$/i.test(clean))
                    break;
                if (months.test(clean) || weekdays.test(clean))
                    break;
                if (this.demoShopNameParticle(clean)) {
                    taken.push(clean);
                    continue;
                }
                if (!isNameToken(clean) || stop.test(clean))
                    break;
                taken.push(clean);
                const cores = taken.filter((t) => !this.demoShopNameParticle(t)).length;
                if (cores >= 3)
                    break;
            }
            while (taken.length && this.demoShopNameParticle(taken[taken.length - 1]))
                taken.pop();
            if (taken.length)
                return taken.join(' ');
        }
        const beforeDate = /\b((?:[A-Za-z]{2,20}(?:-[A-Za-z]{2,20})?[ \t]+){0,3}[A-Za-z]{2,20}(?:-[A-Za-z]{2,20})?)\s+(?:and|on)\s+(?:january|february|march|april|may|june|july|august|september|october|november|december|\d{1,2})\b/i.exec(text);
        if (beforeDate)
            return filterParts(beforeDate[1]);
        return null;
    }
    /**
     * VERA_DEMO_SHOP_NAMETRUTH_20260905
     * First name alone ("My name is Nick") must extract. Previous /book regex required FIRST+LAST.
     */
    extractDemoShopCallerName(turns) {
        if (this.demoShopCollectedName)
            return this.demoShopCollectedName;
        const list = Array.isArray(turns) ? turns : (this.conversationHistory || []);
        const apostropheNorm = (s) => String(s || '').replace(/[\u2018\u2019\u201A\u201B\u2032\u2035\u02BC]/g, "'");
        const stop = /^(i|im|i'm|its|it's|this|that|yes|yeah|yep|yup|no|nope|ok|okay|sure|thanks|thank|please|hello|hi|hey|my|the|a|an|and|or|to|for|at|on|in|of|we|you|me|us|here|there|today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|am|pm|hoping|calling|trying|looking|interested|going|gonna|wanting|just|ooh|oh|um|uh|can|we|use|soon|well|demo|appointment|booking|call|phone|email|september|october|november|december|january|february|march|april|may|june|july|august)$/i;
        const userText = apostropheNorm(list.filter((t) => t && t.role === 'user').map((t) => String(t.content || '')).join('\n'));
        const fromCue = this.takeDemoShopSpokenNameFromText(userText);
        if (fromCue) {
            this.demoShopCollectedName = fromCue;
            return this.demoShopCollectedName;
        }
        const im = /\b(?:i'?m|it'?s)\s+([A-Za-z]{2,20}(?:[ \t]+[A-Za-z]{2,20})?)\b/i.exec(userText);
        if (im) {
            const kept = im[1].trim().split(/[ \t]+/).filter((p) => p && (!stop.test(p) || this.demoShopNameParticle(p)));
            if (kept.length && !kept.every((p) => this.demoShopNameParticle(p))) {
                this.demoShopCollectedName = kept.join(' ');
                return this.demoShopCollectedName;
            }
        }
        for (let i = 0; i < list.length; i++) {
            const turn = list[i];
            if (!turn || turn.role !== 'user')
                continue;
            const u = apostropheNorm(String(turn.content || '')).trim().replace(/[.!,?]+$/g, '');
            const tokens = u.split(/\s+/).map((w) => w.replace(/^[^\w]+|[^\w'-]+$/g, '')).filter(Boolean);
            const nameLike = tokens.length >= 1 && tokens.length <= 4 && tokens.every((t) => this.demoShopNameParticle(t) || (/^[A-Za-z]{2,20}(?:-[A-Za-z]{2,20})?$/.test(t) && !stop.test(t)));
            if (!nameLike)
                continue;
            for (let j = i - 1; j >= 0; j--) {
                const prev = list[j];
                if (!prev)
                    continue;
                if (prev.role === 'assistant' && /\b(name|who (am i|is this)|may i (get|have) your name)\b/i.test(String(prev.content || ''))) {
                    this.demoShopCollectedName = tokens.join(' ');
                    return this.demoShopCollectedName;
                }
                if (prev.role === 'user')
                    break;
            }
        }
        return null;
    }
    /** VERA_DEMO_SHOP_MUSTBOOK_20260905 — true if caller already gave a name this call. */
    demoShopHasCallerNameInHistory() {
        return !!this.extractDemoShopCallerName();
    }
    /**
     * VERA_DEMO_SHOP_PICKUP_HISTORY_20260906
     * Record the exact played pickup line as assistant turn 0 so the LLM continues mid-call.
     */
    recordPickupGreetingInHistory(greetingText) {
        if (this.tenantId !== 'demo-shop' || this.pickupGreetingRecorded)
            return;
        const text = String(greetingText || '').trim();
        if (!text)
            return;
        this.pickupGreetingRecorded = true;
        this.appendHistory({ role: 'assistant', content: text, timestamp: new Date() });
        log_1.log.info({
            event: 'demo_shop_pickup_history_injected',
            marker: 'VERA_DEMO_SHOP_PICKUP_HISTORY_20260906',
            greeting_len: text.length,
            greeting_preview: text.slice(0, 96),
            ...this.logContext,
        }, 'pickup greeting recorded as assistant turn 0');
    }
    /**
     * VERA_DEMO_SHOP_PICKUP_HISTORY_20260906 — light backup if the model still re-opens.
     * Strip Hi there / thanks-for-calling / My name's Sarah after pickup is already spoken.
     */
    maybeRewriteDemoShopPickupReopen(text) {
        if (this.tenantId !== 'demo-shop' || !this.pickupGreetingRecorded || !text)
            return text;
        let next = String(text).trim();
        const before = next;
        // VERA_DEMO_SHOP_NONAMEHALLUC_20260907 — strip Hi + guessed name ("Hi Mo,") so we
        // never speak a leftover "Mo, thanks…". Trusted names still come from extract.
        next = next.replace(/^(hi there|hello there|hey there|hi|hello|hey)(?:\s+[A-Za-z]{2,20})?[\s,!.]*/i, '').trim();
        next = next.replace(/^(thanks|thank you) for (calling|reaching out)\b[\s,!.]*/i, '').trim();
        next = next.replace(/^(great|nice|good) to (meet|hear from) you\b[\s,!.]*/i, '').trim();
        next = next.replace(/^(my name('s| is)|this is)\s+[A-Za-z]{2,20}\b[\s,!.]*/i, '').trim();
        next = next.replace(/^i('m| am)\s+[A-Z][a-zA-Z]{1,19}\b[\s,!.]*/, '').trim();
        next = next.replace(/^how can i help you( today)?\b[\s,!.?]*/i, '').trim();
        if (next === before)
            return text;
        if (next)
            next = next.charAt(0).toUpperCase() + next.slice(1);
        log_1.log.info({
            event: 'demo_shop_pickup_reopen_stripped',
            marker: 'VERA_DEMO_SHOP_PICKUP_HISTORY_20260906',
            original_preview: before.slice(0, 80),
            spoken_preview: (next || '(dropped)').slice(0, 80),
            ...this.logContext,
        }, 'demo shop stripped post-pickup re-intro');
        return next;
    }
    /**
     * VERA_DEMO_SHOP_NO_REGREET_20260906
     * After the first successful Hi/Hello/Hey + name (or Great to meet you), strip those
     * turn openers before TTS. Name may still appear later in a booked-confirm sentence.
     */
    maybeRewriteDemoShopRegreet(text) {
        if (this.tenantId !== 'demo-shop' || !text)
            return text;
        text = this.maybeRewriteDemoShopPickupReopen(text);
        const name = this.extractDemoShopCallerName();
        if (!name)
            return text;
        const first = String(name).trim().split(/\s+/)[0];
        if (!first || first.length < 2)
            return text;
        const escaped = first.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const openerRe = new RegExp(`^(hi|hello|hey)\\s+${escaped}\\b[\\s,!.]*`, 'i');
        const meetRe = /^(great|nice|good)\s+to\s+meet\s+you\b[\s,!.]*/i;
        const raw = String(text).trim();
        if (!this.demoShopNameAcked) {
            const hist = this.conversationHistory || [];
            const histRe = new RegExp(`^(hi|hello|hey)\\s+${escaped}\\b`, 'i');
            for (const turn of hist) {
                if (turn && turn.role === 'assistant' && histRe.test(String(turn.content || '').trim())) {
                    this.demoShopNameAcked = true;
                    break;
                }
            }
        }
        const isOpener = openerRe.test(raw);
        const isMeet = meetRe.test(raw);
        if (!this.demoShopNameAcked) {
            if (isOpener || isMeet)
                this.demoShopNameAcked = true;
            return text;
        }
        let next = raw;
        if (openerRe.test(next))
            next = next.replace(openerRe, '').trim();
        if (meetRe.test(next))
            next = next.replace(meetRe, '').trim();
        if (next === raw)
            return text;
        if (!next)
            next = 'What day and time work for you?';
        else
            next = next.charAt(0).toUpperCase() + next.slice(1);
        log_1.log.info({
            event: 'demo_shop_regreet_stripped',
            marker: 'VERA_DEMO_SHOP_NO_REGREET_20260906',
            name_first: first,
            original_preview: raw.slice(0, 80),
            spoken_preview: next.slice(0, 80),
            ...this.logContext,
        }, 'demo shop stripped repeated Hi+Name opener');
        return next;
    }
    /** VERA_DEMO_SHOP_BARGE_SUSTAIN_20260906 — real booking/contact/confirm content after a barge. */
    looksLikeDemoShopCompleteUtterance(text) {
        const t = String(text || '').trim();
        if (!t)
            return false;
        if (/\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b.{0,24}\b(\d{1,2}|noon|midnight)\b/i.test(t))
            return true;
        if (/\b\d{1,2}(?::\d{2})?\s*(a\.?m\.?|p\.?m\.?)\b/i.test(t))
            return true;
        if (/\b(my name is|this is|name is)\b/i.test(t))
            return true;
        if (/\d{7,}/.test(t) || /@/.test(t))
            return true;
        if (/^(yes|yeah|yep|yup|correct|that's right|that is right|no|nope|not really)\b/i.test(t))
            return true;
        return false;
    }
    /** VERA_DEMO_SHOP_BARGE_SUSTAIN_20260906 — abort fragments after a blip must not spawn a new reply. */
    shouldDiscardDemoShopBargeBlip(text) {
        if (this.tenantId !== 'demo-shop' || !this.demoShopLastBargeAtMs)
            return false;
        const since = Date.now() - this.demoShopLastBargeAtMs;
        if (since > 1800)
            return false;
        const t = String(text || '').trim();
        if (!t)
            return true;
        if (this.looksLikeDemoShopCompleteUtterance(t))
            return false;
        const words = t.split(/\s+/).filter(Boolean);
        if (words.length <= 5 && since < 1600)
            return true;
        if (t.length < 24 && since < 1400)
            return true;
        return false;
    }
    /**
     * VERA_DEMO_SHOP_NAMETRUTH_20260905 — speak booked only after POST /book succeeds.
     */
    async finalizeDemoShopBookedSpeak(response) {
        if (this.tenantId !== 'demo-shop' || !response)
            return response;
        const text = String(response);
        const claimsBooked = this.demoShopSpeakClaimsBooked(text);
        const bookingNow = /\bi('m| am) booking\b/i.test(text);
        if (!claimsBooked && !bookingNow)
            return text;
        const booking = this.normalizeDemoShopBooking(this.conversationHistory);
        const dateSpeak = booking && booking.start ? this.formatDemoShopConfirmDateFromIso(booking.start) : null;
        const bookedLine = dateSpeak
            ? `You're booked for ${dateSpeak}. We look forward to speaking with you then.`
            : "You're booked. We look forward to speaking with you then.";
        if (this.demoShopMidCallBookPosted)
            return bookedLine;
        if (!booking || !booking.writable)
            return text;
        const ok = await this.maybeDemoShopMidCallBook(text);
        if (ok || this.demoShopMidCallBookPosted) {
            log_1.log.info({
                event: 'demo_shop_booked_speak_after_write',
                start: booking.start,
                name: booking.name || null,
                ...this.logContext,
            }, 'demo shop speaking booked only after write');
            return bookedLine;
        }
        log_1.log.warn({
            event: 'demo_shop_book_speak_write_failed',
            start: booking.start,
            name: booking.name || null,
            ...this.logContext,
        }, 'demo shop write failed — not speaking booked');
        return dateSpeak
            ? `I have your details for ${dateSpeak}. I wasn't able to lock that in just now. Please stay on the line or call back to confirm.`
            : "I have your details, but I wasn't able to lock that in just now. Please stay on the line or call back to confirm.";
    }
    /**
     * VERA_DEMO_SHOP_NAMETRUTH_20260905 / MUSTBOOK — after name, ask day/time not "what demo".
     */
    maybeRewriteDemoShopNeedDatetime(response) {
        if (this.tenantId !== 'demo-shop' || !response)
            return response;
        const text = String(response);
        const booking = this.normalizeDemoShopBooking(this.conversationHistory);
        if (booking && booking.start)
            return text;
        if (!this.demoShopHasCallerNameInHistory())
            return text;
        if (/\b(what day|what time|day and time|when works|what time would)\b/i.test(text))
            return text;
        if (!/\b(what (would you like to|do you (want to|want)|are you (hoping|looking) to) (demo|see|tour)|what (demo|technology|product)|which (demo|product|technology))\b/i.test(text))
            return text;
        log_1.log.info({
            event: 'demo_shop_need_datetime_rewritten',
            original_preview: text.slice(0, 120),
            ...this.logContext,
        }, 'demo shop rewrote product-ask to day/time after name');
        return 'Nice to meet you — when works for you, morning or afternoon?';
    }
    /**
     * VERA_DEMO_SHOP_MUSTBOOK_20260905 — rewrite handoff/callback speak to on-call day/time ask.
     */
    maybeRewriteDemoShopHandoff(response) {
        if (this.tenantId !== 'demo-shop' || !response)
            return response;
        const transfersOn = this.fullTenantConfig?.usageLimits?.features?.multiLocation !== false
            && (this.transferProfiles?.length || 0) > 0;
        if (transfersOn)
            return response;
        const text = String(response);
        const recentUser = (this.conversationHistory || [])
            .filter((t) => t && t.role === 'user')
            .map((t) => String(t.content || ''))
            .slice(-2)
            .join(' ');
        // Emergency page is an explicit exception to MUSTBOOK "never hand off".
        if (/\b(gas|flood|no heat|carbon monoxide|burst pipe|sewage|electrical fire|sparking)\b/i.test(recentUser))
            return text;
        if (/\b(paging|on-call technician|stay on the line|creating an urgent task)\b/i.test(text))
            return text;
        if (!this.isDemoShopHandoffSpeak(text))
            return text;
        const hasName = this.demoShopHasCallerNameInHistory();
        const rewritten = hasName
            ? 'I can book that now — what day and time work?'
            : 'Sure — may I get your name first?';
        log_1.log.info({
            event: 'demo_shop_handoff_rewritten',
            had_name: hasName,
            original_preview: text.slice(0, 120),
            ...this.logContext,
        }, 'demo shop rewrote handoff/follow-up to on-call booking ask');
        return rewritten;
    }
    /**
     * VERA_DEMO_SHOP_DATECONFIRM_20260905
     * Absolute PT ISO → concrete speak: "Monday, September 8th at 2 PM"
     * (12-hour, no leading zero; ordinal st/nd/rd/th). America/Los_Angeles wall from ISO fields.
     */
    formatDemoShopConfirmDateFromIso(iso) {
        if (!iso || typeof iso !== 'string')
            return null;
        const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(String(iso).trim());
        if (!m)
            return null;
        const year = parseInt(m[1], 10);
        const monthIndex = parseInt(m[2], 10) - 1;
        const day = parseInt(m[3], 10);
        const hour = parseInt(m[4], 10);
        const minute = parseInt(m[5], 10);
        if (!(monthIndex >= 0 && monthIndex <= 11) || !(day >= 1 && day <= 31) || Number.isNaN(hour) || Number.isNaN(minute))
            return null;
        const weekdays = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
        const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
        const dow = new Date(Date.UTC(year, monthIndex, day)).getUTCDay();
        const ordinal = (n) => {
            const mod100 = n % 100;
            if (mod100 >= 11 && mod100 <= 13)
                return `${n}th`;
            switch (n % 10) {
                case 1: return `${n}st`;
                case 2: return `${n}nd`;
                case 3: return `${n}rd`;
                default: return `${n}th`;
            }
        };
        const ampm = hour >= 12 ? 'PM' : 'AM';
        let h12 = hour % 12;
        if (h12 === 0)
            h12 = 12;
        const timePart = minute === 0 ? `${h12} ${ampm}` : `${h12}:${String(minute).padStart(2, '0')} ${ampm}`;
        return `${weekdays[dow]}, ${months[monthIndex]} ${ordinal(day)} at ${timePart}`;
    }
    /**
     * VERA_DEMO_SHOP_DATECONFIRM_20260905
     * Deterministic confirm rewrite: weekday-only / clock-only slot confirms → concrete PT calendar date.
     * Uses normalizeDemoShopBooking resolved start; never invents without a PT ISO.
     */
    maybeRewriteDemoShopDateConfirm(speakText) {
        if (this.tenantId !== 'demo-shop' || !speakText)
            return speakText;
        const text = String(speakText);
        // Already concrete month + day
        if (/\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{1,2}(?:st|nd|rd|th)?\b/i.test(text))
            return text;
        const hasWeekday = /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i.test(text);
        const hasClock = /\b(?:at\s+)?(?:noon|midnight|\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?))\b/i.test(text);
        const looksConfirm = /\b(booked|confirmed|confirm|locked\s+in|all\s+set|got\s+you(?:\s+down)?|scheduled|sound\s+good|work\s+for\s+you|does\s+that\s+work|that\s+work|i('ll| will)\s+book|i('ve| have)\s+(got|booked)|see\s+you\s+(on|at)|for\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday))\b/i.test(text)
            || (hasWeekday && hasClock);
        if (!looksConfirm || !(hasWeekday || hasClock))
            return text;
        // Do not rewrite business-hours dumps
        if (/\b(open|hours|monday\s+through|mon(?:day)?\s*[-–—]\s*fri)/i.test(text) && !/\b(booked|confirmed|locked|scheduled|got\s+you|all\s+set)\b/i.test(text))
            return text;
        const booking = this.normalizeDemoShopBooking(this.conversationHistory);
        if (!booking || !booking.start || !this.isDemoShopResolvedPtStart(booking.start))
            return text;
        const concrete = this.formatDemoShopConfirmDateFromIso(booking.start);
        if (!concrete)
            return text;
        let out = text;
        const wdTimeRe = /\b(?:this\s+(?:coming\s+)?)?(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b(?:\s*,?\s*(?:at\s+)?(?:noon|midnight|\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)|\d{1,2}:\d{2}))?/i;
        if (wdTimeRe.test(out)) {
            out = out.replace(wdTimeRe, concrete);
        }
        else {
            const atOnly = /\b(?:for\s+)?(?:at\s+)?\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)\b/i;
            if (atOnly.test(out)) {
                out = out.replace(atOnly, concrete);
            }
            else {
                out = out.replace(/\b(booked|confirmed|locked\s+in|scheduled)(\s+for)?\b/i, (m0, verb, forPart) => `${verb}${forPart || ' for'} ${concrete}`);
            }
        }
        // Drop a leftover clock that the weekday regex did not consume (v3:fJJo "at 12:30 PM at 12:30").
        if (out !== text && out.includes(concrete)) {
            const parts = out.split(concrete);
            const tail = parts.slice(1).join(concrete);
            const strippedTail = tail.replace(/^\s*(?:at\s+)?(?:noon|midnight|\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)?)/i, '');
            out = parts[0] + concrete + strippedTail;
        }
        if (out === text)
            return text;
        log_1.log.info({
            event: 'demo_shop_dateconfirm_rewritten',
            start: booking.start,
            concrete,
            original_preview: text.slice(0, 120),
            ...this.logContext,
        }, 'demo shop injected concrete PT calendar date into confirm speak');
        return out;
    }


    /** VERA_DEMO_SHOP_TURN_20260905 — absolute start must carry America/Los_Angeles offset. */
    isDemoShopResolvedPtStart(start) {
        if (!start || typeof start !== 'string')
            return false;
        const s = start.trim();
        if (!s)
            return false;
        // Reject bare UTC Z / +00:00 invents from helper defaults
        if (/Z$/i.test(s) || /\+00:00$/.test(s))
            return false;
        if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s))
            return false;
        // Must include real minutes from speech (allow :00) but require PT offset
        if (s.includes('-07:00') || s.includes('-08:00') || /America\/Los_Angeles/i.test(s))
            return true;
        return false;
    }
    /**
     * VERA_DEMO_SHOP_TURN_20260905 — Whisper garbage / non-booking nonsense before LLM.
     * Early turns only: do not invent products from STT noise like "spiritual demo".
     */
    isDemoShopNonsenseTranscript(text) {
        const raw = String(text || '').trim();
        if (!raw)
            return false;
        const userTurns = (this.conversationHistory || []).filter((t) => t.role === 'user').length;
        // Gate first ~3 user turns (before history append this turn is not counted yet in some paths;
        // call site appends user first, so userTurns includes current).
        if (userTurns > 3)
            return false;
        const t = raw.toLowerCase().replace(/[.!,?]+/g, ' ').replace(/\s+/g, ' ').trim();
        const bannedHallucinations = /\b(spiritual|spa|massage|yoga|tarot|psychic|reiki|chakra|crystal)\b/i;
        const bookingLike = /\b(book|booking|demo|appointment|schedule|tomorrow|today|monday|tuesday|wednesday|thursday|friday|saturday|sunday|am|pm|a\.m\.|p\.m\.|o'?clock|phone|email|name|my name|call(?:ing)? about)\b/i;
        const timeLike = /\b(\d{1,2}(:\d{2})?\s*(a\.?m\.?|p\.?m\.?)?|\d{1,2}\s*o'?clock)\b/i;
        const nameLike = /\b(my name is|this is|i'?m)\s+[a-z]{2,}/i;
        const phoneLike = /\d{3}.*\d{4}/;
        const yesNo = /^(yes|yeah|yep|yup|no|nope|correct|right|okay|ok|sure|thanks?|thank you)(\s+.*)?$/i;
        if (bannedHallucinations.test(t) && !bookingLike.test(t.replace(bannedHallucinations, ' '))) {
            return true;
        }
        if (bannedHallucinations.test(t))
            return true;
        if (bookingLike.test(t) || timeLike.test(t) || nameLike.test(t) || phoneLike.test(t) || yesNo.test(t))
            return false;
        // Short non-booking gibberish / unrelated noun salad
        const words = t.split(' ').filter(Boolean);
        if (words.length <= 8 && !bookingLike.test(t)) {
            // e.g. "One of the spiritual demo" already caught; also "blue widget please"
            const hasFunctionWords = /\b(the|a|an|of|to|for|and|or|is|are|be|want|need|like|please|calling|about)\b/.test(t);
            const hasContentNoun = words.some((w) => w.length >= 5);
            if (hasFunctionWords && hasContentNoun && !/\b(demo|book|appointment|schedule|time|day|name|phone|number|email)\b/.test(t))
                return true;
        }
        return false;
    }
    /** VERA_DEMO_SHOP_TURN_20260905 — rewrite LLM invents of unknown products before TTS. */
    maybeRewriteDemoShopInventedProduct(response) {
        if (this.tenantId !== 'demo-shop' || !response)
            return response;
        const text = String(response);
        const hist = (this.conversationHistory || []).map((t) => String(t.content || '')).join('\n').toLowerCase();
        const allow = /\b(demo|appointment|booking|book|schedule)\b/i;
        const inventRe = /\b(spiritual|spa|massage|yoga|tarot|psychic|reiki|chakra|crystal)\s+(demo|appointment|session|package|service)?\b/i;
        const m = inventRe.exec(text);
        if (!m)
            return text;
        // If caller actually said it, still rewrite — Demo Shop has no such product
        if (!allow.test(hist) && !allow.test(text)) {
            /* still rewrite */
        }
        log_1.log.info({
            event: 'demo_shop_invented_product_rewritten',
            invented: m[0],
            ...this.logContext,
        }, 'demo shop rewrote invented product to booking ask');
        return "Sorry — I didn't catch that. Are you calling to book a demo?";
    }
    /** VERA_DEMO_SHOP_TURN_20260905 — truncate at sentence boundary within maxChars. */
    truncateDemoShopReply(text, maxChars) {
        const s = String(text || '').trim();
        if (!s)
            return '';
        if (s.length <= maxChars)
            return s;
        const slice = s.slice(0, maxChars);
        const boundary = this.findSentenceBoundary(slice);
        if (boundary !== null && boundary >= Math.min(40, Math.floor(maxChars * 0.4)))
            return slice.slice(0, boundary).trim();
        const lastSpace = slice.lastIndexOf(' ');
        if (lastSpace >= Math.floor(maxChars * 0.5))
            return slice.slice(0, lastSpace).trim();
        return slice.trim();
    }

    findSentenceBoundary(text) {
        // Skip periods that belong to a.m. / p.m. so stream chunks don't split "2 p" | "m."
        const re = /[.!?](?=\s|$)/g;
        let match;
        while ((match = re.exec(text)) !== null) {
            if (match[0] === '.') {
                const win = text.slice(Math.max(0, match.index - 4), match.index + 4).toLowerCase();
                if (/[ap]\.?\s*m/.test(win) || /[ap]\.$/.test(text.slice(Math.max(0, match.index - 1), match.index + 1))) {
                    // more precise: period is the one in a. / p. or in m.
                    const i = match.index;
                    const two = text.slice(Math.max(0, i - 1), i + 2).toLowerCase();
                    if (two === 'a.' || two === 'p.' || two.startsWith('.m'))
                        continue;
                }
            }
            return match.index + 1;
        }
        return null;
    }
    selectSegmentEnd(text, targetChars) {
        if (text.length <= targetChars) {
            return text.length;
        }
        const slice = text.slice(0, targetChars);
        const lastSpace = slice.lastIndexOf(' ');
        if (lastSpace >= Math.floor(targetChars * 0.6)) {
            return lastSpace;
        }
        return targetChars;
    }
    nextTurnId() {
        this.turnSequence += 1;
        return this.turnSequence;
    }
    shouldSkipTelnyxAction(action) {
        if (this.transport.mode !== 'pstn') {
            return false;
        }
        if (this.active) {
            return false;
        }
        // Allow playback_start when we're trying to play a response to a late-final transcript.
        if (this.isRespondingToLateFinal && action === 'playback_start') {
            return false;
        }
        const event = action === 'playback_stop' ? 'playback_stop_skipped' : 'telnyx_action_skipped_inactive';
        log_1.log.warn({ event, action, ...this.logContext }, 'skipping telnyx action - call inactive');
        return true;
    }
}
exports.CallSession = CallSession;
//# sourceMappingURL=callSession.js.map