"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.synthesizeSpeechMelo = synthesizeSpeechMelo;
const httpClient_1 = require("../httpClient");
const log_1 = require("../log");
function meloBaseUrl(url) {
    return url.replace(/\/$/, '').replace(/\/tts$/i, '');
}
/**
 * MeloTTS HTTP client — expects veralux-audio-stack/melo_tts_server.py.
 * Speed is native; do not also apply WAV speaking-rate.
 */
async function synthesizeSpeechMelo(request) {
    const endpoint = `${meloBaseUrl(request.meloTtsUrl)}/tts`;
    const speaker = (request.speaker || 'EN-US').trim() || 'EN-US';
    const language = (request.language || 'EN').trim() || 'EN';
    log_1.log.info({
        event: 'tts_request',
        provider: 'melo_tts_http',
        speaker,
        language,
        speed: request.speed ?? null,
    }, 'melo tts request');
    const body = {
        text: request.text,
        speaker,
        language,
    };
    if (request.speed !== undefined)
        body.speed = request.speed;
    if (request.sdpRatio !== undefined)
        body.sdp_ratio = request.sdpRatio;
    if (request.noiseScale !== undefined)
        body.noise_scale = request.noiseScale;
    if (request.noiseScaleW !== undefined)
        body.noise_scale_w = request.noiseScaleW;
    const response = await (0, httpClient_1.fetchWithTimeoutRetry)(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        timeoutMs: 60000,
        retries: 0,
    });
    const contentType = response.headers.get('content-type') ?? '';
    const raw = Buffer.from(await response.arrayBuffer());
    if (!response.ok) {
        log_1.log.error({ status: response.status, body: raw.toString('utf8').slice(0, 500) }, 'melo tts error');
        throw new Error(`melo tts error ${response.status}`);
    }
    if (contentType.includes('application/json')) {
        throw new Error(`melo tts: ${raw.toString('utf8').slice(0, 400)}`);
    }
    return { audio: raw, contentType: contentType || 'audio/wav' };
}
//# sourceMappingURL=meloTts.js.map