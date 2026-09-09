import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCallQualitySummaryPayload } from '../src/observability/callQualitySummary';
import { buildAudioInvariantReport, emptyAudioInvariantCounters } from '../src/observability/audioInvariantReport';

const baseOpts = {
  tenantId: 'demo-shop',
  transcript: {
    callControlId: 'v3:audioinv',
    tenantId: 'demo-shop',
    startedAt: new Date().toISOString(),
    endedAt: new Date().toISOString(),
    durationMs: 30000,
    turns: [{ role: 'user' as const, content: 'hi', timestamp: new Date().toISOString() }],
  },
  metrics: {
    createdAt: new Date(),
    turns: 1,
    transcriptsTotal: 1,
    transcriptsEmpty: 0,
    totalUtteranceMs: 800,
    totalTranscribedChars: 2,
  },
  qualitySignals: {
    assistantEchoRejected: 0,
    transcriptNearDuplicateRejected: 0,
    bargeInDuringPlayback: 0,
    deadAirFired: 0,
    transcriptDeferred: 0,
    sttLatencyMs: [200],
    ttsLatencyMs: [300],
    llmLatencyMs: [400],
  },
  forensics: null,
  teardownReason: 'hangup',
};

test('quality summary persists audioInvariants and marks stacked play poor', () => {
  const audioInvariants = buildAudioInvariantReport({
    counters: { ...emptyAudioInvariantCounters(), stackedPlayWhileActive: 1, playStarts: 2 },
    callDurationMs: 30000,
    playbackPstnSampleRateHz: 16000,
    aecEnabled: true,
    transportMode: 'pstn',
  });
  const payload = buildCallQualitySummaryPayload({
    ...baseOpts,
    qualitySignals: { ...baseOpts.qualitySignals, audioInvariants },
  });
  assert.equal(payload.qualityStatus, 'poor');
  assert.ok(Array.isArray(payload.notes) && payload.notes.includes('audio_invariant:stacked_play'));
  const stored = payload.audioInvariants as { productClassFail: boolean; fails: string[] };
  assert.equal(stored.productClassFail, true);
  assert.ok(stored.fails.includes('stacked_play'));
});
