import { Router } from 'express';
import { getRedisClient } from '../redis/client';
import { env } from '../env';
import { log } from '../log';
import { incDependencyUnavailable } from '../metrics';
import {
  executeStrictVoiceBrainGate,
  resolveStrictVoiceBrainPlan,
  voiceStrictPlaneReady,
  type BrainVoiceCheckPayload,
} from '../healthBrainGate';
import {
  effectiveVoicePlatformLlmRaw,
  isDisallowedPlaceholderApiKey,
  normalizePlatformLlmKind,
} from '../ai/llmProviderResolve';

export const healthRouter = Router();

interface HealthStatus {
  status: 'ok' | 'degraded' | 'unhealthy';
  checks: {
    redis: { ok: boolean; latency_ms?: number; error?: string };
    whisper?: { ok: boolean; latency_ms?: number; error?: string };
    tts?: { ok: boolean; latency_ms?: number; error?: string };
  };
  uptime_seconds: number;
}

const startTime = Date.now();

function voiceDepsMode() {
  return env.HEALTH_VOICE_DEPENDENCIES;
}

async function checkRedis(): Promise<{ ok: boolean; latency_ms?: number; error?: string }> {
  const start = Date.now();
  try {
    const redis = getRedisClient();
    await redis.ping();
    return { ok: true, latency_ms: Date.now() - start };
  } catch (error) {
    incDependencyUnavailable('redis');
    return { ok: false, error: error instanceof Error ? error.message : 'unknown', latency_ms: Date.now() - start };
  }
}

async function checkUrl(url: string, timeout = 5000): Promise<{ ok: boolean; latency_ms?: number; error?: string }> {
  const start = Date.now();
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);
    const response = await fetch(url, { method: 'GET', signal: controller.signal });
    clearTimeout(timeoutId);
    return { ok: response.ok, latency_ms: Date.now() - start };
  } catch (error) {
    incDependencyUnavailable('provider_http');
    return { ok: false, error: error instanceof Error ? error.message : 'unknown', latency_ms: Date.now() - start };
  }
}

// Basic liveness probe (always returns 200 if process is running)
healthRouter.get('/live', (_req, res) => {
  res.status(200).json({ status: 'ok' });
});

function whisperHealthUrl(): string | undefined {
  if (!env.WHISPER_URL) return undefined;
  return env.WHISPER_URL.replace('/transcribe', '/health').replace('/v1/audio/transcriptions', '/health');
}

/**
 * GET /health on brain-gpt4o lives at the service root (not under /reply).
 * BRAIN_URL is often `http://brain:3001` or `http://brain:3001/reply` — normalize to base origin + `/health`.
 * When BRAIN_USE_LOCAL is true, the runtime does not call the HTTP brain; skip the probe so
 * a leftover BRAIN_URL does not fail readiness.
 */
function brainHealthUrl(): string | undefined {
  if (env.BRAIN_USE_LOCAL) return undefined;
  const raw = env.BRAIN_URL?.trim();
  if (!raw) return undefined;
  let base = raw.replace(/\/$/, '');
  if (base.endsWith('/reply/stream')) {
    base = base.replace(/\/reply\/stream$/, '');
  } else if (base.endsWith('/reply')) {
    base = base.replace(/\/reply$/, '');
  }
  try {
    const u = new URL(base);
    u.pathname = '/health';
    u.search = '';
    u.hash = '';
    return u.toString();
  } catch {
    return `${base}/health`;
  }
}

function ttsHealthUrl(): string | undefined {
  if (env.TTS_MODE === 'kokoro_http' && env.KOKORO_URL) {
    try {
      const u = new URL(env.KOKORO_URL);
      u.pathname = '/health';
      return u.toString();
    } catch {
      return env.KOKORO_URL.replace('/v1/kokoro', '/health');
    }
  }
  if (env.TTS_MODE === 'coqui_xtts' && env.COQUI_XTTS_URL) {
    const u = env.COQUI_XTTS_URL.replace(/\/tts\/?$/, '');
    return `${u}/health`;
  }
  if (env.TTS_MODE === 'chatterbox_http' && env.CHATTERBOX_URL) {
    const u = env.CHATTERBOX_URL.replace(/\/tts\/?$/, '');
    return `${u}/health`;
  }
  if (env.TTS_MODE === 'qwen3_tts_http' && env.QWEN3_TTS_URL) {
    const u = env.QWEN3_TTS_URL.replace(/\/tts\/?$/, '');
    return `${u}/health`;
  }
  return undefined;
}

function effectiveSttHealthUrl(): string | undefined {
  const explicit = env.STT_HEALTH_URL?.trim();
  if (explicit) return explicit;
  return whisperHealthUrl();
}

function effectiveTtsHealthUrl(): string | undefined {
  const explicit = env.TTS_HEALTH_URL?.trim();
  if (explicit) return explicit;
  return ttsHealthUrl();
}

function ttsConfigPresent(): boolean {
  return Boolean(ttsHealthUrl());
}

/** configured mode: STT/TTS env contract satisfied (URLs non-empty where required by env schema). */
function voiceConfigConfigured(): { ok: boolean; error?: string } {
  if (!env.WHISPER_URL?.trim()) return { ok: false, error: 'missing_whisper_url' };
  if (!ttsConfigPresent()) return { ok: false, error: 'missing_or_unsupported_tts_url' };
  return { ok: true };
}

/** Strict voice-plane readiness: Redis + STT/TTS HTTP health + brain HTTP only when BRAIN_HEALTH_REQUIRED=true. */
healthRouter.get('/voice', async (_req, res) => {
  const mode = voiceDepsMode();
  const redis = await checkRedis();

  if (mode === 'disabled') {
    const ready = redis.ok;
    return res.status(ready ? 200 : 503).json({
      status: ready ? 'ok' : 'not_ready',
      endpoint: '/health/voice',
      checks: { redis },
      voice_dependencies_checked: false,
      health_voice_dependency_mode: mode,
    });
  }

  if (mode === 'configured') {
    const cfg = voiceConfigConfigured();
    if (!cfg.ok || !redis.ok) {
      return res.status(503).json({
        status: 'not_ready',
        endpoint: '/health/voice',
        checks: { redis },
        error: cfg.error ?? 'redis_unavailable',
        voice_dependencies_checked: true,
        health_voice_dependency_mode: mode,
      });
    }
    const sttProbe = env.STT_HEALTH_URL?.trim();
    const ttsProbe = env.TTS_HEALTH_URL?.trim();
    const llmProbe = env.LLM_HEALTH_URL?.trim();
    const [stt, tts, llm] = await Promise.all([
      sttProbe ? checkUrl(sttProbe) : Promise.resolve({ ok: true, skipped: true as const }),
      ttsProbe ? checkUrl(ttsProbe) : Promise.resolve({ ok: true, skipped: true as const }),
      llmProbe ? checkUrl(llmProbe) : Promise.resolve({ ok: true, skipped: true as const }),
    ]);
    const sttOk = 'skipped' in stt ? true : stt.ok;
    const ttsOk = 'skipped' in tts ? true : tts.ok;
    const llmOk = 'skipped' in llm ? true : llm.ok;
    const ready = redis.ok && sttOk && ttsOk && llmOk;
    return res.status(ready ? 200 : 503).json({
      status: ready ? 'ok' : 'not_ready',
      endpoint: '/health/voice',
      checks: {
        redis,
        whisper: 'skipped' in stt ? { ok: true, mode: 'configured_not_probed' } : stt,
        tts: 'skipped' in tts ? { ok: true, mode: 'configured_not_probed' } : tts,
        ...(!('skipped' in llm) || llmProbe
          ? { brain: 'skipped' in llm ? { ok: true, mode: 'configured_not_probed' } : llm }
          : {}),
      },
      voice_dependencies_checked: true,
      health_voice_dependency_mode: mode,
    });
  }

  // strict
  const wUrl = effectiveSttHealthUrl();
  const tUrl = effectiveTtsHealthUrl();
  const brainPlan = resolveStrictVoiceBrainPlan({
    brainUseLocal: env.BRAIN_USE_LOCAL,
    brainHealthRequired: env.BRAIN_HEALTH_REQUIRED,
    llmHealthUrl: env.LLM_HEALTH_URL,
    derivedBrainHealthUrl: brainHealthUrl(),
  });

  if (!wUrl || !tUrl) {
    log.warn({ event: 'health_voice_misconfigured', whisper_configured: Boolean(wUrl), tts_configured: Boolean(tUrl) });
    return res.status(503).json({
      status: 'not_ready',
      endpoint: '/health/voice',
      checks: { redis },
      error: !wUrl ? 'missing_whisper_url' : 'missing_or_unsupported_tts_url',
      voice_dependencies_checked: true,
      health_voice_dependency_mode: mode,
    });
  }

  const [whisper, tts, brainOutcome] = await Promise.all([
    checkUrl(wUrl),
    checkUrl(tUrl),
    executeStrictVoiceBrainGate(brainPlan, checkUrl),
  ]);
  const platKind = normalizePlatformLlmKind(effectiveVoicePlatformLlmRaw());
  const openaiPlatformBad = platKind === 'openai' && isDisallowedPlaceholderApiKey(env.OPENAI_API_KEY);
  const checks: HealthStatus['checks'] & { brain?: BrainVoiceCheckPayload; openai_platform?: Record<string, unknown> } = {
    redis,
    whisper,
    tts,
    brain: brainOutcome.brainCheck,
    ...(platKind === 'openai'
      ? {
          openai_platform: openaiPlatformBad
            ? { ok: false, status: 'invalid_placeholder', reason: 'OPENAI_API_KEY_missing_or_placeholder' }
            : { ok: true, status: 'ok' },
        }
      : { openai_platform: { ok: true, status: 'not_applicable' } }),
  };

  const ready = voiceStrictPlaneReady({
    redisOk: redis.ok,
    sttOk: whisper.ok,
    ttsOk: tts.ok,
    brainOk: brainOutcome.brainOk,
    platformOpenaiOk: !openaiPlatformBad,
  });

  return res.status(ready ? 200 : 503).json({
    status: ready ? 'ok' : 'not_ready',
    endpoint: '/health/voice',
    checks,
    voice_dependencies_checked: true,
    brain_checked: brainOutcome.brainChecked,
    health_voice_dependency_mode: mode,
  });
});

healthRouter.get('/ready', async (_req, res) => {
  const mode = voiceDepsMode();
  const redis = await checkRedis();
  const checks: HealthStatus['checks'] = { redis };

  if (mode === 'disabled') {
    const ready = redis.ok;
    return res.status(ready ? 200 : 503).json({
      status: ready ? 'ok' : 'not_ready',
      checks: { redis },
      voice_dependencies_checked: false,
      health_voice_dependency_mode: mode,
    });
  }

  if (mode === 'configured') {
    const cfg = voiceConfigConfigured();
    if (!cfg.ok || !redis.ok) {
      return res.status(503).json({
        status: 'not_ready',
        checks: { redis },
        error: cfg.error ?? 'redis_unavailable',
        voice_dependencies_checked: true,
        health_voice_dependency_mode: mode,
      });
    }
    const sttProbe = env.STT_HEALTH_URL?.trim();
    const ttsProbe = env.TTS_HEALTH_URL?.trim();
    const llmProbe = env.LLM_HEALTH_URL?.trim();
    const [whisper, tts, brain] = await Promise.all([
      sttProbe ? checkUrl(sttProbe) : Promise.resolve({ ok: true, skipped: true as const }),
      ttsProbe ? checkUrl(ttsProbe) : Promise.resolve({ ok: true, skipped: true as const }),
      llmProbe ? checkUrl(llmProbe) : Promise.resolve(undefined),
    ]);
    if (whisper && !('skipped' in whisper)) checks.whisper = whisper;
    if (tts && !('skipped' in tts)) checks.tts = tts;
    const extras: Record<string, unknown> = { voice_dependencies_checked: true, health_voice_dependency_mode: mode };
    if (brain !== undefined && brain) {
      extras.brain_checked = Boolean(llmProbe);
      (checks as typeof checks & { brain?: { ok: boolean; latency_ms?: number; error?: string } }).brain = brain;
    }
    const sttOk = !whisper || 'skipped' in whisper || whisper.ok;
    const ttsOk = !tts || 'skipped' in tts || tts.ok;
    const brainOk = brain === undefined || brain.ok;
    const ready = redis.ok && sttOk && ttsOk && brainOk;
    return res.status(ready ? 200 : 503).json({
      status: ready ? 'ok' : 'not_ready',
      checks,
      ...extras,
    });
  }

  const wUrl = effectiveSttHealthUrl();
  const tUrl = effectiveTtsHealthUrl();
  const brainPlan = resolveStrictVoiceBrainPlan({
    brainUseLocal: env.BRAIN_USE_LOCAL,
    brainHealthRequired: env.BRAIN_HEALTH_REQUIRED,
    llmHealthUrl: env.LLM_HEALTH_URL,
    derivedBrainHealthUrl: brainHealthUrl(),
  });

  if (!wUrl || !tUrl) {
    return res.status(503).json({
      status: 'not_ready',
      checks: { redis },
      error: !wUrl ? 'missing_whisper_url' : 'missing_or_unsupported_tts_url',
      voice_dependencies_checked: true,
      health_voice_dependency_mode: mode,
    });
  }

  const [whisper, tts, brainOutcome] = await Promise.all([
    checkUrl(wUrl),
    checkUrl(tUrl),
    executeStrictVoiceBrainGate(brainPlan, checkUrl),
  ]);
  if (whisper) checks.whisper = whisper;
  if (tts) checks.tts = tts;
  (checks as typeof checks & { brain?: BrainVoiceCheckPayload }).brain = brainOutcome.brainCheck;
  const platKind = normalizePlatformLlmKind(effectiveVoicePlatformLlmRaw());
  const openaiPlatformBad = platKind === 'openai' && isDisallowedPlaceholderApiKey(env.OPENAI_API_KEY);
  (checks as typeof checks & { openai_platform?: Record<string, unknown> }).openai_platform =
    platKind === 'openai'
      ? openaiPlatformBad
        ? { ok: false, status: 'invalid_placeholder', reason: 'OPENAI_API_KEY_missing_or_placeholder' }
        : { ok: true, status: 'ok' }
      : { ok: true, status: 'not_applicable' };
  const extras: Record<string, unknown> = {
    voice_dependencies_checked: true,
    health_voice_dependency_mode: mode,
    brain_checked: brainOutcome.brainChecked,
  };

  const ready = voiceStrictPlaneReady({
    redisOk: redis.ok,
    sttOk: whisper.ok,
    ttsOk: tts.ok,
    brainOk: brainOutcome.brainOk,
    platformOpenaiOk: !openaiPlatformBad,
  });

  return res.status(ready ? 200 : 503).json({
    status: ready ? 'ok' : 'not_ready',
    checks,
    ...extras,
  });
});

// Full diagnostic health (HTTP 503 only when Redis is down). Honors HEALTH_VOICE_DEPENDENCIES modes.
healthRouter.get('/', async (_req, res) => {
  const mode = voiceDepsMode();
  const redis = await checkRedis();
  const checks: HealthStatus['checks'] = { redis };

  if (mode === 'disabled') {
    const anyFailed = !redis.ok;
    const status: HealthStatus & { voice_ready: boolean; voice_dependencies_checked: boolean; health_voice_dependency_mode: string } = {
      status: anyFailed ? 'unhealthy' : 'ok',
      checks,
      uptime_seconds: Math.floor((Date.now() - startTime) / 1000),
      voice_ready: false,
      voice_dependencies_checked: false,
      health_voice_dependency_mode: mode,
    };
    return res.status(anyFailed ? 503 : 200).json(status);
  }

  if (mode === 'configured') {
    const cfg = voiceConfigConfigured();
    const ttsHealth = env.TTS_HEALTH_URL?.trim();
    const wUrl = env.STT_HEALTH_URL?.trim();
    const [whisper, tts] = await Promise.all([
      wUrl ? checkUrl(wUrl) : Promise.resolve(undefined),
      ttsHealth ? checkUrl(ttsHealth) : Promise.resolve(undefined),
    ]);
    if (whisper) checks.whisper = whisper;
    if (tts) checks.tts = tts;
    const voiceReady = cfg.ok && (whisper?.ok ?? true) && (tts?.ok ?? true);
    const anyFailed = !redis.ok;
    const status: HealthStatus & {
      voice_ready: boolean;
      voice_dependencies_checked: boolean;
      health_voice_dependency_mode: string;
    } = {
      status: anyFailed ? 'unhealthy' : redis.ok && voiceReady ? 'ok' : 'degraded',
      checks,
      uptime_seconds: Math.floor((Date.now() - startTime) / 1000),
      voice_ready: Boolean(redis.ok && voiceReady),
      voice_dependencies_checked: true,
      health_voice_dependency_mode: mode,
    };
    return res.status(anyFailed ? 503 : 200).json(status);
  }

  const ttsHealth = effectiveTtsHealthUrl();
  const wUrl = effectiveSttHealthUrl();
  const [whisper, tts] = await Promise.all([
    wUrl ? checkUrl(wUrl) : Promise.resolve(undefined),
    ttsHealth ? checkUrl(ttsHealth) : Promise.resolve(undefined),
  ]);
  if (whisper) checks.whisper = whisper;
  if (tts) checks.tts = tts;

  const allOk = redis.ok && (whisper?.ok ?? true) && (tts?.ok ?? true);
  const anyFailed = !redis.ok;
  const voiceReady = (whisper?.ok ?? true) && (tts?.ok ?? true);

  const status: HealthStatus & { voice_ready: boolean; voice_dependencies_checked: boolean; health_voice_dependency_mode: string } = {
    status: anyFailed ? 'unhealthy' : allOk ? 'ok' : 'degraded',
    checks,
    uptime_seconds: Math.floor((Date.now() - startTime) / 1000),
    voice_ready: Boolean(redis.ok && voiceReady),
    voice_dependencies_checked: true,
    health_voice_dependency_mode: mode,
  };

  if (!allOk) {
    log.warn({ event: 'health_check_degraded', checks }, 'health check not fully ok');
  }

  res.status(anyFailed ? 503 : 200).json(status);
});
