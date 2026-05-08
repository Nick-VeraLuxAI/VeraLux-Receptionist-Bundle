const defaults: Record<string, string> = {
  PORT: '3000',
  VOICE_CONTROL_API_KEY: 'test-voice-control-key',
  TELNYX_API_KEY: 'test',
  PUBLIC_BASE_URL: 'http://localhost:3000',
  TELNYX_PUBLIC_KEY: 'test',
  TELNYX_STREAM_TRACK: 'inbound_track',
  MEDIA_STREAM_TOKEN: 'test',
  AUDIO_PUBLIC_BASE_URL: 'http://localhost/audio',
  AUDIO_STORAGE_DIR: '/tmp/audio',
  WHISPER_URL: 'http://localhost/whisper',
  KOKORO_URL: 'http://localhost/kokoro',
  STT_CHUNK_MS: '1000',
  STT_SILENCE_MS: '500',
  STT_MIN_SECONDS: '1.0',
  STT_SILENCE_MIN_SECONDS: '.5',
  DEAD_AIR_MS: '2000',
  REDIS_URL: 'redis://127.0.0.1:56379',
  GLOBAL_CONCURRENCY_CAP: '30',
  TENANT_CONCURRENCY_CAP_DEFAULT: '5',
  TENANT_CALLS_PER_MIN_CAP_DEFAULT: '10',
  CAPACITY_TTL_SECONDS: '600',
  TENANTMAP_PREFIX: 'tenantmap',
  TENANTCFG_PREFIX: 'tenantcfg',
  CAP_PREFIX: 'cap',
  /** Integration tests have no real Whisper/TTS; readiness is Redis-only. */
  HEALTH_VOICE_DEPENDENCIES: 'false',
};

export function setTestEnv(): void {
  process.env.TELNYX_SKIP_SIGNATURE = 'false';
  process.env.TELNYX_VERIFY_SIGNATURES = 'true';
  for (const [key, value] of Object.entries(defaults)) {
    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
}

// Apply defaults immediately when imported so modules that validate env
// at import-time can run in tests without explicit setup ordering.
setTestEnv();
