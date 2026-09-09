"use strict";
/**
 * Per-call audio invariant scorecard.
 *
 * Measure and classify only. Does not retune AMR-WB decode, AEC, or codec.
 * SID / comfort-noise ticks are a budget. Product-class fails are stacked play,
 * playback/AEC rate mismatch, speech-decode spikes, and large sequence gaps.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.SEQ_GAP_FAIL_FRAMES = exports.SPEECH_DECODE_FAIL_RATE = exports.SPEECH_DECODE_FAIL_MIN = exports.SID_BUDGET_PER_MINUTE = exports.SID_PAYLOAD_MAX_BYTES = exports.AEC_TAP_SAMPLE_RATE_HZ = exports.AUDIO_INVARIANT_MARKER = void 0;
exports.emptyAudioInvariantCounters = emptyAudioInvariantCounters;
exports.classifyDecodeFailure = classifyDecodeFailure;
exports.getAudioInvariantCounters = getAudioInvariantCounters;
exports.recordDecodeOk = recordDecodeOk;
exports.recordDecodeFailure = recordDecodeFailure;
exports.recordSeqGap = recordSeqGap;
exports.recordPlayStart = recordPlayStart;
exports.recordStaleEpochDrop = recordStaleEpochDrop;
exports.recordStackedPlay = recordStackedPlay;
exports.snapshotAudioInvariantCounters = snapshotAudioInvariantCounters;
exports.clearAudioInvariantCounters = clearAudioInvariantCounters;
exports.buildAudioInvariantReport = buildAudioInvariantReport;
exports.AUDIO_INVARIANT_MARKER = 'VERA_DEMO_SHOP_AUDIOINV_20260907';
exports.AEC_TAP_SAMPLE_RATE_HZ = 16000;
/** AMR-WB SID / NO_DATA packets Telnyx sends as ~5–7 bytes (TOC + SID). */
exports.SID_PAYLOAD_MAX_BYTES = 7;
/** SID frames per minute of call that stay in budget (not a product fail). */
exports.SID_BUDGET_PER_MINUTE = 8;
exports.SPEECH_DECODE_FAIL_MIN = 8;
exports.SPEECH_DECODE_FAIL_RATE = 0.05;
exports.SEQ_GAP_FAIL_FRAMES = 25;
function emptyAudioInvariantCounters() {
    return {
        decodeOk: 0,
        decodeFailuresSid: 0,
        decodeFailuresSpeech: 0,
        seqGapFrames: 0,
        playStarts: 0,
        staleEpochDrops: 0,
        stackedPlayWhileActive: 0,
    };
}
function classifyDecodeFailure(encoding, payloadBytes) {
    const codec = String(encoding || '').toUpperCase();
    if (codec === 'AMR-WB' && payloadBytes > 0 && payloadBytes <= exports.SID_PAYLOAD_MAX_BYTES) {
        return 'sid';
    }
    return 'speech';
}
const registries = new Map();
function getAudioInvariantCounters(callControlId) {
    let row = registries.get(callControlId);
    if (!row) {
        row = emptyAudioInvariantCounters();
        registries.set(callControlId, row);
    }
    return row;
}
function recordDecodeOk(callControlId) {
    getAudioInvariantCounters(callControlId).decodeOk += 1;
}
function recordDecodeFailure(callControlId, encoding, payloadBytes) {
    const row = getAudioInvariantCounters(callControlId);
    if (classifyDecodeFailure(encoding, payloadBytes) === 'sid')
        row.decodeFailuresSid += 1;
    else
        row.decodeFailuresSpeech += 1;
}
function recordSeqGap(callControlId, gapFrames) {
    if (!Number.isFinite(gapFrames) || gapFrames <= 0)
        return;
    getAudioInvariantCounters(callControlId).seqGapFrames += Math.floor(gapFrames);
}
function recordPlayStart(callControlId) {
    getAudioInvariantCounters(callControlId).playStarts += 1;
}
function recordStaleEpochDrop(callControlId) {
    getAudioInvariantCounters(callControlId).staleEpochDrops += 1;
}
function recordStackedPlay(callControlId) {
    getAudioInvariantCounters(callControlId).stackedPlayWhileActive += 1;
}
function snapshotAudioInvariantCounters(callControlId) {
    return { ...getAudioInvariantCounters(callControlId) };
}
function clearAudioInvariantCounters(callControlId) {
    registries.delete(callControlId);
}
function buildAudioInvariantReport(opts) {
    const c = opts.counters;
    const durationMs = Math.max(0, Number(opts.callDurationMs) || 0);
    const durationMin = Math.max(durationMs / 60000, 1 / 60);
    const sidPerMin = c.decodeFailuresSid / durationMin;
    const sidWithinBudget = sidPerMin <= exports.SID_BUDGET_PER_MINUTE;
    const decodedAttempts = c.decodeOk + c.decodeFailuresSpeech;
    const speechRate = decodedAttempts > 0 ? c.decodeFailuresSpeech / decodedAttempts : 0;
    const speechSpike = c.decodeFailuresSpeech >= exports.SPEECH_DECODE_FAIL_MIN ||
        (c.decodeFailuresSpeech >= 3 && speechRate >= exports.SPEECH_DECODE_FAIL_RATE);
    const aecEnabled = opts.aecEnabled === true;
    const transportMode = opts.transportMode ?? null;
    const playbackPstnSampleRateHz = typeof opts.playbackPstnSampleRateHz === 'number' && Number.isFinite(opts.playbackPstnSampleRateHz)
        ? opts.playbackPstnSampleRateHz
        : null;
    const rateMismatch = aecEnabled &&
        transportMode === 'pstn' &&
        playbackPstnSampleRateHz != null &&
        playbackPstnSampleRateHz !== exports.AEC_TAP_SAMPLE_RATE_HZ;
    const fails = [];
    if (c.stackedPlayWhileActive > 0)
        fails.push('stacked_play');
    if (rateMismatch)
        fails.push('rate_mismatch');
    if (speechSpike)
        fails.push('speech_decode_spike');
    if (c.seqGapFrames >= exports.SEQ_GAP_FAIL_FRAMES)
        fails.push('seq_gap_spike');
    const productClassFail = fails.length > 0;
    let verdict = 'pass';
    if (productClassFail)
        verdict = 'fail';
    else if (c.decodeFailuresSid > 0)
        verdict = 'sid_budget';
    return {
        marker: exports.AUDIO_INVARIANT_MARKER,
        decodeOk: c.decodeOk,
        decodeFailuresSid: c.decodeFailuresSid,
        decodeFailuresSpeech: c.decodeFailuresSpeech,
        seqGapFrames: c.seqGapFrames,
        playStarts: c.playStarts,
        staleEpochDrops: c.staleEpochDrops,
        stackedPlayWhileActive: c.stackedPlayWhileActive,
        playbackPstnSampleRateHz,
        aecTapSampleRateHz: exports.AEC_TAP_SAMPLE_RATE_HZ,
        aecEnabled,
        transportMode,
        rateMismatch,
        sidWithinBudget,
        productClassFail,
        verdict,
        fails,
    };
}
//# sourceMappingURL=audioInvariantReport.js.map