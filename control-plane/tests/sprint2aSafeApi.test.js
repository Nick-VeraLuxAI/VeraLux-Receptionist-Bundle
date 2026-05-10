const test = require("node:test");
const assert = require("node:assert/strict");
const { LLMConfigStore } = require("../dist/config.js");
const { redactPublishedRuntimeConfig } = require("@veralux/shared");

test("getSafeTtsConfig omits raw provider URLs", () => {
  const store = new LLMConfigStore({
    tts: {
      ttsMode: "kokoro_http",
      xttsUrl: "http://xtts:7002",
      kokoroUrl: "http://kokoro:7001/tts",
      voiceId: "af",
      language: "a",
      rate: 0.95,
    },
  });
  const safe = store.getSafeTtsConfig();
  assert.equal(safe.kokoroEndpointConfigured, true);
  assert.equal("kokoroUrl" in safe, false);
  assert.equal("xttsUrl" in safe, false);
});

test("getSafeConfig omits localUrl but exposes localLlmEndpointConfigured", () => {
  const store = new LLMConfigStore({
    config: {
      provider: "local",
      localUrl: "http://127.0.0.1:8080/completion",
      openaiModel: "gpt-4o-mini",
    },
  });
  const safe = store.getSafeConfig();
  assert.equal("localUrl" in safe, false);
  assert.equal(safe.localLlmEndpointConfigured, true);
});

test("redactPublishedRuntimeConfig removes webhook secret and redacts URLs", () => {
  const cfg = {
    contractVersion: "v1",
    tenantId: "t1",
    dids: ["+15551234567"],
    webhookSecret: "sec",
    webhookSecretRef: "ref1",
    caps: {
      maxConcurrentCallsTenant: 2,
      maxCallsPerMinuteTenant: 10,
      maxConcurrentCallsGlobal: 16,
    },
    stt: { mode: "whisper_http", whisperUrl: "http://whisper:9000/transcribe", chunkMs: 100 },
    tts: {
      mode: "kokoro_http",
      kokoroUrl: "http://kokoro:7001/tts",
      voice: "af",
    },
    audio: { publicBaseUrl: "https://example.com/audio" },
  };
  const out = redactPublishedRuntimeConfig(cfg);
  assert.equal(out.webhookSecret, undefined);
  assert.equal(out.webhookSecretRef, "[redacted]");
  assert.equal(out.stt.whisperUrl, "[redacted-internal]");
  assert.equal(out.tts.kokoroUrl, "[redacted-internal]");
});
