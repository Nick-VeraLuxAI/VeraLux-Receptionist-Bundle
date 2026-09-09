"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createTelnyxWebhookRouter = createTelnyxWebhookRouter;
const express_1 = require("express");
const env_1 = require("../env");
const capacity_1 = require("../limits/capacity");
const tenantUsage_1 = require("../limits/tenantUsage");
const log_1 = require("../log");
const wavInfo_1 = require("../audio/wavInfo");
const playbackPipeline_1 = require("../audio/playbackPipeline");
const audioProbe_1 = require("../diagnostics/audioProbe");
const metrics_1 = require("../metrics");
const metrics_2 = require("../metrics");
const audioStore_1 = require("../storage/audioStore");
const tenantResolver_1 = require("../tenants/tenantResolver");
const tenantConfig_1 = require("../tenants/tenantConfig");
const telnyxClient_1 = require("../telnyx/telnyxClient");
const mediaStreamUrl_1 = require("../telnyx/mediaStreamUrl");
const streamStartGuard_1 = require("../telnyx/streamStartGuard");
const telnyxVerify_1 = require("../telnyx/telnyxVerify");
const webhookReplayGuard_1 = require("../telnyx/webhookReplayGuard");
const tts_1 = require("../tts");
const tenantCredentials_1 = require("../telnyx/tenantCredentials");
const controlPlane_1 = require("../controlPlane");
function logTtsBytesReady(context, id, audio, contentType, source = 'kokoro') {
    const header = (0, wavInfo_1.describeWavHeader)(audio);
    log_1.log.info({
        event: 'tts_bytes_ready',
        id,
        bytes: audio.length,
        riff: header.riff,
        wave: header.wave,
        ...context,
    }, 'tts bytes ready');
    if (!header.riff || !header.wave) {
        log_1.log.warn({
            event: 'tts_non_wav_warning',
            id,
            content_type: contentType,
            first16_hex: header.first16Hex,
            bytes: audio.length,
            ...context,
        }, 'tts bytes are not wav');
    }
    const audioLogContext = { ...context, tts_id: id };
    const baseMeta = {
        callId: typeof context.call_control_id === 'string' ? context.call_control_id : undefined,
        tenantId: typeof context.tenant_id === 'string' ? context.tenant_id : undefined,
        format: 'wav',
        logContext: audioLogContext,
        lineage: ['tts:output'],
        kind: id,
    };
    (0, audioProbe_1.attachAudioMeta)(audio, baseMeta);
    (0, audioProbe_1.probeWav)('tts.out.raw', audio, baseMeta);
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
            ...context,
        }, 'wav info');
    }
    catch (error) {
        const reason = error instanceof Error ? error.message : 'unknown_error';
        log_1.log.warn({
            event: 'wav_info_parse_failed',
            source,
            id,
            reason,
            ...context,
        }, 'wav info parse failed');
    }
}
function createTelnyxWebhookRouter(sessionManager) {
    const router = (0, express_1.Router)();
    const streamingStarted = new Set();
    const recordingEnabledCalls = new Set();
    const recordingStartedCalls = new Set();
    const recordingTenantByCall = new Map();
    const drillSpokenCalls = new Set();
    const tenantDebugEnabled = () => {
        const value = process.env.TENANT_DEBUG;
        if (!value) {
            return false;
        }
        const normalized = value.trim().toLowerCase();
        return normalized === '1' || normalized === 'true' || normalized === 'yes';
    };
    const mediaDebugEnabled = () => {
        const value = process.env.MEDIA_DEBUG;
        if (!value) {
            return false;
        }
        const normalized = value.trim().toLowerCase();
        return normalized === '1' || normalized === 'true' || normalized === 'yes';
    };
    async function startStreamingOnce(callControlId, tenantId, requestId) {
        if (streamingStarted.has(callControlId)) {
            return;
        }
        if (!(0, streamStartGuard_1.claimStreamingStart)(callControlId)) {
            streamingStarted.add(callControlId);
            return;
        }
        const streamUrl = (0, mediaStreamUrl_1.buildMediaStreamUrl)(callControlId);
        if (mediaDebugEnabled()) {
            log_1.log.info({ event: 'streaming_start_requested', call_control_id: callControlId, stream_url: streamUrl, requestId }, 'streaming start requested');
        }
        const telnyx = new telnyxClient_1.TelnyxClient({
            call_control_id: callControlId,
            tenant_id: tenantId,
            requestId,
        });
        if (shouldSkipTelnyxAction('streaming_start', callControlId, tenantId, requestId)) {
            (0, streamStartGuard_1.releaseStreamingStart)(callControlId);
            return;
        }
        streamingStarted.add(callControlId);
        try {
            await telnyx.startStreaming(callControlId, streamUrl);
        }
        catch (error) {
            streamingStarted.delete(callControlId);
            (0, streamStartGuard_1.releaseStreamingStart)(callControlId);
            throw error;
        }
    }
    function determineAction(eventType, callControlId) {
        if (!eventType) {
            return 'ignored_unknown_event';
        }
        if (!callControlId) {
            return 'ignored_missing_call_control_id';
        }
        switch (eventType) {
            case 'call.initiated':
                return 'session_created';
            case 'call.answered':
                return 'session_answered';
            case 'call.bridged':
                return 'transfer_bridged';
            case 'call.playback.started':
                return 'playback_started';
            case 'call.playback.ended':
                return 'playback_ended';
            case 'call.dtmf.received':
                return 'dtmf_received';
            case 'streaming.stopped':
                return 'streaming_stopped';
            case 'call.recording.saved':
                return 'recording_saved';
            case 'call.recording.error':
                return 'recording_failed';
            case 'call.hangup':
            case 'call.ended':
                return 'session_torn_down';
            default:
                return 'ignored_unhandled_event';
        }
    }
    function getString(value) {
        return typeof value === 'string' && value.trim() !== '' ? value : undefined;
    }
    function decodeOncallTransferState(payload) {
        const raw = getString(payload?.client_state);
        if (!raw)
            return null;
        try {
            const parsed = JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
            if (parsed.kind !== 'veralux_oncall_transfer' ||
                typeof parsed.tenantId !== 'string' ||
                typeof parsed.callId !== 'string') {
                return null;
            }
            return {
                tenantId: parsed.tenantId,
                callId: parsed.callId,
                pageId: typeof parsed.pageId === 'string' ? parsed.pageId : undefined,
            };
        }
        catch {
            return null;
        }
    }
    function decodeOncallDrillState(payload) {
        const raw = getString(payload?.client_state);
        if (!raw)
            return null;
        try {
            const parsed = JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
            if (parsed.kind !== 'veralux_oncall_drill' ||
                typeof parsed.tenantId !== 'string' ||
                typeof parsed.drillId !== 'string' ||
                typeof parsed.startedAt !== 'number') {
                return null;
            }
            return {
                tenantId: parsed.tenantId,
                drillId: parsed.drillId,
                startedAt: parsed.startedAt,
            };
        }
        catch {
            return null;
        }
    }
    function getToNumber(payload) {
        if (!payload) {
            return undefined;
        }
        const raw = payload.to;
        if (typeof raw === 'string') {
            return getString(raw);
        }
        if (raw && typeof raw === 'object') {
            const phoneNumber = raw.phone_number;
            if (typeof phoneNumber === 'string') {
                return getString(phoneNumber);
            }
        }
        return undefined;
    }
    const capacityHoldInFlight = new Set();
    function sleepMs(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }
    async function playMessageAndHangup(options) {
        const context = {
            call_control_id: options.callControlId,
            tenant_id: options.tenantId,
            requestId: options.requestId,
        };
        const telnyx = new telnyxClient_1.TelnyxClient(context);
        try {
            if (!options.skipAnswer) {
                if (shouldSkipTelnyxAction('answer', options.callControlId, options.tenantId, options.requestId)) {
                    return;
                }
                await telnyx.answerCall(options.callControlId);
            }
            const ttsStart = Date.now();
            const ttsResult = await (0, tts_1.synthesizeSpeech)({
                text: options.message,
                voice: options.ttsConfig?.mode === 'qwen3_tts_http'
                    ? options.ttsConfig.speaker
                    : options.ttsConfig?.voice,
                format: options.ttsConfig?.format,
                sampleRate: options.ttsConfig?.sampleRate,
            }, options.ttsConfig);
            const ttsDuration = Date.now() - ttsStart;
            log_1.log.info({
                event: 'tts_synthesized',
                duration_ms: ttsDuration,
                audio_bytes: ttsResult.audio.length,
                ...context,
            }, 'tts synthesized');
            const ttsMode = options.ttsConfig?.mode;
            const ttsLogSrc = ttsMode === 'coqui_xtts'
                ? 'coqui_xtts'
                : ttsMode === 'chatterbox_http'
                    ? 'chatterbox'
                    : ttsMode === 'qwen3_tts_http'
                        ? 'qwen3_tts'
                        : 'kokoro';
            logTtsBytesReady(context, options.reason, ttsResult.audio, ttsResult.contentType, ttsLogSrc);
            const pipelineApplied = env_1.env.PLAYBACK_PROFILE === 'pstn';
            if (pipelineApplied) {
                const endPipeline = (0, metrics_1.startStageTimer)('tts_pipeline_ms', options.tenantId ?? 'unknown');
                const pipelineResult = (0, playbackPipeline_1.runPlaybackPipeline)(ttsResult.audio, {
                    targetSampleRateHz: env_1.env.PLAYBACK_PSTN_SAMPLE_RATE,
                    enableHighpass: env_1.env.PLAYBACK_ENABLE_HIGHPASS,
                    logContext: context,
                });
                endPipeline();
                ttsResult.audio = pipelineResult.audio;
            }
            const pipelineMeta = (0, audioProbe_1.getAudioMeta)(ttsResult.audio) ?? {
                format: 'wav',
                logContext: context,
                lineage: ['pipeline:unknown'],
            };
            if (pipelineApplied) {
                (0, audioProbe_1.probeWav)('tts.out.telephonyOptimized', ttsResult.audio, pipelineMeta);
            }
            (0, audioProbe_1.probeWav)('tx.telnyx.payload', ttsResult.audio, {
                ...pipelineMeta,
                kind: options.reason,
            });
            try {
                const info = (0, wavInfo_1.parseWavInfo)(ttsResult.audio);
                log_1.log.info({
                    event: 'wav_info',
                    source: 'pipeline_output',
                    id: options.reason,
                    sample_rate_hz: info.sampleRateHz,
                    channels: info.channels,
                    bits_per_sample: info.bitsPerSample,
                    data_bytes: info.dataBytes,
                    duration_ms: info.durationMs,
                    ...context,
                }, 'wav info');
            }
            catch (error) {
                const reason = error instanceof Error ? error.message : 'unknown_error';
                log_1.log.warn({
                    event: 'wav_info_parse_failed',
                    source: 'pipeline_output',
                    id: options.reason,
                    reason,
                    ...context,
                }, 'wav info parse failed');
            }
            const publicUrl = await (0, audioStore_1.storeWav)(options.callControlId, options.reason, ttsResult.audio);
            const playbackStart = Date.now();
            if (shouldSkipTelnyxAction('playback_start', options.callControlId, options.tenantId, options.requestId)) {
                return;
            }
            await telnyx.playAudio(options.callControlId, publicUrl);
            const playbackDuration = Date.now() - playbackStart;
            log_1.log.info({
                event: 'telnyx_playback_duration',
                duration_ms: playbackDuration,
                audio_url: publicUrl,
                ...context,
            }, 'telnyx playback completed');
        }
        catch (error) {
            log_1.log.warn({ err: error, ...context }, 'failed to play decline message');
        }
        finally {
            try {
                if (!shouldSkipTelnyxAction('hangup', options.callControlId, options.tenantId, options.requestId)) {
                    log_1.log.info({ event: 'telnyx_hangup_requested', reason: options.reason, ...context }, 'telnyx hangup requested (playMessageAndHangup)');
                    await telnyx.hangupCall(options.callControlId);
                }
            }
            catch (error) {
                log_1.log.error({ err: error, ...context }, 'failed to hangup call');
            }
        }
    }
    async function playHoldPrompt(callControlId, tenantId, requestId, ttsConfig) {
        const context = { call_control_id: callControlId, tenant_id: tenantId, requestId };
        const telnyx = new telnyxClient_1.TelnyxClient(context);
        const holdUrl = env_1.env.CAPACITY_HOLD_AUDIO_URL?.trim();
        if (holdUrl) {
            if (shouldSkipTelnyxAction('playback_start', callControlId, tenantId, requestId)) {
                return;
            }
            await telnyx.playAudio(callControlId, holdUrl);
            return;
        }
        const ttsResult = await (0, tts_1.synthesizeSpeech)({
            text: env_1.env.CAPACITY_HOLD_MESSAGE,
            voice: ttsConfig.mode === 'qwen3_tts_http' ? ttsConfig.speaker : ttsConfig.voice,
            format: ttsConfig.format,
            sampleRate: ttsConfig.sampleRate,
        }, ttsConfig);
        let audio = ttsResult.audio;
        if (env_1.env.PLAYBACK_PROFILE === 'pstn') {
            const pipelineResult = (0, playbackPipeline_1.runPlaybackPipeline)(audio, {
                targetSampleRateHz: env_1.env.PLAYBACK_PSTN_SAMPLE_RATE,
                enableHighpass: env_1.env.PLAYBACK_ENABLE_HIGHPASS,
                logContext: context,
            });
            audio = pipelineResult.audio;
        }
        const publicUrl = await (0, audioStore_1.storeWav)(callControlId, 'capacity_hold_prompt', audio);
        if (shouldSkipTelnyxAction('playback_start', callControlId, tenantId, requestId)) {
            return;
        }
        await telnyx.playAudio(callControlId, publicUrl);
    }
    async function proceedInboundPostCapacity(options) {
        const { callControlId, tenantId, tenantConfig, toNumber, from, requestId, pstnAlreadyAnswered = false, } = options;
        const forwarding = tenantConfig.callForwarding;
        if (forwarding?.enabled &&
            forwarding.destination &&
            forwarding.forwardBeforeAnswer !== false) {
            const telnyx = new telnyxClient_1.TelnyxClient({
                call_control_id: callControlId,
                tenant_id: tenantId,
                requestId,
            });
            try {
                if (!pstnAlreadyAnswered &&
                    !shouldSkipTelnyxAction('answer', callControlId, tenantId, requestId)) {
                    await telnyx.answerCall(callControlId);
                }
                await telnyx.transferCall(callControlId, forwarding.destination, {
                    audioUrl: forwarding.audioUrl,
                    timeoutSecs: forwarding.timeoutSecs,
                });
                log_1.log.info({
                    event: 'call_forwarded_before_answer',
                    call_control_id: callControlId,
                    tenant_id: tenantId,
                    destination: forwarding.destination,
                    requestId,
                }, 'call forwarded before answer');
            }
            catch (error) {
                log_1.log.error({ err: error, call_control_id: callControlId, tenant_id: tenantId, requestId }, 'call forward before answer failed');
                await playMessageAndHangup({
                    callControlId,
                    message: 'We could not complete your transfer. Please try again.',
                    reason: 'forward_failed',
                    requestId,
                    tenantId,
                    ttsConfig: tenantConfig.tts,
                    skipAnswer: pstnAlreadyAnswered,
                });
            }
            finally {
                await (0, capacity_1.release)({ tenantId, callControlId, requestId });
            }
            return;
        }
        sessionManager.evictPlaceholderSessionWithoutTenant(callControlId);
        if (tenantConfig.usageLimits?.features.callRecording) {
            recordingEnabledCalls.add(callControlId);
            recordingTenantByCall.set(callControlId, tenantId);
        }
        sessionManager.createSession({
            callControlId,
            tenantId,
            from,
            to: toNumber,
            tenantConfig,
            pstnAlreadyAnswered,
        }, { requestId });
        void (0, controlPlane_1.reportCallStart)({ tenantId, callId: callControlId, callerId: from });
        const transport = sessionManager.getTransport(callControlId);
        if (transport?.mode === 'pstn') {
            try {
                await transport.start();
                if (pstnAlreadyAnswered && !streamingStarted.has(callControlId)) {
                    await startStreamingOnce(callControlId, tenantId, requestId);
                }
                if (pstnAlreadyAnswered &&
                    recordingEnabledCalls.has(callControlId) &&
                    !recordingStartedCalls.has(callControlId)) {
                    const telnyx = new telnyxClient_1.TelnyxClient({
                        call_control_id: callControlId,
                        tenant_id: tenantId,
                        requestId,
                    });
                    await telnyx.startRecording(callControlId, Buffer.from(JSON.stringify({
                        kind: 'veralux_call_recording',
                        tenantId,
                        tenant_id: tenantId,
                        callId: callControlId,
                    })).toString('base64'));
                    recordingStartedCalls.add(callControlId);
                }
            }
            catch (error) {
                log_1.log.warn({
                    err: error,
                    call_control_id: callControlId,
                    tenant_id: tenantId,
                    requestId,
                }, 'immediate PSTN answer failed');
            }
        }
    }
    async function enqueueSessionWork(eventType, callControlId, payload, requestId, fallbackTenantId, payloadEnvelope) {
        if (!eventType || !callControlId) {
            return;
        }
        try {
            const drillState = decodeOncallDrillState(payload);
            if (drillState) {
                if (eventType === 'call.answered' || eventType === 'call.bridged') {
                    if (!drillSpokenCalls.has(callControlId)) {
                        await (0, tenantCredentials_1.bindTenantTelnyxCredential)(callControlId, drillState.tenantId);
                        const telnyx = new telnyxClient_1.TelnyxClient({
                            call_control_id: callControlId,
                            tenant_id: drillState.tenantId,
                            requestId,
                        });
                        await telnyx
                            .speakText(callControlId, 'This is a VeraLux on-call drill. Your page path is working.')
                            .catch((error) => log_1.log.warn({
                            err: error,
                            call_control_id: callControlId,
                            tenant_id: drillState.tenantId,
                        }, 'on-call drill speech failed'));
                        drillSpokenCalls.add(callControlId);
                    }
                    await (0, controlPlane_1.reportOncallDrillOutcome)({
                        tenantId: drillState.tenantId,
                        drillId: drillState.drillId,
                        callControlId,
                        status: 'answered',
                        latencyMs: Math.max(0, Date.now() - drillState.startedAt),
                    });
                    return;
                }
                if (eventType === 'call.hangup' || eventType === 'call.ended') {
                    await (0, controlPlane_1.reportOncallDrillOutcome)({
                        tenantId: drillState.tenantId,
                        drillId: drillState.drillId,
                        callControlId,
                        status: 'failed',
                        latencyMs: Math.max(0, Date.now() - drillState.startedAt),
                        reason: getString(payload?.hangup_cause) ||
                            getString(payload?.sip_hangup_cause) ||
                            'drill_call_ended',
                    });
                    drillSpokenCalls.delete(callControlId);
                    (0, tenantCredentials_1.releaseTenantTelnyxCredential)(callControlId);
                    return;
                }
                // Outbound drill initiation is not an inbound receptionist call.
                if (eventType === 'call.initiated')
                    return;
            }
            const transferState = decodeOncallTransferState(payload);
            if (transferState) {
                if (eventType === 'call.initiated') {
                    await (0, controlPlane_1.reportOncallOutcome)({
                        tenantId: transferState.tenantId,
                        callId: transferState.callId,
                        transferCallControlId: callControlId,
                        status: 'initiated',
                    });
                    return;
                }
                if (eventType === 'call.answered' || eventType === 'call.bridged') {
                    await (0, controlPlane_1.reportOncallOutcome)({
                        tenantId: transferState.tenantId,
                        callId: transferState.callId,
                        transferCallControlId: callControlId,
                        status: 'answered',
                    });
                    sessionManager.onTransferAnswered(transferState.callId, {
                        requestId,
                        tenantId: transferState.tenantId,
                    });
                    return;
                }
                if (eventType === 'call.hangup' || eventType === 'call.ended') {
                    const reason = getString(payload?.hangup_cause) ||
                        getString(payload?.sip_hangup_cause) ||
                        'transfer_failed';
                    await (0, controlPlane_1.reportOncallOutcome)({
                        tenantId: transferState.tenantId,
                        callId: transferState.callId,
                        transferCallControlId: callControlId,
                        status: 'failed',
                        reason,
                    });
                    sessionManager.onTransferFailed(transferState.callId, reason);
                    return;
                }
            }
            switch (eventType) {
                case 'call.initiated': {
                    const debugEnabled = tenantDebugEnabled();
                    const envelope = payloadEnvelope && typeof payloadEnvelope === 'object' ? payloadEnvelope : undefined;
                    const envelopeData = envelope && typeof envelope.data === 'object'
                        ? envelope.data
                        : undefined;
                    const envelopePayload = envelopeData && typeof envelopeData.payload === 'object'
                        ? envelopeData.payload
                        : undefined;
                    const didPayload = payload ?? envelopePayload;
                    if (debugEnabled) {
                        log_1.log.info({
                            event: 'tenant_did_debug',
                            call_control_id: callControlId,
                            requestId,
                            to: payload?.to ?? envelopePayload?.to,
                            from: payload?.from ??
                                envelopePayload?.from,
                            dataTo: envelopeData?.to ??
                                envelopePayload?.to,
                            dataFrom: envelopeData?.from ??
                                envelopePayload?.from,
                            payloadTo: payload?.to ??
                                envelopePayload?.to,
                            payloadFrom: payload?.from ??
                                envelopePayload?.from,
                            destination: payload?.destination ??
                                envelopePayload?.destination,
                            to_number: payload?.to_number ??
                                envelopePayload?.to_number,
                            called_number: payload?.called_number ??
                                envelopePayload?.called_number,
                        }, 'tenant did debug');
                    }
                    const toNumber = getToNumber(didPayload);
                    const normalizedTo = toNumber ? (0, tenantResolver_1.normalizeE164)(toNumber) : '';
                    const redisKey = normalizedTo ? `${env_1.env.TENANTMAP_PREFIX}:did:${normalizedTo}` : '';
                    if (debugEnabled) {
                        log_1.log.info({
                            event: 'tenant_resolve_input',
                            call_control_id: callControlId,
                            requestId,
                            rawTo: toNumber,
                            normalizedTo,
                            redisKey,
                        }, 'tenant resolve input');
                    }
                    const tenantId = toNumber ? await (0, tenantResolver_1.resolveTenantId)(toNumber) : null;
                    if (debugEnabled) {
                        log_1.log.info({ event: 'tenant_resolve_result', call_control_id: callControlId, requestId, tenant_id: tenantId }, 'tenant resolve result');
                    }
                    if (!tenantId) {
                        await playMessageAndHangup({
                            callControlId,
                            message: 'The number you dialed is not configured.',
                            reason: 'number_not_configured',
                            requestId,
                        });
                        return;
                    }
                    await (0, tenantCredentials_1.bindTenantTelnyxCredential)(callControlId, tenantId);
                    const tenantConfig = await (0, tenantConfig_1.loadTenantConfig)(tenantId);
                    if (!tenantConfig) {
                        log_1.log.warn({ tenant_id: tenantId, call_control_id: callControlId, requestId }, 'tenant config missing or invalid');
                        await playMessageAndHangup({
                            callControlId,
                            message: 'This number is not fully configured.',
                            reason: 'tenant_config_missing',
                            requestId,
                            tenantId,
                        });
                        return;
                    }
                    const usageGate = await (0, tenantUsage_1.checkTenantUsageBeforeCall)({ tenantId, tenantConfig });
                    if (!usageGate.ok) {
                        await playMessageAndHangup({
                            callControlId,
                            message: usageGate.message,
                            reason: usageGate.reason,
                            requestId,
                            tenantId,
                            ttsConfig: tenantConfig.tts,
                        });
                        return;
                    }
                    const capDefaults = {
                        tenantConcurrency: tenantConfig.caps.maxConcurrentCallsTenant,
                        tenantRpm: tenantConfig.caps.maxCallsPerMinuteTenant,
                        globalConcurrency: tenantConfig.caps.maxConcurrentCallsGlobal,
                    };
                    let capacity;
                    try {
                        capacity = await (0, capacity_1.tryAcquire)({
                            tenantId,
                            callControlId,
                            requestId,
                            capDefaults,
                        });
                    }
                    catch (error) {
                        log_1.log.error({ err: error, call_control_id: callControlId, tenant_id: tenantId, requestId }, 'capacity check failed');
                        await playMessageAndHangup({
                            callControlId,
                            message: 'We are unable to accept your call right now.',
                            reason: 'capacity_error',
                            requestId,
                            tenantId,
                            ttsConfig: tenantConfig.tts,
                        });
                        return;
                    }
                    if (!capacity.ok) {
                        if (env_1.env.CAPACITY_HOLD_ENABLED) {
                            if (capacityHoldInFlight.has(callControlId)) {
                                log_1.log.warn({
                                    event: 'capacity_hold_skip_duplicate_init',
                                    call_control_id: callControlId,
                                    tenant_id: tenantId,
                                    requestId,
                                }, 'skipping duplicate call.initiated while capacity hold in progress');
                                return;
                            }
                            capacityHoldInFlight.add(callControlId);
                            sessionManager.beginCapacityHold(callControlId);
                            const deadline = Date.now() + env_1.env.CAPACITY_HOLD_MAX_SECONDS * 1000;
                            let acquiredAfterHold = false;
                            try {
                                const telnyxHold = new telnyxClient_1.TelnyxClient({
                                    call_control_id: callControlId,
                                    tenant_id: tenantId,
                                    requestId,
                                });
                                if (!shouldSkipTelnyxAction('answer', callControlId, tenantId, requestId)) {
                                    await telnyxHold.answerCall(callControlId);
                                }
                                while (Date.now() < deadline) {
                                    if (!sessionManager.isCallActive(callControlId)) {
                                        log_1.log.info({
                                            event: 'capacity_hold_aborted',
                                            reason: 'caller_hangup',
                                            call_control_id: callControlId,
                                            tenant_id: tenantId,
                                            requestId,
                                        }, 'capacity hold ended (caller disconnected)');
                                        return;
                                    }
                                    try {
                                        await playHoldPrompt(callControlId, tenantId, requestId, tenantConfig.tts);
                                    }
                                    catch (promptErr) {
                                        log_1.log.warn({ err: promptErr, call_control_id: callControlId, tenant_id: tenantId, requestId }, 'capacity hold prompt failed');
                                    }
                                    await sleepMs(env_1.env.CAPACITY_HOLD_POLL_INTERVAL_MS);
                                    if (!sessionManager.isCallActive(callControlId)) {
                                        return;
                                    }
                                    let retryCap;
                                    try {
                                        retryCap = await (0, capacity_1.tryAcquire)({
                                            tenantId,
                                            callControlId,
                                            requestId,
                                            capDefaults,
                                        });
                                    }
                                    catch (retryErr) {
                                        log_1.log.error({ err: retryErr, call_control_id: callControlId, tenant_id: tenantId, requestId }, 'capacity hold retry check failed');
                                        await playMessageAndHangup({
                                            callControlId,
                                            message: 'We are unable to accept your call right now.',
                                            reason: 'capacity_error',
                                            requestId,
                                            tenantId,
                                            ttsConfig: tenantConfig.tts,
                                            skipAnswer: true,
                                        });
                                        return;
                                    }
                                    if (retryCap.ok) {
                                        acquiredAfterHold = true;
                                        break;
                                    }
                                }
                                if (!acquiredAfterHold) {
                                    await playMessageAndHangup({
                                        callControlId,
                                        message: env_1.env.CAPACITY_HOLD_TIMEOUT_MESSAGE,
                                        reason: 'capacity_hold_timeout',
                                        requestId,
                                        tenantId,
                                        ttsConfig: tenantConfig.tts,
                                        skipAnswer: true,
                                    });
                                    return;
                                }
                                await proceedInboundPostCapacity({
                                    callControlId,
                                    tenantId,
                                    tenantConfig,
                                    toNumber,
                                    from: getString(payload?.from),
                                    requestId,
                                    pstnAlreadyAnswered: true,
                                });
                                void (0, tenantUsage_1.recordTenantUsageCallStart)(tenantId);
                            }
                            finally {
                                sessionManager.endCapacityHold(callControlId);
                                capacityHoldInFlight.delete(callControlId);
                            }
                        }
                        else {
                            await playMessageAndHangup({
                                callControlId,
                                message: 'We are currently at capacity. Please try again later.',
                                reason: 'at_capacity',
                                requestId,
                                tenantId,
                                ttsConfig: tenantConfig.tts,
                            });
                        }
                        return;
                    }
                    await proceedInboundPostCapacity({
                        callControlId,
                        tenantId,
                        tenantConfig,
                        toNumber,
                        from: getString(payload?.from),
                        requestId,
                        pstnAlreadyAnswered: false,
                    });
                    void (0, tenantUsage_1.recordTenantUsageCallStart)(tenantId);
                    break;
                }
                case 'call.answered': {
                    const debugEnabled = mediaDebugEnabled();
                    sessionManager.onAnswered(callControlId, { requestId });
                    if (!streamingStarted.has(callControlId)) {
                        if (debugEnabled) {
                            log_1.log.info({
                                event: 'listen_start',
                                reason: 'call_answered',
                                call_control_id: callControlId,
                                tenant_id: fallbackTenantId,
                                requestId,
                            }, 'listen start');
                        }
                        await startStreamingOnce(callControlId, fallbackTenantId, requestId);
                    }
                    if (recordingEnabledCalls.has(callControlId) &&
                        !recordingStartedCalls.has(callControlId)) {
                        const telnyx = new telnyxClient_1.TelnyxClient({
                            call_control_id: callControlId,
                            tenant_id: fallbackTenantId,
                            requestId,
                        });
                        await telnyx.startRecording(callControlId, Buffer.from(JSON.stringify({
                            kind: 'veralux_call_recording',
                            tenantId: fallbackTenantId,
                            tenant_id: fallbackTenantId,
                            callId: callControlId,
                        })).toString('base64'));
                        recordingStartedCalls.add(callControlId);
                    }
                    break;
                }
                case 'call.playback.started': {
                    if (mediaDebugEnabled()) {
                        log_1.log.info({ event: 'playback_started', call_control_id: callControlId, requestId }, 'playback started');
                    }
                    break;
                }
                case 'call.playback.ended': {
                    const debugEnabled = mediaDebugEnabled();
                    if (debugEnabled) {
                        log_1.log.info({ event: 'playback_ended', call_control_id: callControlId, requestId }, 'playback ended');
                    }
                    // ✅ FIX: this MUST call the PSTN-authoritative Telnyx handler
                    sessionManager.onTelnyxPlaybackEnded(callControlId, {
                        requestId,
                        source: 'telnyx_webhook',
                    });
                    if (!streamingStarted.has(callControlId)) {
                        if (debugEnabled) {
                            log_1.log.info({ event: 'listen_start', call_control_id: callControlId, tenant_id: fallbackTenantId, requestId }, 'listen start');
                        }
                        await startStreamingOnce(callControlId, fallbackTenantId, requestId);
                    }
                    break;
                }
                case 'call.dtmf.received': {
                    const digit = getString(payload?.digit) ||
                        getString(payload?.dtmf) ||
                        (typeof payload?.digit === 'number' ? String(payload.digit) : undefined);
                    sessionManager.onDtmfReceived(callControlId, digit || '', {
                        requestId,
                        tenantId: fallbackTenantId,
                    });
                    break;
                }
                case 'streaming.stopped': {
                    log_1.log.warn({ event: 'streaming_stopped', call_control_id: callControlId, requestId, tenant_id: fallbackTenantId }, 'telnyx streaming stopped');
                    sessionManager.onMediaStreamingStopped(callControlId, { requestId, tenantId: fallbackTenantId });
                    streamingStarted.delete(callControlId);
                    break;
                }
                case 'call.recording.saved': {
                    let recordingState;
                    try {
                        recordingState = JSON.parse(Buffer.from(getString(payload?.client_state) || '', 'base64').toString('utf8'));
                    }
                    catch {
                        recordingState = undefined;
                    }
                    const tenantId = recordingState?.tenantId ||
                        fallbackTenantId ||
                        recordingTenantByCall.get(callControlId);
                    const urls = payload?.recording_urls &&
                        typeof payload.recording_urls === 'object'
                        ? payload.recording_urls
                        : {};
                    const recordingUrl = getString(urls.mp3) ||
                        getString(urls.wav) ||
                        getString(payload?.recording_url);
                    if (tenantId && recordingUrl) {
                        await (0, controlPlane_1.reportCallRecording)({
                            tenantId,
                            callId: recordingState?.callId || callControlId,
                            recordingUrl,
                        });
                    }
                    recordingEnabledCalls.delete(callControlId);
                    recordingStartedCalls.delete(callControlId);
                    recordingTenantByCall.delete(callControlId);
                    break;
                }
                case 'call.recording.error': {
                    log_1.log.warn({
                        event: 'telnyx_recording_error',
                        call_control_id: callControlId,
                        tenant_id: fallbackTenantId || recordingTenantByCall.get(callControlId),
                        error_detail: getString(payload?.error_detail),
                    }, 'Telnyx call recording failed');
                    recordingEnabledCalls.delete(callControlId);
                    recordingStartedCalls.delete(callControlId);
                    recordingTenantByCall.delete(callControlId);
                    break;
                }
                case 'call.hangup':
                case 'call.ended': {
                    const p = payload && typeof payload === 'object'
                        ? payload
                        : payloadEnvelope && typeof payloadEnvelope === 'object'
                            ? payloadEnvelope
                            : undefined;
                    // If the fields are nested (common with Telnyx envelopes), try to grab data.payload too.
                    const data = p?.data && typeof p.data === 'object' ? p.data : undefined;
                    const pp = data?.payload && typeof data.payload === 'object'
                        ? data.payload
                        : p;
                    log_1.log.warn({
                        event: 'telnyx_hangup_webhook',
                        call_control_id: callControlId,
                        event_type: eventType,
                        requestId,
                        tenant_id: fallbackTenantId,
                        hangup_cause: pp?.hangup_cause,
                        hangup_source: pp?.hangup_source,
                        sip_hangup_cause: pp?.sip_hangup_cause,
                        error_code: pp?.error_code,
                        error_detail: pp?.error_detail,
                    }, 'hangup received');
                    sessionManager.onHangup(callControlId, eventType, {
                        requestId,
                        tenantId: fallbackTenantId,
                    });
                    streamingStarted.delete(callControlId);
                    break;
                }
            }
        }
        catch (error) {
            log_1.log.error({ err: error, event_type: eventType, call_control_id: callControlId }, 'webhook dispatch failed');
        }
    }
    function shouldSkipTelnyxAction(action, callControlId, tenantId, requestId) {
        if (sessionManager.isCallActive(callControlId)) {
            return false;
        }
        log_1.log.warn({
            event: 'telnyx_action_skipped_inactive',
            action,
            call_control_id: callControlId,
            tenant_id: tenantId,
            requestId,
        }, 'skipping telnyx action - call inactive');
        return true;
    }
    router.post('/', async (req, res) => {
        const request = req;
        const requestId = request.id;
        const rawBody = request.rawBody ?? Buffer.from('');
        const signatureEd25519 = req.header('telnyx-signature-ed25519');
        const signatureHmac = req.header('telnyx-signature');
        const signature = signatureEd25519 ?? signatureHmac ?? '';
        const timestamp = req.header('telnyx-timestamp') ?? '';
        const scheme = signatureEd25519 ? 'ed25519' : signatureHmac ? 'hmac-sha256' : undefined;
        const rawMeta = (0, telnyxVerify_1.extractTelnyxEventMetaFromRawBody)(rawBody);
        let verificationTenantId = rawMeta.tenantId;
        if (!verificationTenantId && rawBody.length > 0) {
            try {
                const unsignedEnvelope = JSON.parse(rawBody.toString("utf8"));
                const to = getToNumber(unsignedEnvelope.data?.payload);
                if (to)
                    verificationTenantId = await (0, tenantResolver_1.resolveTenantId)(to) || undefined;
            }
            catch {
                // Signature verification below remains authoritative.
            }
        }
        // Per-tenant webhook verification: if tenant_id is in the payload (from client_state),
        // load tenant config and use its webhook secret for verification.
        let tenantSecret = null;
        let tenantPublicKey = null;
        if (verificationTenantId) {
            try {
                const tenantConfig = await (0, tenantConfig_1.loadTenantConfig)(verificationTenantId);
                if (tenantConfig) {
                    tenantSecret = (0, tenantConfig_1.getWebhookSecret)(tenantConfig);
                    tenantPublicKey = tenantConfig.telnyxPublicKey || null;
                }
            }
            catch (error) {
                log_1.log.warn({ err: error, tenant_id: verificationTenantId, requestId }, 'failed to load tenant config for signature verification');
            }
        }
        const signatureCheck = (0, telnyxVerify_1.verifyTelnyxSignature)({
            rawBody,
            signature,
            timestamp,
            scheme,
            tenantSecret,
            tenantPublicKey,
        });
        if (signatureCheck.skipped) {
            log_1.log.warn({ requestId, event_type: rawMeta.eventType }, 'telnyx signature check skipped (dev)');
        }
        if (!signatureCheck.ok) {
            (0, metrics_2.incWebhookSignatureFailure)();
            log_1.log.warn({
                requestId,
                event_type: rawMeta.eventType,
                call_control_id: rawMeta.callControlId,
                tenant_id: rawMeta.tenantId,
                action_taken: 'reject_invalid_signature',
                verify_reason: signatureCheck.reason,
                used_tenant_secret: !!tenantSecret,
            }, 'telnyx webhook ack');
            res.status(401).json({ error: 'invalid_signature' });
            return;
        }
        const replayAllowed = await (0, webhookReplayGuard_1.guardedClaim)(() => (0, webhookReplayGuard_1.claimWebhookSignature)(signature, timestamp), { requestId, event_type: rawMeta.eventType, call_control_id: rawMeta.callControlId, replay_key_type: 'signature' });
        if (!replayAllowed) {
            (0, metrics_2.incWebhookReplayRejected)();
            log_1.log.warn({
                requestId,
                event_type: rawMeta.eventType,
                call_control_id: rawMeta.callControlId,
                tenant_id: rawMeta.tenantId,
                action_taken: 'reject_signature_replay',
            }, 'telnyx webhook replay rejected');
            res.status(401).json({ error: 'replay_rejected' });
            return;
        }
        const payload = typeof req.body === 'object' && req.body !== null
            ? req.body
            : undefined;
        const parsedMeta = (0, telnyxVerify_1.extractTelnyxEventMetaFromPayload)(payload ?? req.body);
        const eventType = parsedMeta.eventType ?? rawMeta.eventType;
        const callControlId = parsedMeta.callControlId ?? rawMeta.callControlId;
        const tenantId = parsedMeta.tenantId ?? rawMeta.tenantId;
        const payloadObj = payload?.data?.payload && typeof payload.data.payload === 'object'
            ? payload.data.payload
            : undefined;
        const eventId = payload &&
            typeof payload === 'object' &&
            payload.data &&
            typeof payload.data === 'object' &&
            typeof payload.data.id === 'string'
            ? String(payload.data.id).trim()
            : '';
        if (eventId) {
            const firstSeen = await (0, webhookReplayGuard_1.guardedClaim)(() => (0, webhookReplayGuard_1.claimWebhookEventId)(eventId), { requestId, event_type: eventType, call_control_id: callControlId, replay_key_type: 'event_id' });
            if (!firstSeen) {
                log_1.log.info({
                    requestId,
                    event_type: eventType,
                    call_control_id: callControlId,
                    tenant_id: tenantId,
                    event_id: eventId,
                    action_taken: 'dedupe_duplicate_event',
                }, 'telnyx duplicate webhook ignored');
                res.status(200).json({ ok: true, duplicate: true });
                return;
            }
        }
        const actionTaken = determineAction(eventType, callControlId);
        if (callControlId) {
            const transferState = decodeOncallTransferState(payloadObj);
            const drillState = decodeOncallDrillState(payloadObj);
            const requiresActive = !transferState &&
                !drillState &&
                eventType !== 'call.recording.saved' &&
                eventType !== 'call.recording.error' &&
                eventType !== 'call.hangup' &&
                eventType !== 'call.ended';
            const taskName = `telnyx_webhook_${eventType ?? 'unknown'}`;
            sessionManager.enqueue(callControlId, {
                name: taskName,
                requiresActive,
                run: async () => {
                    await enqueueSessionWork(eventType, callControlId, payloadObj, requestId, tenantId, payload ?? req.body);
                },
            });
        }
        log_1.log.info({
            requestId,
            event_type: eventType,
            call_control_id: callControlId,
            tenant_id: tenantId,
            action_taken: actionTaken,
            event_id: eventId || undefined,
        }, 'telnyx webhook ack');
        res.status(200).json({ ok: true });
    });
    return router;
}
//# sourceMappingURL=telnyxWebhook.js.map