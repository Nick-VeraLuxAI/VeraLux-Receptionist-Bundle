const test = require("node:test");
const assert = require("node:assert/strict");
const { parseRuntimeTenantConfig, normalizeE164 } = require("../dist/runtime/runtimeContract");

function baseConfig(overrides = {}) {
  return {
    contractVersion: "v1",
    tenantId: "tenantA",
    dids: ["+15551234567"],
    webhookSecretRef: "secrets/tenantA/telnyx",
    caps: {
      maxConcurrentCallsTenant: 10,
      maxCallsPerMinuteTenant: 60,
    },
    stt: {
      mode: "whisper_http",
      whisperUrl: "http://localhost:9000/transcribe",
      chunkMs: 500,
    },
    tts: {
      mode: "kokoro_http",
      kokoroUrl: "http://localhost:7001/tts",
    },
    audio: {
      publicBaseUrl: "http://localhost:4000/audio",
      runtimeManaged: true,
    },
    ...overrides,
  };
}

test("runtimeContract accepts a valid config", () => {
  const parsed = parseRuntimeTenantConfig(baseConfig());
  assert.equal(parsed.tenantId, "tenantA");
  assert.equal(parsed.contractVersion, "v1");
});

test("runtimeContract accepts published intakeProfile", () => {
  const parsed = parseRuntimeTenantConfig(
    baseConfig({
      intakeProfile: {
        kind: "demo",
        writer: "gcal",
        timezone: "America/Los_Angeles",
        timezoneOffsetHours: -7,
      },
    }),
  );
  assert.equal(parsed.intakeProfile.kind, "demo");
  assert.equal(parsed.intakeProfile.writer, "gcal");
});

test("runtimeContract accepts chatterbox_http tts", () => {
  const parsed = parseRuntimeTenantConfig(
    baseConfig({
      tts: {
        mode: "chatterbox_http",
        chatterboxUrl: "http://localhost:7005",
        chatterboxVariant: "turbo",
        language: "en",
      },
    }),
  );
  assert.equal(parsed.tts.mode, "chatterbox_http");
  assert.equal(parsed.tts.chatterboxUrl, "http://localhost:7005");
});

test("runtimeContract accepts qwen3_tts_http tts", () => {
  const parsed = parseRuntimeTenantConfig(
    baseConfig({
      tts: {
        mode: "qwen3_tts_http",
        qwen3TtsUrl: "http://localhost:7010",
        speaker: "Ryan",
        language: "English",
        qwen3Temperature: 0.85,
        qwen3TopP: 0.92,
        qwen3DoSample: true,
      },
    }),
  );
  assert.equal(parsed.tts.mode, "qwen3_tts_http");
  assert.equal(parsed.tts.qwen3TtsUrl, "http://localhost:7010");
  assert.equal(parsed.tts.qwen3Temperature, 0.85);
  assert.equal(parsed.tts.qwen3TopP, 0.92);
  assert.equal(parsed.tts.qwen3DoSample, true);
});

test("runtimeContract accepts magpie_tts_http tts", () => {
  const parsed = parseRuntimeTenantConfig(
    baseConfig({
      tts: {
        mode: "magpie_tts_http",
        magpieTtsUrl: "http://localhost:7012",
        speaker: "Sofia",
        language: "en",
        magpieTemperature: 0.6,
        magpieCfgScale: 2.5,
      },
    }),
  );
  assert.equal(parsed.tts.mode, "magpie_tts_http");
  assert.equal(parsed.tts.magpieTtsUrl, "http://localhost:7012");
  assert.equal(parsed.tts.magpieTemperature, 0.6);
});

test("runtimeContract accepts melo_tts_http tts", () => {
  const parsed = parseRuntimeTenantConfig(
    baseConfig({
      tts: {
        mode: "melo_tts_http",
        meloTtsUrl: "http://localhost:7013",
        speaker: "EN-US",
        language: "EN",
        rate: 1.05,
      },
    }),
  );
  assert.equal(parsed.tts.mode, "melo_tts_http");
  assert.equal(parsed.tts.meloTtsUrl, "http://localhost:7013");
  assert.equal(parsed.tts.speaker, "EN-US");
});

test("runtimeContract accepts miso_tts_http tts", () => {
  const parsed = parseRuntimeTenantConfig(
    baseConfig({
      tts: {
        mode: "miso_tts_http",
        misoTtsUrl: "http://localhost:7011",
        speaker: "0",
        misoTemperature: 0.9,
        misoTopK: 50,
      },
    }),
  );
  assert.equal(parsed.tts.mode, "miso_tts_http");
  assert.equal(parsed.tts.misoTtsUrl, "http://localhost:7011");
  assert.equal(parsed.tts.speaker, "0");
  assert.equal(parsed.tts.misoTopK, 50);
});

test("runtimeContract rejects missing webhook secret", () => {
  const cfg = baseConfig({ webhookSecretRef: undefined });
  delete cfg.webhookSecretRef;
  assert.throws(() => parseRuntimeTenantConfig(cfg));
});

test("runtimeContract rejects invalid E.164 DID", () => {
  const cfg = baseConfig({ dids: ["12345"] });
  assert.throws(() => parseRuntimeTenantConfig(cfg));
});

test("runtimeContract accepts optional callQuality block", () => {
  const parsed = parseRuntimeTenantConfig(
    baseConfig({
      callQuality: {
        callQualityAnalyticsEnabled: true,
        transcriptStorageEnabled: true,
        transcriptRetentionDays: 14,
        rawAudioDiagnosticsMode: "off",
        qualitySummaryVisibleToClient: true,
        rawArtifactsVisibleToClient: false,
      },
    }),
  );
  assert.equal(parsed.callQuality.transcriptRetentionDays, 14);
});

test("normalizeE164 accepts valid E.164", () => {
  assert.equal(normalizeE164("+15551234567"), "+15551234567");
  assert.equal(normalizeE164("  +44 20 7946 0958  "), "+442079460958");
});

test("normalizeE164 throws on empty", () => {
  assert.throws(() => normalizeE164(""), /did_empty/);
  assert.throws(() => normalizeE164("   "), /did_empty/);
});

test("normalizeE164 throws on invalid format", () => {
  assert.throws(() => normalizeE164("12345"), /invalid_e164/);
  assert.throws(() => normalizeE164("15551234567"), /invalid_e164/);
});

test("runtimeContract accepts optional llmRouting", () => {
  const parsed = parseRuntimeTenantConfig(
    baseConfig({
      llmRouting: {
        mode: "tenant_api_key",
        tenantProvider: "openai",
        tenantModel: "gpt-4o-mini",
        tenantApiKeyConfigured: true,
        tenantKeyErrorPolicy: "platform_default",
      },
    }),
  );
  assert.equal(parsed.llmRouting.mode, "tenant_api_key");
  assert.equal(parsed.llmRouting.tenantModel, "gpt-4o-mini");
});

test("runtimeContract accepts anthropic tenant routing and cloud TTS", () => {
  const parsed = parseRuntimeTenantConfig(
    baseConfig({
      llmRouting: {
        mode: "tenant_api_key",
        tenantProvider: "anthropic",
        tenantModel: "claude-sonnet-4-5",
        tenantApiKeyConfigured: true,
      },
      tts: { mode: "openai_tts", voice: "alloy", model: "tts-1" },
    }),
  );
  assert.equal(parsed.llmRouting.tenantProvider, "anthropic");
  assert.equal(parsed.tts.mode, "openai_tts");
  const eleven = parseRuntimeTenantConfig(
    baseConfig({ tts: { mode: "elevenlabs", voice: "EXAVITQu4vr4xnSDxMaL" } }),
  );
  assert.equal(eleven.tts.mode, "elevenlabs");
});

test("runtimeContract accepts cloud STT without whisperUrl", () => {
  const parsed = parseRuntimeTenantConfig(
    baseConfig({
      stt: { mode: "openai_whisper", chunkMs: 500, language: "en", model: "whisper-1" },
    }),
  );
  assert.equal(parsed.stt.mode, "openai_whisper");
  const dg = parseRuntimeTenantConfig(
    baseConfig({
      stt: { mode: "deepgram", chunkMs: 500, model: "nova-2" },
    }),
  );
  assert.equal(dg.stt.mode, "deepgram");
});
