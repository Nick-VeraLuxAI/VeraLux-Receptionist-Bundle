const test = require("node:test");
const assert = require("node:assert/strict");
const { estimatePipeline, normalizeAssumptions } = require("../dist/pipelineEstimate.js");
const { PIPELINE_COMPONENTS, ONPREM_HUB_SKU, isPaidCloudHost } = require("../dist/pipelineCatalog.js");

const card = [
  { sku: "telnyx:inbound", unit: "per_minute", millicents: 700, currency: "USD", source: "seed", asOf: "2026-01-01T00:00:00.000Z" },
  { sku: "openai:whisper-1", unit: "per_minute", millicents: 600, currency: "USD", source: "seed", asOf: "2026-01-01T00:00:00.000Z" },
  { sku: "openai:gpt-4o-mini", unit: "per_1m_input_tokens", millicents: 15000, currency: "USD", source: "seed", asOf: "2026-01-01T00:00:00.000Z" },
  { sku: "openai:gpt-4o-mini", unit: "per_1m_output_tokens", millicents: 60000, currency: "USD", source: "seed", asOf: "2026-01-01T00:00:00.000Z" },
  { sku: "openai:tts-1", unit: "per_1k_chars", millicents: 1500, currency: "USD", source: "seed", asOf: "2026-01-01T00:00:00.000Z" },
  { sku: "render:starter", unit: "per_month", millicents: 2_800_000, currency: "USD", source: "seed", asOf: "2026-01-01T00:00:00.000Z" },
];

test("estimatePipeline sums COGS and applies retail margin", () => {
  const est = estimatePipeline(
    {
      hostSku: "render:starter",
      sttSku: "openai:whisper-1",
      llmSku: "openai:gpt-4o-mini",
      ttsSku: "openai:tts-1",
    },
    card,
    { assumedMonthlyMinutes: 500, retailMarginBps: 4000 },
  );
  assert.equal(est.disclaimer, "estimate_not_invoice");
  assert.equal(est.lineItems.length, 5);
  assert.ok(est.cogsPerMinuteCents > 0);
  assert.ok(Math.abs(est.retailPerMinuteCents - est.cogsPerMinuteCents * 1.4) < 0.01);
  assert.ok(Math.abs(est.monthlyCogsCents - est.cogsPerMinuteCents * 500) < 0.1);
});

test("on-prem SKUs with no prices contribute zero API cost", () => {
  const est = estimatePipeline(
    {
      hostSku: "render:starter",
      sttSku: "stt:whisper_http",
      llmSku: "platform:nemotron",
      ttsSku: "tts:kokoro_http",
    },
    card,
  );
  const api = est.lineItems.filter((i) => i.slot !== "host" && i.slot !== "telco");
  for (const item of api) {
    assert.equal(item.centsPerMinute, 0);
  }
});

test("normalizeAssumptions clamps bad input", () => {
  const a = normalizeAssumptions({ assumedMonthlyMinutes: -1, callerTalkRatio: 9, retailMarginBps: -50 });
  assert.equal(a.assumedMonthlyMinutes, 1);
  assert.equal(a.callerTalkRatio, 1);
  assert.equal(a.retailMarginBps, 0);
});

test("catalog only lists developer-plan LLM APIs", () => {
  const llms = PIPELINE_COMPONENTS.filter((c) => c.slot === "llm").map((c) => c.sku);
  assert.deepEqual(
    llms.filter((s) => s.startsWith("groq:")).sort(),
    ["groq:gpt-oss-120b", "groq:gpt-oss-20b"],
  );
  assert.ok(!llms.some((s) => /gemini-3|gpt-5\.4|claude-sonnet-5|claude-opus-5|llama-3|llama-4|qwen3-32b|grok-4\.5/.test(s)));
});

test("selectable on-prem TTS is Kokoro only", () => {
  const { PIPELINE_COMPONENTS_SELECTABLE, isSelectablePipelineComponent } = require("../dist/pipelineCatalog.js");
  const onpremTts = PIPELINE_COMPONENTS_SELECTABLE.filter((c) => c.slot === "tts" && c.hostOk === false);
  assert.deepEqual(onpremTts.map((c) => c.sku), ["tts:kokoro_http"]);
  assert.equal(isSelectablePipelineComponent({ sku: "tts:qwen3_tts_http", slot: "tts", hostOk: false }), false);
  assert.equal(isSelectablePipelineComponent({ sku: "openai:tts-1", slot: "tts", hostOk: true }), true);
});

test("on-prem LLM SKU matches the served Qwen 3.5 27B model", () => {
  const llm = PIPELINE_COMPONENTS.find((c) => c.sku === "platform:nemotron");
  assert.ok(llm);
  assert.equal(llm.label, "On-prem Qwen 3.5 27B");
  assert.equal(llm.shortLabel, "3.5 27B");
  assert.equal(llm.llmModel, "Qwen3.5-27B-GPTQ-Int4");
});

test("on-prem hub is a host option and is not provisionable cloud", () => {
  const host = PIPELINE_COMPONENTS.find((c) => c.sku === ONPREM_HUB_SKU);
  assert.ok(host);
  assert.equal(host.slot, "host");
  assert.equal(host.provider, "onprem");
  assert.equal(host.shortLabel, "This hub");
  assert.equal(isPaidCloudHost(host), false);
  assert.equal(isPaidCloudHost(PIPELINE_COMPONENTS.find((c) => c.sku === "render:starter")), true);
});

test("on-prem hub adds no host line to COGS", () => {
  const est = estimatePipeline(
    {
      hostSku: ONPREM_HUB_SKU,
      sttSku: "stt:whisper_http",
      llmSku: "platform:nemotron",
      ttsSku: "tts:kokoro_http",
    },
    card,
  );
  const hostLine = est.lineItems.find((i) => i.slot === "host");
  assert.ok(hostLine);
  assert.equal(hostLine.centsPerMinute, 0);
});

test("estimatePipeline includes turn latency", () => {
  const cloud = estimatePipeline(
    {
      hostSku: "render:starter",
      sttSku: "openai:whisper-1",
      llmSku: "openai:gpt-4o-mini",
      ttsSku: "openai:tts-1",
    },
    card,
  );
  assert.equal(cloud.latency.disclaimer, "estimate_not_sla");
  assert.ok(cloud.latency.firstAudioMs > 1000);
  assert.ok(cloud.latency.fullReplyMs >= cloud.latency.firstAudioMs);

  const groq = estimatePipeline(
    {
      hostSku: "render:starter",
      sttSku: "deepgram:nova-2",
      llmSku: "groq:gpt-oss-20b",
      ttsSku: "elevenlabs:flash",
    },
    card,
  );
  const reasoning = estimatePipeline(
    {
      hostSku: "render:starter",
      sttSku: "openai:whisper-1",
      llmSku: "openai:o4-mini",
      ttsSku: "openai:tts-1",
    },
    card,
  );
  assert.ok(groq.latency.firstAudioMs < cloud.latency.firstAudioMs);
  assert.ok(cloud.latency.firstAudioMs < reasoning.latency.firstAudioMs);
});
