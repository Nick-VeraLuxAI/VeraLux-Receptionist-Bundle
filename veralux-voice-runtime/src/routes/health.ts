import { Router } from 'express';
import { getRedisClient } from '../redis/client';
import { env } from '../env';
import { log } from '../log';
import { incDependencyUnavailable } from '../metrics';

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

/** Strict voice-plane readiness: Redis + Whisper + configured TTS + optional Brain HTTP. */
healthRouter.get('/voice', async (_req, res) => {
  const redis = await checkRedis();
  const wUrl = whisperHealthUrl();
  const tUrl = ttsHealthUrl();
  const bUrl = brainHealthUrl();

  if (!wUrl || !tUrl) {
    log.warn({ event: 'health_voice_misconfigured', whisper_configured: Boolean(wUrl), tts_configured: Boolean(tUrl) });
    return res.status(503).json({
      status: 'not_ready',
      endpoint: '/health/voice',
      checks: { redis },
      error: !wUrl ? 'missing_whisper_url' : 'missing_or_unsupported_tts_url',
      voice_dependencies_checked: true,
    });
  }

  const [whisper, tts, brain] = await Promise.all([
    checkUrl(wUrl),
    checkUrl(tUrl),
    bUrl ? checkUrl(bUrl) : Promise.resolve(undefined),
  ]);
  const checks: HealthStatus['checks'] & { brain?: { ok: boolean; latency_ms?: number; error?: string } } =
    {
      redis,
      whisper,
      tts,
    };
  if (brain !== undefined) checks.brain = brain;

  const sttOk = whisper.ok;
  const ttsOk = tts.ok;
  const brainOk = brain === undefined ? true : brain.ok;
  const ready = redis.ok && sttOk && ttsOk && brainOk;

  return res.status(ready ? 200 : 503).json({
    status: ready ? 'ok' : 'not_ready',
    endpoint: '/health/voice',
    checks,
    voice_dependencies_checked: true,
    brain_checked: Boolean(bUrl),
  });
});

// Readiness: Redis-only when HEALTH_VOICE_DEPENDENCIES=false; otherwise same strict gate as GET /health/voice.
healthRouter.get('/ready', async (_req, res) => {
  const redis = await checkRedis();
  const checks: HealthStatus['checks'] = { redis };

  if (!env.HEALTH_VOICE_DEPENDENCIES) {
    const ready = redis.ok;
    return res.status(ready ? 200 : 503).json({
      status: ready ? 'ok' : 'not_ready',
      checks: { redis },
      voice_dependencies_checked: false,
    });
  }

  const wUrl = whisperHealthUrl();
  const tUrl = ttsHealthUrl();
  const bUrl = brainHealthUrl();

  if (!wUrl || !tUrl) {
    return res.status(503).json({
      status: 'not_ready',
      checks: { redis },
      error: !wUrl ? 'missing_whisper_url' : 'missing_or_unsupported_tts_url',
      voice_dependencies_checked: true,
    });
  }

  const [whisper, tts, brain] = await Promise.all([
    checkUrl(wUrl),
    checkUrl(tUrl),
    bUrl ? checkUrl(bUrl) : Promise.resolve(undefined),
  ]);
  if (whisper) checks.whisper = whisper;
  if (tts) checks.tts = tts;
  const extras: Record<string, unknown> = { voice_dependencies_checked: true };
  if (brain !== undefined) {
    extras.brain_checked = Boolean(bUrl);
    (checks as typeof checks & { brain?: { ok: boolean; latency_ms?: number; error?: string } }).brain = brain;
  }

  const sttOk = whisper.ok;
  const ttsOk = tts.ok;
  const brainOk = brain === undefined ? true : brain.ok;
  const ready = redis.ok && sttOk && ttsOk && brainOk;

  return res.status(ready ? 200 : 503).json({
    status: ready ? 'ok' : 'not_ready',
    checks,
    ...extras,
  });
});

// Full diagnostic health (HTTP 503 only when Redis is down). Honors HEALTH_VOICE_DEPENDENCIES like /ready.
healthRouter.get('/', async (_req, res) => {
  const redis = await checkRedis();
  const checks: HealthStatus['checks'] = { redis };

  if (!env.HEALTH_VOICE_DEPENDENCIES) {
    const anyFailed = !redis.ok;
    const status: HealthStatus & { voice_ready: boolean; voice_dependencies_checked: boolean } = {
      status: anyFailed ? 'unhealthy' : 'ok',
      checks,
      uptime_seconds: Math.floor((Date.now() - startTime) / 1000),
      voice_ready: false,
      voice_dependencies_checked: false,
    };
    return res.status(anyFailed ? 503 : 200).json(status);
  }

  const ttsHealth = ttsHealthUrl();
  const wUrl = whisperHealthUrl();
  const [whisper, tts] = await Promise.all([
    wUrl ? checkUrl(wUrl) : Promise.resolve(undefined),
    ttsHealth ? checkUrl(ttsHealth) : Promise.resolve(undefined),
  ]);
  if (whisper) checks.whisper = whisper;
  if (tts) checks.tts = tts;

  const allOk = redis.ok && (whisper?.ok ?? true) && (tts?.ok ?? true);
  const anyFailed = !redis.ok;
  const voiceReady = (whisper?.ok ?? true) && (tts?.ok ?? true);

  const status: HealthStatus & { voice_ready: boolean; voice_dependencies_checked: boolean } = {
    status: anyFailed ? 'unhealthy' : allOk ? 'ok' : 'degraded',
    checks,
    uptime_seconds: Math.floor((Date.now() - startTime) / 1000),
    voice_ready: Boolean(redis.ok && voiceReady),
    voice_dependencies_checked: true,
  };

  if (!allOk) {
    log.warn({ event: 'health_check_degraded', checks }, 'health check not fully ok');
  }

  res.status(anyFailed ? 503 : 200).json(status);
});