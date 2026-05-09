import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveRawForensicsCapture, mergeCallQualityDefaults } from '../src/observability/callQualityPolicy';

test('mergeCallQualityDefaults uses safe defaults', () => {
  const d = mergeCallQualityDefaults(undefined);
  assert.equal(d.rawAudioDiagnosticsMode, 'off');
  assert.equal(d.callQualityAnalyticsEnabled, true);
});

test('resolveRawForensicsCapture: no tenant config is off', () => {
  const r = resolveRawForensicsCapture(null);
  assert.equal(r.capture, false);
  assert.equal(r.operatorOverride, false);
});

test('resolveRawForensicsCapture: next_call pending enables tenant diagnostics', () => {
  const r = resolveRawForensicsCapture({
    contractVersion: 'v1',
    tenantId: 't1',
    dids: ['+15551234567'],
    caps: { maxConcurrentCallsTenant: 2, maxCallsPerMinuteTenant: 10 },
    stt: { mode: 'whisper_http', whisperUrl: 'http://x', chunkMs: 500 },
    tts: { mode: 'kokoro_http', kokoroUrl: 'http://y' },
    webhookSecret: 's',
    callQuality: {
      callQualityAnalyticsEnabled: true,
      transcriptStorageEnabled: true,
      transcriptRetentionDays: 30,
      rawAudioDiagnosticsMode: 'next_call_only',
      qualitySummaryVisibleToClient: true,
      rawArtifactsVisibleToClient: false,
      rawAudioDiagnosticsNextCallPending: true,
    },
  } as any);
  assert.equal(r.capture, true);
  assert.equal(r.tenantDiagnostics, true);
  assert.equal(r.operatorOverride, false);
});
