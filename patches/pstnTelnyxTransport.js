"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.PstnTelnyxTransportSession = void 0;
const promises_1 = __importDefault(require("fs/promises"));
const crypto_1 = require("crypto");
const env_1 = require("../env");
const log_1 = require("../log");
const telnyxClient_1 = require("../telnyx/telnyxClient");
const mediaStreamUrl_1 = require("../telnyx/mediaStreamUrl");
const streamStartGuard_1 = require("../telnyx/streamStartGuard");
const mediaWsBridge_1 = require("../media/mediaWsBridge");
const bidirectionalRtp_1 = require("../media/bidirectionalRtp");
class PstnAudioIngest {
    start() {
        // no-op: Telnyx media WS drives ingest
    }
    stop() {
        // no-op
    }
    onFrame(cb) {
        this.onFrameCb = cb;
    }
    pushFrame(frame) {
        this.onFrameCb?.(frame);
    }
}
class PstnAudioPlayback {
    constructor(options) {
        this.playbackEndCallbacks = [];
        this.telnyx = options.telnyx;
        this.callControlId = options.callControlId;
        this.logContext = options.logContext;
        this.isActive = options.isActive;
        this.allowPlaybackWhenInactive = options.allowPlaybackWhenInactive;
    }
    onPlaybackEnd(cb) {
        this.playbackEndCallbacks.push(cb);
    }
    notifyPlaybackEnded() {
        for (const cb of this.playbackEndCallbacks) {
            try {
                cb();
            }
            catch (error) {
                log_1.log.warn({ err: error, ...this.logContext }, 'playback end callback failed');
            }
        }
    }
    async play(input) {
        if (this.shouldSkipTelnyxAction('playback_start')) {
            return;
        }
        if (input.kind !== 'url') {
            log_1.log.warn({ event: 'playback_buffer_unsupported', ...this.logContext }, 'pstn playback expects url');
            return;
        }
        const connected = await (0, mediaWsBridge_1.waitForMediaWs)(this.callControlId, 2500);
        if (connected) {
            try {
                const localPath = (0, bidirectionalRtp_1.localWavPathFromPublicUrl)(input.url);
                if (!localPath) {
                    throw new Error('l16_tts_url_unreadable');
                }
                const wav = await promises_1.default.readFile(localPath);
                const pcm = (0, bidirectionalRtp_1.wavToL16Pcm16k)(wav);
                const markName = `tts-${(0, crypto_1.randomUUID)()}`;
                const sentMedia = (0, mediaWsBridge_1.sendMediaWsJson)(this.callControlId, (0, bidirectionalRtp_1.buildRtpMediaEvent)(pcm));
                const sentMark = sentMedia && (0, mediaWsBridge_1.sendMediaWsJson)(this.callControlId, (0, bidirectionalRtp_1.buildRtpMarkEvent)(markName));
                if (sentMedia && sentMark) {
                    log_1.log.info({
                        event: 'tts_rtp_l16_sent',
                        stream_codec: 'L16',
                        sample_rate_hz: 16000,
                        pcm_bytes: pcm.length,
                        duration_ms: Math.round((pcm.length / 2 / 16000) * 1000),
                        mark_name: markName,
                        audio_url: input.url,
                        ...this.logContext,
                    }, 'TTS sent as L16 16 kHz RTP on Telnyx media WebSocket');
                    return;
                }
                log_1.log.warn({
                    event: 'tts_rtp_ws_send_failed_using_playback_start',
                    audio_url: input.url,
                    ...this.logContext,
                }, 'L16 RTP send failed; using Telnyx playback_start');
            }
            catch (error) {
                log_1.log.warn({
                    event: 'tts_rtp_encode_failed_using_playback_start',
                    err: error,
                    audio_url: input.url,
                    ...this.logContext,
                }, 'L16 RTP encode failed; using Telnyx playback_start');
            }
        }
        else {
            log_1.log.warn({
                event: 'tts_rtp_ws_unavailable_using_playback_start',
                audio_url: input.url,
                ...this.logContext,
            }, 'media WebSocket not ready; using Telnyx playback_start');
        }
        await this.telnyx.playAudio(this.callControlId, input.url);
    }
    async stop() {
        (0, mediaWsBridge_1.sendMediaWsJson)(this.callControlId, (0, bidirectionalRtp_1.buildRtpClearEvent)());
        if (this.shouldSkipTelnyxAction('playback_stop')) {
            return;
        }
        await this.telnyx.stopPlayback(this.callControlId);
    }
    shouldSkipTelnyxAction(action) {
        if (!this.isActive || this.isActive()) {
            return false;
        }
        if (action === 'playback_start' && this.allowPlaybackWhenInactive?.()) {
            return false;
        }
        const event = action === 'playback_stop' ? 'playback_stop_skipped' : 'telnyx_action_skipped_inactive';
        log_1.log.warn({ event, action, ...this.logContext }, 'skipping telnyx action - call inactive');
        return true;
    }
}
class PstnTelnyxTransportSession {
    constructor(options) {
        this.mode = 'pstn';
        this.audioInput = {
            codec: 'pcm16le',
            sampleRateHz: env_1.env.TELNYX_TARGET_SAMPLE_RATE, // import env here
        };
        this._answered = false;
        this.id = options.callControlId;
        this.logContext = {
            call_control_id: options.callControlId,
            tenant_id: options.tenantId,
            requestId: options.requestId,
        };
        this.isActive = options.isActive;
        this.allowPlaybackWhenInactive = options.allowPlaybackWhenInactive;
        this._answered = Boolean(options.alreadyAnswered);
        this.telnyx = new telnyxClient_1.TelnyxClient(this.logContext);
        this.ingest = new PstnAudioIngest();
        this.playback = new PstnAudioPlayback({
            telnyx: this.telnyx,
            callControlId: options.callControlId,
            logContext: this.logContext,
            isActive: this.isActive,
            allowPlaybackWhenInactive: this.allowPlaybackWhenInactive,
        });
    }
    async start() {
        if (this._answered) {
            return;
        }
        if (this.shouldSkipTelnyxAction('answer')) {
            return;
        }
        await this.telnyx.answerCall(this.id);
        this._answered = true;
        if ((0, streamStartGuard_1.claimStreamingStart)(this.id)) {
            try {
                await this.telnyx.startStreaming(this.id, (0, mediaStreamUrl_1.buildMediaStreamUrl)(this.id));
            }
            catch (error) {
                (0, streamStartGuard_1.releaseStreamingStart)(this.id);
                log_1.log.warn({ err: error, event: 'telnyx_streaming_start_after_answer_failed', ...this.logContext }, 'streaming start after answer failed');
            }
        }
    }
    async stop(reason) {
        if (this.shouldSkipTelnyxAction('hangup')) {
            return;
        }
        try {
            log_1.log.info({
                event: 'telnyx_hangup_requested',
                reason: reason ?? 'unspecified',
                ...this.logContext,
            }, 'telnyx hangup requested (transport.stop)');
            await this.telnyx.hangupCall(this.id);
        }
        catch (error) {
            log_1.log.error({ err: error, reason, ...this.logContext }, 'telnyx hangup failed');
        }
    }
    async transfer(to, options) {
        if (this.shouldSkipTelnyxAction('transfer')) {
            return;
        }
        await this.telnyx.transferCall(this.id, to, {
            from: options?.from,
            timeoutSecs: options?.timeoutSecs,
            audioUrl: options?.audioUrl,
            targetLegClientState: options?.targetLegClientState,
            commandId: options?.commandId,
        });
    }
    pushFrame(frame) {
        this.ingest.pushFrame(frame);
    }
    notifyPlaybackEnded() {
        this.playback.notifyPlaybackEnded();
    }
    shouldSkipTelnyxAction(action) {
        if (!this.isActive || this.isActive()) {
            return false;
        }
        const event = action === 'playback_stop' ? 'playback_stop_skipped' : 'telnyx_action_skipped_inactive';
        log_1.log.warn({ event, action, ...this.logContext }, 'skipping telnyx action - call inactive');
        return true;
    }
}
exports.PstnTelnyxTransportSession = PstnTelnyxTransportSession;
//# sourceMappingURL=pstnTelnyxTransport.js.map