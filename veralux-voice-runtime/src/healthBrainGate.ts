/**
 * Strict-mode /health/voice brain HTTP gating.
 * Brain sidecar (profile `llm`) is optional for many deployments; a template BRAIN_URL must not
 * fail readiness unless the operator explicitly requires it.
 */

export type StrictVoiceBrainPlan =
  | { action: 'probe'; url: string }
  | {
      action: 'skip';
      status: 'not_configured' | 'skipped_optional' | 'skipped_local';
      reason: string;
    };

export type BrainVoiceCheckPayload =
  | { ok: true; status: 'not_configured'; reason: string }
  | { ok: true; status: 'skipped_optional'; reason: string }
  | { ok: true; status: 'skipped_local'; reason: string }
  | { ok: true; status: 'ok'; latency_ms?: number }
  | { ok: false; status: 'failed'; error?: string; latency_ms?: number };

export type UrlCheckResult = { ok: boolean; latency_ms?: number; error?: string };

export function resolveStrictVoiceBrainPlan(args: {
  brainUseLocal: boolean;
  brainHealthRequired: boolean;
  llmHealthUrl?: string;
  derivedBrainHealthUrl?: string;
}): StrictVoiceBrainPlan {
  if (args.brainUseLocal) {
    return {
      action: 'skip',
      status: 'skipped_local',
      reason: 'BRAIN_USE_LOCAL=true',
    };
  }
  const explicit = args.llmHealthUrl?.trim() ?? '';
  const derived = args.derivedBrainHealthUrl?.trim() ?? '';
  const url = explicit || derived;
  if (!url) {
    return {
      action: 'skip',
      status: 'not_configured',
      reason: 'no_brain_http_health_target',
    };
  }
  if (!args.brainHealthRequired) {
    return {
      action: 'skip',
      status: 'skipped_optional',
      reason: 'BRAIN_HEALTH_REQUIRED=false',
    };
  }
  return { action: 'probe', url };
}

export async function executeStrictVoiceBrainGate(
  plan: StrictVoiceBrainPlan,
  checkUrl: (url: string, timeout?: number) => Promise<UrlCheckResult>,
): Promise<{ brainCheck: BrainVoiceCheckPayload; brainOk: boolean; brainChecked: boolean }> {
  if (plan.action === 'skip') {
    return {
      brainOk: true,
      brainChecked: false,
      brainCheck: { ok: true, status: plan.status, reason: plan.reason },
    };
  }
  const b = await checkUrl(plan.url);
  if (b.ok) {
    return {
      brainOk: true,
      brainChecked: true,
      brainCheck: { ok: true, status: 'ok', latency_ms: b.latency_ms },
    };
  }
  return {
    brainOk: false,
    brainChecked: true,
    brainCheck: { ok: false, status: 'failed', error: b.error, latency_ms: b.latency_ms },
  };
}

/** Aggregate strict voice-plane readiness (Redis + STT + TTS + optional-required brain). */
export function voiceStrictPlaneReady(args: {
  redisOk: boolean;
  sttOk: boolean;
  ttsOk: boolean;
  brainOk: boolean;
  /** When false, strict readiness fails (e.g. platform OpenAI selected but OPENAI_API_KEY is placeholder). */
  platformOpenaiOk?: boolean;
}): boolean {
  const oa = args.platformOpenaiOk ?? true;
  return args.redisOk && args.sttOk && args.ttsOk && args.brainOk && oa;
}
