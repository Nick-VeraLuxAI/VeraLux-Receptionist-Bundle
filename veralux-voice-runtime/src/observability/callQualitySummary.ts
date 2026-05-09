import fs from 'fs';
import path from 'path';
import type { CallSessionMetrics, CallTranscript } from '../calls/types';
import type { AudioForensicsSession } from './audioForensics';
import { mergeCallQualityDefaults } from './callQualityPolicy';
import type { RuntimeTenantConfig } from '@veralux/shared';

export type QualitySignalsSnapshot = {
  assistantEchoRejected: number;
  transcriptNearDuplicateRejected: number;
  bargeInDuringPlayback: number;
  deadAirFired: number;
  transcriptDeferred: number;
  sttLatencyMs: number[];
  ttsLatencyMs: number[];
  llmLatencyMs: number[];
};

function avg(nums: number[]): number | null {
  if (!nums.length) return null;
  return Math.round(nums.reduce((a, b) => a + b, 0) / nums.length);
}

function readTimelineAggregates(timelinePath: string): {
  assistantEchoRejectedCount: number;
  postPlaybackFrameDropped: number;
  postPlaybackFrameReleased: number;
} | null {
  try {
    if (!fs.existsSync(timelinePath)) return null;
    const raw = fs.readFileSync(timelinePath, 'utf8');
    let assistantEchoRejectedCount = 0;
    let postPlaybackFrameDropped = 0;
    let postPlaybackFrameReleased = 0;
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const j = JSON.parse(line) as { event?: string };
        if (j.event === 'transcript_rejected_assistant_echo') assistantEchoRejectedCount += 1;
        if (j.event === 'post_playback_frame_dropped') postPlaybackFrameDropped += 1;
        if (j.event === 'post_playback_frame_released') postPlaybackFrameReleased += 1;
      } catch {
        continue;
      }
    }
    return { assistantEchoRejectedCount, postPlaybackFrameDropped, postPlaybackFrameReleased };
  } catch {
    return null;
  }
}

function riskFromLatencyMs(
  avgMs: number | null,
  thresholds: { warn: number; poor: number },
): 'low' | 'medium' | 'high' {
  if (avgMs == null || !Number.isFinite(avgMs)) return 'low';
  if (avgMs <= thresholds.warn) return 'low';
  if (avgMs <= thresholds.poor) return 'medium';
  return 'high';
}

/** Build per-call quality summary for control plane storage (no secrets, no provider URLs). */
export function buildCallQualitySummaryPayload(opts: {
  tenantId?: string;
  tenantConfig?: RuntimeTenantConfig | null;
  transcript: CallTranscript;
  metrics: CallSessionMetrics;
  qualitySignals: QualitySignalsSnapshot;
  forensics: AudioForensicsSession | null;
  teardownReason?: string;
}): Record<string, unknown> {
  const cq = mergeCallQualityDefaults(opts.tenantConfig?.callQuality);
  const timelinePath = opts.forensics ? path.join(opts.forensics.sessionDir, 'timeline.jsonl') : '';
  const tl = timelinePath ? readTimelineAggregates(timelinePath) : null;

  const assistantEchoRejectedCount = Math.max(
    opts.qualitySignals.assistantEchoRejected,
    tl?.assistantEchoRejectedCount ?? 0,
  );
  const postPlaybackFrameDropped = tl?.postPlaybackFrameDropped ?? 0;
  const postPlaybackFrameReleased = tl?.postPlaybackFrameReleased ?? 0;

  const userTurns = opts.transcript.turns.filter(t => t.role === 'user').length;
  const transcriptAcceptedCount = userTurns;
  const transcriptRejectedCount =
    opts.qualitySignals.assistantEchoRejected +
    opts.qualitySignals.transcriptNearDuplicateRejected +
    Math.max(0, opts.metrics.transcriptsEmpty);

  const avgStt = avg(opts.qualitySignals.sttLatencyMs);
  const avgLlm = avg(opts.qualitySignals.llmLatencyMs);
  const avgTts = avg(opts.qualitySignals.ttsLatencyMs);

  const latencyRisk: 'low' | 'medium' | 'high' = (() => {
    const parts: ('low' | 'medium' | 'high')[] = [];
    if (avgStt != null) parts.push(riskFromLatencyMs(avgStt, { warn: 900, poor: 2500 }));
    if (avgLlm != null) parts.push(riskFromLatencyMs(avgLlm, { warn: 1500, poor: 6000 }));
    if (avgTts != null) parts.push(riskFromLatencyMs(avgTts, { warn: 800, poor: 3000 }));
    if (!parts.length) return 'low';
    if (parts.includes('high')) return 'high';
    if (parts.includes('medium')) return 'medium';
    return 'low';
  })();

  const echoRisk: 'low' | 'medium' | 'high' =
    assistantEchoRejectedCount >= 3 ? 'high' : assistantEchoRejectedCount >= 1 ? 'medium' : 'low';

  const missedSpeechRisk: 'low' | 'medium' | 'high' =
    opts.metrics.transcriptsEmpty >= 3
      ? 'high'
      : opts.metrics.transcriptsEmpty >= 1
        ? 'medium'
        : 'low';

  const transcriptQuality: 'good' | 'medium' | 'poor' | 'unknown' =
    opts.metrics.transcriptsTotal === 0
      ? 'unknown'
      : opts.metrics.transcriptsEmpty / Math.max(1, opts.metrics.transcriptsTotal) > 0.35
        ? 'poor'
        : opts.metrics.transcriptsEmpty > 0
          ? 'medium'
          : 'good';

  const interruptionDetected = opts.qualitySignals.bargeInDuringPlayback > 0;
  const deadAirDetected = opts.qualitySignals.deadAirFired > 0;

  const notes: string[] = [];
  if (opts.teardownReason && opts.teardownReason !== 'hangup' && opts.teardownReason !== 'teardown') {
    notes.push(`call_end_reason:${opts.teardownReason}`);
  }
  if (opts.qualitySignals.transcriptDeferred > 0) {
    notes.push('transcript_deferred_during_playback');
  }

  let qualityStatus: 'good' | 'warning' | 'poor' | 'unknown' = 'good';
  if (
    latencyRisk === 'high' ||
    echoRisk === 'high' ||
    missedSpeechRisk === 'high' ||
    transcriptQuality === 'poor'
  ) {
    qualityStatus = 'poor';
  } else if (
    latencyRisk === 'medium' ||
    echoRisk === 'medium' ||
    missedSpeechRisk === 'medium' ||
    transcriptQuality === 'medium' ||
    interruptionDetected ||
    deadAirDetected
  ) {
    qualityStatus = 'warning';
  }

  return {
    callId: opts.transcript.callControlId,
    tenantId: opts.tenantId ?? opts.transcript.tenantId ?? null,
    startedAt: opts.transcript.startedAt,
    endedAt: opts.transcript.endedAt,
    durationSeconds: Math.max(0, Math.round((opts.transcript.durationMs ?? 0) / 1000)),
    qualityStatus,
    transcriptQuality,
    echoRisk,
    latencyRisk,
    missedSpeechRisk,
    interruptionDetected,
    deadAirDetected,
    assistantEchoRejectedCount,
    transcriptAcceptedCount,
    transcriptRejectedCount,
    whisperRequestCount: opts.metrics.transcriptsTotal,
    avgSttLatencyMs: avgStt,
    avgLlmLatencyMs: avgLlm,
    avgTtsLatencyMs: avgTts,
    postPlaybackFrameDropped,
    postPlaybackFrameReleased,
    callQualityAnalyticsEnabled: cq.callQualityAnalyticsEnabled,
    rawDiagnosticsSession: opts.forensics ? path.basename(opts.forensics.sessionDir) : null,
    notes,
  };
}
