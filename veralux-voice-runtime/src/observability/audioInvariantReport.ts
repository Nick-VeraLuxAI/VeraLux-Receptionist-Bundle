/**
 * Per-call audio invariant scorecard.
 *
 * Measure and classify only. Does not retune AMR-WB decode, AEC, or codec.
 * SID / comfort-noise ticks are a budget. Product-class fails are stacked play,
 * playback/AEC rate mismatch, speech-decode spikes, and large sequence gaps.
 */

export const AUDIO_INVARIANT_MARKER = 'VERA_DEMO_SHOP_AUDIOINV_20260907';
export const AEC_TAP_SAMPLE_RATE_HZ = 16000;
/** AMR-WB SID / NO_DATA packets Telnyx sends as ~5–7 bytes (TOC + SID). */
export const SID_PAYLOAD_MAX_BYTES = 7;
/** SID frames per minute of call that stay in budget (not a product fail). */
export const SID_BUDGET_PER_MINUTE = 8;
export const SPEECH_DECODE_FAIL_MIN = 8;
export const SPEECH_DECODE_FAIL_RATE = 0.05;
export const SEQ_GAP_FAIL_FRAMES = 25;

export type DecodeFailureKind = 'sid' | 'speech';

export type AudioInvariantCounters = {
  decodeOk: number;
  decodeFailuresSid: number;
  decodeFailuresSpeech: number;
  seqGapFrames: number;
  playStarts: number;
  staleEpochDrops: number;
  stackedPlayWhileActive: number;
};

export type AudioInvariantVerdict = 'pass' | 'sid_budget' | 'fail';

export type AudioInvariantReport = {
  marker: string;
  decodeOk: number;
  decodeFailuresSid: number;
  decodeFailuresSpeech: number;
  seqGapFrames: number;
  playStarts: number;
  staleEpochDrops: number;
  stackedPlayWhileActive: number;
  playbackPstnSampleRateHz: number | null;
  aecTapSampleRateHz: number;
  aecEnabled: boolean;
  transportMode: string | null;
  rateMismatch: boolean;
  sidWithinBudget: boolean;
  productClassFail: boolean;
  verdict: AudioInvariantVerdict;
  fails: string[];
};

export function emptyAudioInvariantCounters(): AudioInvariantCounters {
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

export function classifyDecodeFailure(encoding: string, payloadBytes: number): DecodeFailureKind {
  const codec = String(encoding || '').toUpperCase();
  if (codec === 'AMR-WB' && payloadBytes > 0 && payloadBytes <= SID_PAYLOAD_MAX_BYTES) {
    return 'sid';
  }
  return 'speech';
}

const registries = new Map<string, AudioInvariantCounters>();

export function getAudioInvariantCounters(callControlId: string): AudioInvariantCounters {
  let row = registries.get(callControlId);
  if (!row) {
    row = emptyAudioInvariantCounters();
    registries.set(callControlId, row);
  }
  return row;
}

export function recordDecodeOk(callControlId: string): void {
  getAudioInvariantCounters(callControlId).decodeOk += 1;
}

export function recordDecodeFailure(
  callControlId: string,
  encoding: string,
  payloadBytes: number,
): void {
  const row = getAudioInvariantCounters(callControlId);
  if (classifyDecodeFailure(encoding, payloadBytes) === 'sid') row.decodeFailuresSid += 1;
  else row.decodeFailuresSpeech += 1;
}

export function recordSeqGap(callControlId: string, gapFrames: number): void {
  if (!Number.isFinite(gapFrames) || gapFrames <= 0) return;
  getAudioInvariantCounters(callControlId).seqGapFrames += Math.floor(gapFrames);
}

export function recordPlayStart(callControlId: string): void {
  getAudioInvariantCounters(callControlId).playStarts += 1;
}

export function recordStaleEpochDrop(callControlId: string): void {
  getAudioInvariantCounters(callControlId).staleEpochDrops += 1;
}

export function recordStackedPlay(callControlId: string): void {
  getAudioInvariantCounters(callControlId).stackedPlayWhileActive += 1;
}

export function snapshotAudioInvariantCounters(callControlId: string): AudioInvariantCounters {
  return { ...getAudioInvariantCounters(callControlId) };
}

export function clearAudioInvariantCounters(callControlId: string): void {
  registries.delete(callControlId);
}

export function buildAudioInvariantReport(opts: {
  counters: AudioInvariantCounters;
  callDurationMs: number;
  playbackPstnSampleRateHz?: number | null;
  aecEnabled?: boolean;
  transportMode?: string | null;
}): AudioInvariantReport {
  const c = opts.counters;
  const durationMs = Math.max(0, Number(opts.callDurationMs) || 0);
  const durationMin = Math.max(durationMs / 60000, 1 / 60);
  const sidPerMin = c.decodeFailuresSid / durationMin;
  const sidWithinBudget = sidPerMin <= SID_BUDGET_PER_MINUTE;
  const decodedAttempts = c.decodeOk + c.decodeFailuresSpeech;
  const speechRate = decodedAttempts > 0 ? c.decodeFailuresSpeech / decodedAttempts : 0;
  const speechSpike =
    c.decodeFailuresSpeech >= SPEECH_DECODE_FAIL_MIN ||
    (c.decodeFailuresSpeech >= 3 && speechRate >= SPEECH_DECODE_FAIL_RATE);
  const aecEnabled = opts.aecEnabled === true;
  const transportMode = opts.transportMode ?? null;
  const playbackPstnSampleRateHz =
    typeof opts.playbackPstnSampleRateHz === 'number' && Number.isFinite(opts.playbackPstnSampleRateHz)
      ? opts.playbackPstnSampleRateHz
      : null;
  const rateMismatch =
    aecEnabled &&
    transportMode === 'pstn' &&
    playbackPstnSampleRateHz != null &&
    playbackPstnSampleRateHz !== AEC_TAP_SAMPLE_RATE_HZ;

  const fails: string[] = [];
  if (c.stackedPlayWhileActive > 0) fails.push('stacked_play');
  if (rateMismatch) fails.push('rate_mismatch');
  if (speechSpike) fails.push('speech_decode_spike');
  if (c.seqGapFrames >= SEQ_GAP_FAIL_FRAMES) fails.push('seq_gap_spike');

  const productClassFail = fails.length > 0;
  let verdict: AudioInvariantVerdict = 'pass';
  if (productClassFail) verdict = 'fail';
  else if (c.decodeFailuresSid > 0) verdict = 'sid_budget';

  return {
    marker: AUDIO_INVARIANT_MARKER,
    decodeOk: c.decodeOk,
    decodeFailuresSid: c.decodeFailuresSid,
    decodeFailuresSpeech: c.decodeFailuresSpeech,
    seqGapFrames: c.seqGapFrames,
    playStarts: c.playStarts,
    staleEpochDrops: c.staleEpochDrops,
    stackedPlayWhileActive: c.stackedPlayWhileActive,
    playbackPstnSampleRateHz,
    aecTapSampleRateHz: AEC_TAP_SAMPLE_RATE_HZ,
    aecEnabled,
    transportMode,
    rateMismatch,
    sidWithinBudget,
    productClassFail,
    verdict,
    fails,
  };
}
