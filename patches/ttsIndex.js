"use strict";
/**
 * Kokoro is the only live TTS path. Other engines are not called from here.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.synthesizeSpeech = synthesizeSpeech;
exports.tryPlayKokoroStreamToTelnyx = tryPlayKokoroStreamToTelnyx;
const kokoroStreamPlay_1 = require("./kokoroStreamPlay");
function tryPlayKokoroStreamToTelnyx(options) {
    return (0, kokoroStreamPlay_1.tryPlayKokoroStreamToTelnyx)(options);
}
const wavInfo_1 = require("../audio/wavInfo");
const env_1 = require("../env");
const log_1 = require("../log");
const cache_1 = require("./cache");
const kokoroTTS_1 = require("./kokoroTTS");
const KOKORO_VOICE = /^(a[fm]_|b[fm]_)[a-z]+$/i;
function forceKokoroTtsConfig(input) {
    const fromKokoro = input && input.mode === "kokoro_http" ? input : undefined;
    const kokoroUrl = (fromKokoro?.kokoroUrl || env_1.env.KOKORO_URL || "http://kokoro:7001/tts").trim();
    const candidate = fromKokoro?.voice || env_1.env.KOKORO_VOICE_ID || "af_bella";
    return {
        mode: "kokoro_http",
        kokoroUrl,
        voice: KOKORO_VOICE.test(String(candidate || "").trim()) ? candidate : env_1.env.KOKORO_VOICE_ID || "af_bella",
        format: "wav",
        sampleRate: fromKokoro?.sampleRate ?? env_1.env.TTS_SAMPLE_RATE,
        rate: fromKokoro?.rate ?? env_1.env.KOKORO_RATE,
    };
}
async function synthesizeSpeech(request, ttsConfig) {
    const config = forceKokoroTtsConfig(ttsConfig);
    const trimmedText = (request.text ?? "").trim();
    const cacheEligible = env_1.env.TTS_CACHE_ENABLED && trimmedText.length > 0;
    const cacheRedis = cacheEligible ? (0, cache_1.getTtsCacheRedisClient)() : null;
    const cacheHash = cacheEligible ? (0, cache_1.ttsCacheKeyHash)((0, cache_1.buildTtsCacheDescriptor)(request, config)) : "";
    if (cacheEligible) {
        const cached = await (0, cache_1.getCachedTts)(cacheHash, cacheRedis);
        if (cached)
            return cached;
    }
    const voice = KOKORO_VOICE.test(String(request.voice || "").trim()) ? request.voice : config.voice;
    const result = await (0, kokoroTTS_1.synthesizeSpeech)({
        text: request.text,
        voice,
        format: request.format ?? config.format,
        sampleRate: request.sampleRate ?? config.sampleRate,
        kokoroUrl: config.kokoroUrl ?? request.kokoroUrl,
        rate: request.rate ?? config.rate,
    });
    if (result.contentType?.toLowerCase().includes("wav") && result.audio.length >= 44) {
        try {
            const wavInfo = (0, wavInfo_1.parseWavInfo)(result.audio);
            log_1.log.info({ event: "tts_sample_rate", sample_rate_hz: wavInfo.sampleRateHz, provider: "kokoro_http" }, "TTS output sample rate");
        }
        catch { }
    }
    if (cacheEligible) {
        await (0, cache_1.setCachedTts)(cacheHash, result, cacheRedis);
    }
    return result;
}
