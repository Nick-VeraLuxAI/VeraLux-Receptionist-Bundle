"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TelnyxClient = void 0;
exports.telnyxCallControl = telnyxCallControl;
const env_1 = require("../env");
const log_1 = require("../log");
const audioProbe_1 = require("../diagnostics/audioProbe");
const metrics_1 = require("../metrics");
const circuitBreaker_1 = require("../providers/circuitBreaker");
const tenantCredentials_1 = require("./tenantCredentials");
const streamCodec_1 = require("./streamCodec");
const TELNYX_BASE_URL = 'https://api.telnyx.com/v2';
const TELNYX_TIMEOUT_MS = 8000;
const TELNYX_MAX_RETRIES = 2;
// Retry backoff tuning (keep small; call-control is latency-sensitive)
const TELNYX_RETRY_BASE_MS = 250;
const TELNYX_RETRY_MAX_MS = 1500;
function maskTelnyxKey(value) {
    const trimmed = value.trim();
    if (trimmed.length <= 8) {
        return `${trimmed.slice(0, 2)}...${trimmed.slice(-2)}`;
    }
    return `${trimmed.slice(0, 4)}...${trimmed.slice(-4)}`;
}
function shouldRetry(status) {
    return status === 429 || status >= 500;
}
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
function backoffMs(attempt) {
    // attempt: 0,1,2...
    const exp = Math.min(TELNYX_RETRY_MAX_MS, TELNYX_RETRY_BASE_MS * Math.pow(2, attempt));
    const jitter = Math.floor(Math.random() * 120); // small jitter
    return exp + jitter;
}
function truncateForLog(value, max = 800) {
    try {
        const s = typeof value === 'string' ? value : JSON.stringify(value);
        if (s.length <= max)
            return s;
        return `${s.slice(0, max)}…(truncated)`;
    }
    catch {
        return '[unserializable]';
    }
}
function isCallEndedResponse(status, body) {
    if (status !== 422) {
        return false;
    }
    try {
        const text = typeof body === 'string' ? body : JSON.stringify(body);
        return /already ended|no longer active/i.test(text);
    }
    catch {
        return false;
    }
}
function attachCallControlErrorDetails(error, status, body) {
    error.status = status;
    error.responseBody = body;
    return error;
}
async function safeReadBody(response) {
    const contentType = response.headers.get('content-type') ?? '';
    if (contentType.includes('application/json')) {
        try {
            return await response.json();
        }
        catch {
            // fall through to text
        }
    }
    try {
        return await response.text();
    }
    catch (e) {
        return `<<failed to read response body: ${String(e)}>>`;
    }
}
function isAbortError(err) {
    return (err instanceof Error &&
        (err.name === 'AbortError' || /aborted|AbortError/i.test(err.message)));
}
async function callControlRequest(callControlId, action, body, attempt, logContext, apiKey) {
    const url = `${TELNYX_BASE_URL}/calls/${callControlId}/actions/${action}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TELNYX_TIMEOUT_MS);
    const startedAt = Date.now();
    const keyFingerprint = maskTelnyxKey(apiKey);
    log_1.log.info({
        event: 'telnyx_call_control_request',
        action,
        call_control_id: callControlId,
        telnyx_api_key_fingerprint: keyFingerprint,
        attempt,
        ...logContext,
    }, 'telnyx call-control request');
    try {
        const headers = {
            Authorization: `Bearer ${apiKey}`,
            Accept: 'application/json',
            'User-Agent': 'veralux-voice-runtime/0.1.0',
        };
        let payload;
        if (body && Object.keys(body).length > 0) {
            headers['Content-Type'] = 'application/json';
            payload = JSON.stringify(body);
        }
        const response = await (0, circuitBreaker_1.withCircuitBreaker)({
            key: 'telnyx_call_control',
            failureThreshold: 4,
            openMs: 15000,
            onOpen: () => (0, metrics_1.incProviderCircuitOpen)('telnyx_call_control'),
            action: () => fetch(url, {
                method: 'POST',
                headers,
                body: payload,
                signal: controller.signal,
            }),
        });
        const responseBody = await safeReadBody(response);
        const durationMs = Date.now() - startedAt;
        if (!response.ok) {
            const logBody = truncateForLog(responseBody, 1000);
            if (isCallEndedResponse(response.status, responseBody)) {
                log_1.log.warn({
                    event: 'telnyx_call_control_ignored_post_end',
                    action,
                    call_control_id: callControlId,
                    status: response.status,
                    duration_ms: durationMs,
                    body: logBody,
                    ...logContext,
                }, 'telnyx call-control ignored post end');
                return responseBody;
            }
            if (shouldRetry(response.status) && attempt < TELNYX_MAX_RETRIES) {
                const waitMs = backoffMs(attempt);
                log_1.log.warn({
                    event: 'telnyx_call_control_retry',
                    action,
                    call_control_id: callControlId,
                    status: response.status,
                    duration_ms: durationMs,
                    wait_ms: waitMs,
                    attempt,
                    body: logBody,
                    ...logContext,
                }, 'telnyx call-control retry');
                await sleep(waitMs);
                return callControlRequest(callControlId, action, body, attempt + 1, logContext, apiKey);
            }
            log_1.log.error({
                event: 'telnyx_call_control_failed',
                action,
                call_control_id: callControlId,
                status: response.status,
                duration_ms: durationMs,
                body: logBody,
                ...logContext,
            }, 'telnyx call-control failed');
            throw attachCallControlErrorDetails(new Error(`Telnyx call-control ${action} failed: ${response.status} ${truncateForLog(responseBody, 1200)}`), response.status, responseBody);
        }
        log_1.log.info({
            event: 'telnyx_call_control_completed',
            action,
            call_control_id: callControlId,
            status: response.status,
            duration_ms: durationMs,
            ...logContext,
        }, 'telnyx call-control completed');
        return responseBody;
    }
    catch (error) {
        if (isAbortError(error)) {
            (0, metrics_1.incProviderTimeout)('telnyx_call_control');
        }
        const errorStatus = error.status;
        const errorBody = error.responseBody;
        if (errorStatus === 422 && isCallEndedResponse(errorStatus, errorBody ?? error)) {
            log_1.log.warn({
                event: 'telnyx_call_control_ignored_post_end',
                action,
                call_control_id: callControlId,
                status: errorStatus,
                err: error,
                ...logContext,
            }, 'telnyx call-control ignored post end');
            return errorBody;
        }
        // Abort should NOT be retried aggressively (usually means Telnyx API is slow or our timeout too low)
        if (!isAbortError(error) && attempt < TELNYX_MAX_RETRIES) {
            const waitMs = backoffMs(attempt);
            log_1.log.warn({
                event: 'telnyx_call_control_error_retry',
                action,
                call_control_id: callControlId,
                attempt,
                wait_ms: waitMs,
                err: error,
                ...logContext,
            }, 'telnyx call-control error retry');
            await sleep(waitMs);
            return callControlRequest(callControlId, action, body, attempt + 1, logContext, apiKey);
        }
        log_1.log.error({
            event: 'telnyx_call_control_error',
            action,
            call_control_id: callControlId,
            err: error,
            ...logContext,
        }, 'telnyx call-control error');
        throw error;
    }
    finally {
        clearTimeout(timer);
    }
}
async function telnyxCallControl(callControlId, action, body, logContext = {}, apiKey = env_1.env.TELNYX_API_KEY) {
    let normalizedBody = body;
    if (action === 'answer' && body) {
        const hasStreamUrl = Object.prototype.hasOwnProperty.call(body, 'stream_url');
        const hasStreamTrack = Object.prototype.hasOwnProperty.call(body, 'stream_track');
        if (hasStreamUrl || hasStreamTrack) {
            const { media_format: _mediaFormat, ...rest } = body;
            normalizedBody = {
                ...rest,
                ...(0, streamCodec_1.buildTelnyxStreamingStartBody)({
                    streamUrl: typeof rest.stream_url === 'string' ? rest.stream_url : '',
                    streamTrack: typeof rest.stream_track === 'string' ? rest.stream_track : env_1.env.TELNYX_STREAM_TRACK,
                }),
            };
        }
    }
    return callControlRequest(callControlId, action, normalizedBody, 0, logContext, apiKey);
}
class TelnyxClient {
    constructor(context = {}) {
        this.baseUrl = TELNYX_BASE_URL;
        this.timeoutMs = TELNYX_TIMEOUT_MS;
        this.maxRetries = TELNYX_MAX_RETRIES;
        this.logContext = context;
        this.apiKey = (0, tenantCredentials_1.telnyxApiKeyForCall)(context.call_control_id);
    }
    buildRequest(path, options = {}) {
        const url = new URL(path, this.baseUrl).toString();
        const headers = {
            Authorization: `Bearer ${this.apiKey}`,
            Accept: 'application/json',
            'User-Agent': 'veralux-voice-runtime/0.1.0',
            ...options.headers,
        };
        // Only set JSON content-type if the caller provided a body (and didn’t override)
        if (options.body && !('Content-Type' in headers) && !('content-type' in headers)) {
            headers['Content-Type'] = 'application/json';
        }
        return {
            url,
            options: {
                ...options,
                method: options.method ?? 'GET',
                headers,
            },
        };
    }
    async request(path, options = {}) {
        return this.requestWithRetry(path, options, 0);
    }
    async answerCall(callControlId) {
        await telnyxCallControl(callControlId, 'answer', undefined, this.logContext, this.apiKey);
        log_1.log.info({ event: 'telnyx_answer_call', call_control_id: callControlId, ...this.logContext }, 'telnyx call answered');
    }
    async playAudio(callControlId, audioUrl) {
        await telnyxCallControl(callControlId, 'playback_start', { audio_url: audioUrl }, this.logContext, this.apiKey);
        log_1.log.info({
            event: 'telnyx_play_audio',
            call_control_id: callControlId,
            audio_url: audioUrl,
            ...this.logContext,
        }, 'telnyx playback started');
    }
    async stopPlayback(callControlId) {
        await telnyxCallControl(callControlId, 'playback_stop', undefined, this.logContext, this.apiKey);
        log_1.log.info({
            event: 'telnyx_playback_stop',
            call_control_id: callControlId,
            ...this.logContext,
        }, 'telnyx playback stop requested');
    }
    async startStreaming(callControlId, streamUrl, options = {}) {
        const normalizeStreamTrack = (track) => {
            switch (track) {
                case 'inbound':
                    return 'inbound_track';
                case 'outbound':
                    return 'outbound_track';
                case 'both':
                    return 'both_tracks';
                default:
                    return track;
            }
        };
        const streamTrack = normalizeStreamTrack(options.streamTrack ?? env_1.env.TELNYX_STREAM_TRACK);
        const requestedCodec = options.streamCodec ?? env_1.env.TELNYX_STREAM_CODEC ?? streamCodec_1.TELNYX_WS_STREAM_CODEC;
        if (requestedCodec !== streamCodec_1.TELNYX_WS_STREAM_CODEC) {
            log_1.log.warn({
                event: 'telnyx_stream_codec_coerced_to_l16',
                call_control_id: callControlId,
                requested_codec: requestedCodec,
                selected_codec: streamCodec_1.TELNYX_WS_STREAM_CODEC,
            }, 'WebSocket stream codec coerced to L16 (AMR-WB fallback disabled)');
        }
        const requestBody = (0, streamCodec_1.buildTelnyxStreamingStartBody)({ streamUrl, streamTrack });
        log_1.log.info({
            event: 'telnyx_stream_start',
            call_control_id: callControlId,
            stream_codec: requestBody.stream_codec,
            stream_bidirectional_mode: requestBody.stream_bidirectional_mode,
            stream_bidirectional_codec: requestBody.stream_bidirectional_codec,
            stream_bidirectional_sampling_rate: requestBody.stream_bidirectional_sampling_rate,
            stream_track: requestBody.stream_track,
            sip_accept_codecs: env_1.env.TELNYX_ACCEPT_CODECS,
        }, 'Telnyx stream start (requested codec)');
        if ((0, audioProbe_1.diagnosticsEnabled)()) {
            log_1.log.info({
                event: 'audio_codec_info',
                direction: 'tx.telnyx_stream_request',
                call_control_id: callControlId,
                stream_codec: requestBody.stream_codec,
                stream_bidirectional_mode: requestBody.stream_bidirectional_mode,
                stream_bidirectional_codec: requestBody.stream_bidirectional_codec,
                stream_bidirectional_sampling_rate: requestBody.stream_bidirectional_sampling_rate,
                stream_track: requestBody.stream_track,
            }, 'audio codec info');
        }
        const redactedStreamUrl = (() => {
            try {
                const parsed = new URL(streamUrl);
                if (parsed.searchParams.has('token')) {
                    parsed.searchParams.set('token', '[redacted]');
                }
                return parsed.toString();
            }
            catch {
                return streamUrl.replace(/token=[^&]+/g, 'token=[redacted]');
            }
        })();
        log_1.log.info({
            event: 'telnyx_streaming_start_request',
            call_control_id: callControlId,
            request_body: {
                ...requestBody,
                stream_url: redactedStreamUrl,
            },
            ...this.logContext,
        }, 'telnyx streaming start request');
        await telnyxCallControl(callControlId, 'streaming_start', requestBody, this.logContext, this.apiKey);
        log_1.log.info({
            event: 'telnyx_streaming_start',
            call_control_id: callControlId,
            stream_url: redactedStreamUrl,
            ...this.logContext,
        }, 'telnyx streaming start requested');
    }
    async hangupCall(callControlId) {
        await telnyxCallControl(callControlId, 'hangup', undefined, this.logContext, this.apiKey);
        log_1.log.info({ event: 'telnyx_hangup_call', call_control_id: callControlId, ...this.logContext }, 'telnyx call hangup');
    }
    async startRecording(callControlId, clientState) {
        await telnyxCallControl(callControlId, 'record_start', {
            channels: 'single',
            format: 'mp3',
            ...(clientState ? { client_state: clientState } : {}),
        }, this.logContext, this.apiKey);
        log_1.log.info({
            event: 'telnyx_recording_started',
            call_control_id: callControlId,
            ...this.logContext,
        }, 'Telnyx call recording started');
    }
    async speakText(callControlId, text) {
        await telnyxCallControl(callControlId, 'speak', {
            payload: text.slice(0, 3000),
            payload_type: 'text',
            voice: 'Telnyx.KokoroTTS.af',
            language: 'en-US',
        }, this.logContext, this.apiKey);
    }
    /**
     * Transfer an active call to another destination (E.164 number or SIP URI).
     * Call must be answered first. On success Telnyx bridges the call and sends call.bridged;
     * on failure you get call.hangup on the B leg; original leg stays active.
     */
    async transferCall(callControlId, to, options = {}) {
        const body = { to };
        if (options.from != null)
            body.from = options.from;
        if (options.timeoutSecs != null)
            body.timeout_secs = options.timeoutSecs;
        if (options.audioUrl != null)
            body.audio_url = options.audioUrl;
        if (options.targetLegClientState != null) {
            body.target_leg_client_state = options.targetLegClientState;
        }
        if (options.commandId != null)
            body.command_id = options.commandId;
        await telnyxCallControl(callControlId, 'transfer', body, this.logContext, this.apiKey);
        log_1.log.info({
            event: 'telnyx_transfer_call',
            call_control_id: callControlId,
            to,
            ...this.logContext,
        }, 'telnyx call transfer');
    }
    async requestWithRetry(path, options, attempt) {
        const prepared = this.buildRequest(path, options);
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timeoutMs);
        const startedAt = Date.now();
        try {
            const response = await fetch(prepared.url, {
                method: prepared.options.method,
                headers: prepared.options.headers,
                body: prepared.options.body,
                signal: controller.signal,
            });
            const body = await safeReadBody(response);
            const durationMs = Date.now() - startedAt;
            if (!response.ok) {
                const logBody = truncateForLog(body, 1000);
                if (shouldRetry(response.status) && attempt < this.maxRetries) {
                    const waitMs = backoffMs(attempt);
                    log_1.log.warn({
                        event: 'telnyx_request_retry',
                        url: prepared.url,
                        status: response.status,
                        attempt,
                        wait_ms: waitMs,
                        duration_ms: durationMs,
                        body: logBody,
                        ...this.logContext,
                    }, 'telnyx request retry');
                    await sleep(waitMs);
                    return this.requestWithRetry(path, options, attempt + 1);
                }
                log_1.log.error({
                    event: 'telnyx_request_failed',
                    url: prepared.url,
                    status: response.status,
                    duration_ms: durationMs,
                    body: logBody,
                    ...this.logContext,
                }, 'telnyx request failed');
                throw new Error(`Telnyx request failed: ${response.status} ${logBody}`);
            }
            log_1.log.info({
                event: 'telnyx_request_completed',
                url: prepared.url,
                status: response.status,
                duration_ms: durationMs,
                ...this.logContext,
            }, 'telnyx request completed');
            return body;
        }
        catch (error) {
            if (!isAbortError(error) && attempt < this.maxRetries) {
                const waitMs = backoffMs(attempt);
                log_1.log.warn({
                    event: 'telnyx_request_error_retry',
                    url: prepared.url,
                    attempt,
                    wait_ms: waitMs,
                    err: error,
                    ...this.logContext,
                }, 'telnyx request error retry');
                await sleep(waitMs);
                return this.requestWithRetry(path, options, attempt + 1);
            }
            log_1.log.error({ event: 'telnyx_request_error', url: prepared.url, err: error, ...this.logContext }, 'telnyx request error');
            throw error;
        }
        finally {
            clearTimeout(timer);
        }
    }
}
exports.TelnyxClient = TelnyxClient;
//# sourceMappingURL=telnyxClient.js.map