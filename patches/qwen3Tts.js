"use strict";
/**
 * VERA_DEMO_SHOP_QWEN3_STREAM_20260908
 * Live mount of dist/tts/qwen3Tts.js — VLX1 /tts/stream + /tts fallback.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.mergeQwen3TenantAndRequest = mergeQwen3TenantAndRequest;
exports.applyQwen3VoiceConsistencyDefaults = applyQwen3VoiceConsistencyDefaults;
exports.qwen3StreamingEnabled = qwen3StreamingEnabled;
exports.iterateQwen3StreamWavs = iterateQwen3StreamWavs;
exports.collectQwen3StreamWavs = collectQwen3StreamWavs;
exports.synthesizeSpeechQwen3 = synthesizeSpeechQwen3;
const log_1 = require("../log");
const httpClient_1 = require("../httpClient");
let applyWavSpeakingRate = (wav) => wav;
let splitSpeakingRateInstruct = (instruct) => ({ instruct, rate: undefined });
try {
    const wr = require("../audio/wavSpeakingRate");
    if (typeof wr.applyWavSpeakingRate === "function") {
        applyWavSpeakingRate = wr.applyWavSpeakingRate;
    }
    if (typeof wr.splitSpeakingRateInstruct === "function") {
        splitSpeakingRateInstruct = wr.splitSpeakingRateInstruct;
    }
}
catch {
    /* older runtime image without wavSpeakingRate */
}
const QWEN3_GEN_KEYS = [
    "qwen3DoSample",
    "qwen3Temperature",
    "qwen3TopP",
    "qwen3TopK",
    "qwen3RepetitionPenalty",
    "qwen3MaxNewTokens",
    "qwen3NonStreamingMode",
    "qwen3SubtalkerDoSample",
    "qwen3SubtalkerTopK",
    "qwen3SubtalkerTopP",
    "qwen3SubtalkerTemperature",
];
function mergeQwen3TenantAndRequest(request, tenant) {
    const o = {};
    for (const k of QWEN3_GEN_KEYS) {
        const rv = request[k];
        const tv = tenant[k];
        const v = rv !== undefined ? rv : tv;
        if (v !== undefined)
            o[k] = v;
    }
    return o;
}
function applyQwen3VoiceConsistencyDefaults(gen) {
    const o = { ...gen };
    if (o.qwen3DoSample === undefined) {
        o.qwen3DoSample = false;
    }
    return o;
}
function qwen3GenToJsonBody(g) {
    const out = {};
    if (g.qwen3DoSample !== undefined)
        out.do_sample = g.qwen3DoSample;
    if (g.qwen3Temperature !== undefined)
        out.temperature = g.qwen3Temperature;
    if (g.qwen3TopP !== undefined)
        out.top_p = g.qwen3TopP;
    if (g.qwen3TopK !== undefined)
        out.top_k = g.qwen3TopK;
    if (g.qwen3RepetitionPenalty !== undefined)
        out.repetition_penalty = g.qwen3RepetitionPenalty;
    if (g.qwen3MaxNewTokens !== undefined)
        out.max_new_tokens = g.qwen3MaxNewTokens;
    if (g.qwen3NonStreamingMode !== undefined)
        out.non_streaming_mode = g.qwen3NonStreamingMode;
    if (g.qwen3SubtalkerDoSample !== undefined)
        out.subtalker_dosample = g.qwen3SubtalkerDoSample;
    if (g.qwen3SubtalkerTopK !== undefined)
        out.subtalker_top_k = g.qwen3SubtalkerTopK;
    if (g.qwen3SubtalkerTopP !== undefined)
        out.subtalker_top_p = g.qwen3SubtalkerTopP;
    if (g.qwen3SubtalkerTemperature !== undefined)
        out.subtalker_temperature = g.qwen3SubtalkerTemperature;
    return out;
}
function qwen3StreamingEnabled() {
    const v = String(process.env.QWEN3_TTS_STREAMING ?? "true").trim().toLowerCase();
    return v !== "false" && v !== "0" && v !== "off";
}
const STREAM_MAGIC = Buffer.from("VLX1", "ascii");
function qwen3BaseUrl(url) {
    return String(url || "")
        .replace(/\/$/, "")
        .replace(/\/tts\/stream$/i, "")
        .replace(/\/tts$/i, "");
}
function qwen3JsonBody(request) {
    const genJson = request.gen ? qwen3GenToJsonBody(request.gen) : {};
    const tuned = splitSpeakingRateInstruct(request.instruct);
    return {
        text: request.text,
        speaker: request.speaker,
        language: request.language,
        instruct: tuned.instruct,
        ...genJson,
    };
}
async function* iterateVlx1FromResponse(response) {
    const reader = response.body?.getReader();
    if (!reader) {
        const raw = Buffer.from(await response.arrayBuffer());
        if (raw.length < 4 || !raw.subarray(0, 4).equals(STREAM_MAGIC)) {
            throw new Error("qwen3_stream_bad_magic");
        }
        let o = 4;
        while (o + 4 <= raw.length) {
            const n = raw.readUInt32BE(o);
            o += 4;
            if (n <= 0 || o + n > raw.length)
                throw new Error("qwen3_stream_truncated");
            yield Buffer.from(raw.subarray(o, o + n));
            o += n;
        }
        return;
    }
    let buf = Buffer.alloc(0);
    let magic = false;
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (value)
                buf = Buffer.concat([buf, Buffer.from(value)]);
            if (!magic) {
                if (buf.length < 4) {
                    if (done)
                        throw new Error("qwen3_stream_bad_magic");
                    continue;
                }
                if (!buf.subarray(0, 4).equals(STREAM_MAGIC)) {
                    throw new Error("qwen3_stream_bad_magic");
                }
                buf = buf.subarray(4);
                magic = true;
            }
            while (buf.length >= 4) {
                const n = buf.readUInt32BE(0);
                if (n <= 0 || n > 20_000_000)
                    throw new Error("qwen3_stream_bad_len");
                if (buf.length < 4 + n)
                    break;
                yield Buffer.from(buf.subarray(4, 4 + n));
                buf = buf.subarray(4 + n);
            }
            if (done) {
                if (buf.length)
                    throw new Error("qwen3_stream_truncated");
                break;
            }
        }
    }
    finally {
        try {
            reader.releaseLock();
        }
        catch {
            /* ignore */
        }
    }
}
async function* iterateQwen3StreamWavs(request) {
    const root = qwen3BaseUrl(request.qwen3TtsUrl);
    const streamUrl = `${root}/tts/stream`;
    const tuned = splitSpeakingRateInstruct(request.instruct);
    const body = qwen3JsonBody(request);
    const t0 = performance.now();
    let first = true;
    log_1.log.info({
        event: "tts_request",
        provider: "qwen3_tts_http",
        endpoint_kind: "stream",
        speaker: request.speaker ?? null,
        language: request.language ?? null,
        rate: tuned.rate ?? null,
        marker: "VERA_DEMO_SHOP_QWEN3_STREAM_20260908",
    }, "qwen3 tts stream request");
    try {
        const response = await (0, httpClient_1.fetchWithTimeoutRetry)(streamUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
            timeoutMs: 180_000,
            retries: 0,
        });
        const contentType = response.headers.get("content-type") ?? "";
        if (!response.ok || contentType.includes("application/json")) {
            const raw = Buffer.from(await response.arrayBuffer()).toString("utf8");
            log_1.log.warn({
                status: response.status,
                body: raw.slice(0, 400),
                event: "qwen3_stream_fallback",
            }, "qwen3 stream failed; falling back to /tts");
            const full = await synthesizeSpeechQwen3(request);
            yield full.audio;
            return;
        }
        for await (const wav of iterateVlx1FromResponse(response)) {
            if (first) {
                first = false;
                log_1.log.info({
                    event: "qwen3_stream_first_chunk",
                    marker: "VERA_DEMO_SHOP_QWEN3_STREAM_20260908",
                    ttfc_ms: Math.round(performance.now() - t0),
                    bytes: wav.length,
                }, "qwen3 stream first chunk");
            }
            yield applyWavSpeakingRate(wav, tuned.rate);
        }
    }
    catch (error) {
        if (!first)
            throw error;
        log_1.log.warn({ err: error, event: "qwen3_stream_fallback" }, "qwen3 stream error; falling back to /tts");
        const full = await synthesizeSpeechQwen3(request);
        yield full.audio;
    }
}
async function collectQwen3StreamWavs(request) {
    const wavs = [];
    for await (const wav of iterateQwen3StreamWavs(request)) {
        wavs.push(wav);
    }
    return wavs;
}
async function synthesizeSpeechQwen3(request) {
    const root = qwen3BaseUrl(request.qwen3TtsUrl);
    const endpoint = `${root}/tts`;
    const genJson = request.gen ? qwen3GenToJsonBody(request.gen) : {};
    const tuned = splitSpeakingRateInstruct(request.instruct);
    log_1.log.info({
        event: "tts_request",
        provider: "qwen3_tts_http",
        speaker: request.speaker ?? null,
        language: request.language ?? null,
        rate: tuned.rate ?? null,
        gen: Object.keys(genJson).length ? genJson : null,
    }, "qwen3 tts request");
    const body = {
        text: request.text,
        speaker: request.speaker,
        language: request.language,
        instruct: tuned.instruct,
        ...genJson,
    };
    const response = await (0, httpClient_1.fetchWithTimeoutRetry)(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        timeoutMs: 180_000,
        retries: 0,
    });
    const contentType = response.headers.get("content-type") ?? "";
    const arrayBuffer = await response.arrayBuffer();
    const raw = Buffer.from(arrayBuffer);
    if (!response.ok) {
        const bodyText = raw.toString("utf8");
        log_1.log.error({ status: response.status, body: bodyText.slice(0, 500) }, "qwen3 tts error");
        throw new Error(`qwen3 tts error ${response.status}`);
    }
    return {
        audio: applyWavSpeakingRate(raw, tuned.rate),
        contentType: contentType || "audio/wav",
    };
}
