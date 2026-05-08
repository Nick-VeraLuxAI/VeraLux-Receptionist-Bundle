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

// Readiness: Redis + (when HEALTH_VOICE_DEPENDENCIES) Whisper + TTS HTTP health
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
  const [whisper, tts] = await Promise.all([
    wUrl ? checkUrl(wUrl) : Promise.resolve(undefined),
    tUrl ? checkUrl(tUrl) : Promise.resolve(undefined),
  ]);
  if (whisper) checks.whisper = whisper;
  if (tts) checks.tts = tts;

  const voiceOk = (whisper?.ok ?? true) && (tts?.ok ?? true);
  const ready = redis.ok && voiceOk;

  return res.status(ready ? 200 : 503).json({
    status: ready ? 'ok' : 'not_ready',
    checks,
    voice_dependencies_checked: true,
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