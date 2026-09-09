"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.synthesizeSpeechMagpie = synthesizeSpeechMagpie;
const httpClient_1 = require("../httpClient");
const log_1 = require("../log");
function magpieBaseUrl(url) {
    return url.replace(/\/$/, '').replace(/\/tts$/i, '');
}
/** Live image may not have dist/audio/wavSpeakingRate. Speed by rewriting PCM16 WAV sample rate. */
function applyPcm16SpeakingRate(wav, rate) {
    if (!rate || !Number.isFinite(rate) || Math.abs(rate - 1) < 0.02)
        return wav;
    if (wav.length < 44 || wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') {
        return wav;
    }
    const paced = Math.min(1.2, Math.max(0.8, rate));
    const out = Buffer.from(wav);
    let offset = 12;
    while (offset + 8 <= out.length) {
        const id = out.toString('ascii', offset, offset + 4);
        const size = out.readUInt32LE(offset + 4);
        if (id === 'fmt ' && offset + 24 <= out.length) {
            const sampleRate = out.readUInt32LE(offset + 12);
            const next = Math.max(8000, Math.round(sampleRate * paced));
            out.writeUInt32LE(next, offset + 12);
            const channels = out.readUInt16LE(offset + 10);
            const bits = out.readUInt16LE(offset + 22);
            const byteRate = Math.round((next * channels * bits) / 8);
            out.writeUInt32LE(byteRate, offset + 16);
            return out;
        }
        offset += 8 + size + (size % 2);
    }
    return wav;
}
/**
 * NVIDIA Magpie HTTP client — expects veralux-audio-stack/magpie_tts_server.py.
 * Rate is applied after synthesis (Magpie has no native speed knob).
 */
async function synthesizeSpeechMagpie(request) {
    const endpoint = `${magpieBaseUrl(request.magpieTtsUrl)}/tts`;
    const speaker = (request.speaker || 'Sofia').trim() || 'Sofia';
    const language = (request.language || 'en').trim() || 'en';
    log_1.log.info({
        event: 'tts_request',
        provider: 'magpie_tts_http',
        speaker,
        language,
        temperature: request.temperature ?? null,
        cfg_scale: request.cfgScale ?? null,
    }, 'magpie tts request');
    const body = {
        text: request.text,
        speaker,
        language,
    };
    if (request.temperature !== undefined)
        body.temperature = request.temperature;
    if (request.cfgScale !== undefined)
        body.cfg_scale = request.cfgScale;
    if (request.topK !== undefined)
        body.top_k = request.topK;
    body.use_cfg = request.useCfg === true;
    body.apply_tn = request.applyTn === true;
    const response = await (0, httpClient_1.fetchWithTimeoutRetry)(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        timeoutMs: 90000,
        retries: 0,
    });
    const contentType = response.headers.get('content-type') ?? '';
    const raw = Buffer.from(await response.arrayBuffer());
    if (!response.ok) {
        log_1.log.error({ status: response.status, body: raw.toString('utf8').slice(0, 500) }, 'magpie tts error');
        throw new Error(`magpie tts error ${response.status}`);
    }
    if (contentType.includes('application/json')) {
        throw new Error(`magpie tts: ${raw.toString('utf8').slice(0, 400)}`);
    }
    const wav = applyPcm16SpeakingRate(raw, request.rate);
    return { audio: wav, contentType: contentType || 'audio/wav' };
}
//# sourceMappingURL=magpieTts.js.map