import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AEC_TAP_SAMPLE_RATE_HZ,
  AUDIO_INVARIANT_MARKER,
  buildAudioInvariantReport,
  classifyDecodeFailure,
  clearAudioInvariantCounters,
  emptyAudioInvariantCounters,
  recordDecodeFailure,
  recordDecodeOk,
  snapshotAudioInvariantCounters,
} from '../src/observability/audioInvariantReport';

test('AMR-WB 5–7 byte payloads are SID, not speech decode fails', () => {
  assert.equal(classifyDecodeFailure('AMR-WB', 5), 'sid');
  assert.equal(classifyDecodeFailure('AMR-WB', 7), 'sid');
  assert.equal(classifyDecodeFailure('AMR-WB', 33), 'speech');
  assert.equal(classifyDecodeFailure('PCMU', 7), 'speech');
});

test('SID ticks within budget are not a product-class fail', () => {
  const counters = emptyAudioInvariantCounters();
  counters.decodeOk = 400;
  counters.decodeFailuresSid = 4;
  const report = buildAudioInvariantReport({
    counters,
    callDurationMs: 90_000,
    playbackPstnSampleRateHz: 16000,
    aecEnabled: true,
    transportMode: 'pstn',
  });
  assert.equal(report.verdict, 'sid_budget');
  assert.equal(report.productClassFail, false);
  assert.equal(report.sidWithinBudget, true);
  assert.equal(report.rateMismatch, false);
  assert.deepEqual(report.fails, []);
  assert.equal(report.marker, AUDIO_INVARIANT_MARKER);
});

test('stacked play is a product-class fail', () => {
  const counters = emptyAudioInvariantCounters();
  counters.playStarts = 2;
  counters.stackedPlayWhileActive = 1;
  const report = buildAudioInvariantReport({
    counters,
    callDurationMs: 30_000,
    playbackPstnSampleRateHz: 16000,
    aecEnabled: true,
    transportMode: 'pstn',
  });
  assert.equal(report.verdict, 'fail');
  assert.equal(report.productClassFail, true);
  assert.ok(report.fails.includes('stacked_play'));
});

test('24 kHz play vs 16 kHz AEC tap is rate_mismatch', () => {
  const report = buildAudioInvariantReport({
    counters: emptyAudioInvariantCounters(),
    callDurationMs: 20_000,
    playbackPstnSampleRateHz: 24000,
    aecEnabled: true,
    transportMode: 'pstn',
  });
  assert.equal(report.rateMismatch, true);
  assert.ok(report.fails.includes('rate_mismatch'));
  assert.equal(report.aecTapSampleRateHz, AEC_TAP_SAMPLE_RATE_HZ);
});

test('16 kHz play with AEC is not a rate mismatch', () => {
  const report = buildAudioInvariantReport({
    counters: emptyAudioInvariantCounters(),
    callDurationMs: 20_000,
    playbackPstnSampleRateHz: 16000,
    aecEnabled: true,
    transportMode: 'pstn',
  });
  assert.equal(report.rateMismatch, false);
  assert.equal(report.verdict, 'pass');
});

test('speech decode spike is a fail; SID is not mixed in', () => {
  const counters = emptyAudioInvariantCounters();
  counters.decodeOk = 100;
  counters.decodeFailuresSid = 4;
  counters.decodeFailuresSpeech = 10;
  const report = buildAudioInvariantReport({
    counters,
    callDurationMs: 60_000,
    playbackPstnSampleRateHz: 16000,
    aecEnabled: true,
    transportMode: 'pstn',
  });
  assert.ok(report.fails.includes('speech_decode_spike'));
  assert.equal(report.productClassFail, true);
});

test('registry classifies SID vs speech on the same call id', () => {
  const id = 'v3:audioinv-test';
  clearAudioInvariantCounters(id);
  recordDecodeOk(id);
  recordDecodeFailure(id, 'AMR-WB', 7);
  recordDecodeFailure(id, 'AMR-WB', 40);
  const snap = snapshotAudioInvariantCounters(id);
  assert.equal(snap.decodeOk, 1);
  assert.equal(snap.decodeFailuresSid, 1);
  assert.equal(snap.decodeFailuresSpeech, 1);
  clearAudioInvariantCounters(id);
});
