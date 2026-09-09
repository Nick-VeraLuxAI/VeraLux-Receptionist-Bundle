"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.KOKORO_VLX1_MAGIC = void 0;
exports.kokoroStreamUrl = kokoroStreamUrl;
exports.parseVlx1WavStream = parseVlx1WavStream;
exports.streamKokoroSpeech = streamKokoroSpeech;
const env_1 = require("../env");
const log_1 = require("../log");
const httpClient_1 = require("../httpClient");
exports.KOKORO_VLX1_MAGIC = Buffer.from('VLX1', 'ascii');
function kokoroStreamUrl(kokoroUrl) {
    const base = kokoroUrl.replace(/\/$/, '');
    if (base.endsWith('/tts/stream'))
        return base;
    if (base.endsWith('/tts'))
        return `${base}/stream`;
    return `${base}/tts/stream`;
}
/**
 * Incremental VLX1 parser: magic + repeated [u32be len][wav].
 */
async function* parseVlx1WavStream(reader) {
    const iterator = Symbol.asyncIterator in reader
        ? reader[Symbol.asyncIterator]()
        : streamToAsyncIterator(reader);
    let buf = Buffer.alloc(0);
    let magicOk = false;
    while (true) {
        const next = await iterator.next();
        if (!next.done && next.value) {
            buf = Buffer.concat([buf, Buffer.from(next.value)]);
        }
        if (!magicOk) {
            if (buf.length < 4) {
                if (next.done)
                    throw new Error('kokoro_stream_empty');
                continue;
            }
            if (!buf.subarray(0, 4).equals(exports.KOKORO_VLX1_MAGIC)) {
                throw new Error('kokoro_stream_bad_magic');
            }
            magicOk = true;
            buf = buf.subarray(4);
        }
        while (buf.length >= 4) {
            const segLen = buf.readUInt32BE(0);
            if (segLen <= 0 || segLen > 8000000) {
                throw new Error('kokoro_stream_bad_segment_len');
            }
            if (buf.length < 4 + segLen)
                break;
            yield Buffer.from(buf.subarray(4, 4 + segLen));
            buf = buf.subarray(4 + segLen);
        }
        if (next.done) {
            if (buf.length > 0)
                throw new Error('kokoro_stream_truncated');
            return;
        }
    }
}
function streamToAsyncIterator(stream) {
    const reader = stream.getReader();
    return {
        async next() {
            const result = await reader.read();
            if (result.done) {
                reader.releaseLock();
                return { done: true, value: undefined };
            }
            return { done: false, value: result.value };
        },
    };
}
async function* streamKokoroSpeech(request) {
    const kokoroUrl = request.kokoroUrl ?? env_1.env.KOKORO_URL;
    if (!kokoroUrl) {
        throw new Error('KOKORO_URL or request.kokoroUrl is required for Kokoro TTS');
    }
    const endpoint = kokoroStreamUrl(kokoroUrl);
    const payload = {
        text: request.text,
        voice: request.voice,
        format: request.format ?? 'wav',
        sampleRate: request.sampleRate ?? env_1.env.TTS_SAMPLE_RATE,
    };
    if (request.rate != null && Number.isFinite(request.rate)) {
        payload.rate = request.rate;
    }
    log_1.log.info({ event: 'tts_request', provider: 'kokoro_http', endpoint_kind: 'stream', voice: request.voice }, 'kokoro stream request');
    const response = await (0, httpClient_1.fetchWithTimeoutRetry)(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        timeoutMs: 60000,
        retries: 0,
        retryOnStatuses: [],
    });
    if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new Error(`kokoro stream error ${response.status} ${body.slice(0, 180)}`);
    }
    if (!response.body) {
        throw new Error('kokoro_stream_no_body');
    }
    yield* parseVlx1WavStream(response.body);
}
//# sourceMappingURL=kokoroStream.js.map