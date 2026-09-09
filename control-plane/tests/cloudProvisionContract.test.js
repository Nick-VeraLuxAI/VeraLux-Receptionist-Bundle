"use strict";

process.env.SECRET_MANAGER = process.env.SECRET_MANAGER || "db";
process.env.SECRET_ENCRYPTION_KEY =
  process.env.SECRET_ENCRYPTION_KEY || "test-secret-encryption-key-32bytes-minimum";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  assertPublicServiceUrl,
  buildCloudStackEnv,
  generateCloudStackSecrets,
  missingCreateSteps,
  POST_CREATE_STEPS,
  webhookUrlForRuntime,
} = require("../dist/cloud/cloudStackEnv.js");
const { executeProvisionPipeline } = require("../dist/cloud/provisioner.js");
const { waitUntilHealthy } = require("../dist/cloud/waitHealthy.js");

function urls() {
  return {
    controlUrl: "https://ctrl.example.com",
    runtimeUrl: "https://rt.example.com",
    databaseUrl: "postgresql://u:p@db/veralux",
    redisUrl: "redis://r:6379",
  };
}

function mockAdapter(overrides = {}) {
  return {
    name: "render",
    async validateCredentials() { return { ok: true }; },
    quoteMonthlyCents() { return 1; },
    async provision({ onStep }) {
      await onStep?.("create_db");
      await onStep?.("create_redis");
      await onStep?.("create_control");
      await onStep?.("create_runtime");
      return { handles: { provider: "mock" } };
    },
    async resolveConnection(handles) {
      return { ...urls(), handles };
    },
    async injectEnv() {},
    async waitHealthy() {},
    async syncStatus() { return { ready: true }; },
    async teardown() {},
    ...overrides,
  };
}

async function runPipeline(adapter, extras = {}) {
  const recordedSteps = [];
  const onStep = async (step) => { recordedSteps.push(step); };
  try {
    const result = await executeProvisionPipeline({
      adapter,
      tenantId: "shop-a",
      deploymentId: "dep-1",
      size: "starter",
      imageRegistry: "ghcr.io/nick-veraluxai",
      imageVersion: "0.1.0",
      vendorKeys: { openaiApiKey: "sk-test", deepgramApiKey: "dg", elevenlabsApiKey: "el", telnyxApiKey: "tx" },
      recordedSteps,
      onStep,
      configureTelnyx: async ({ runtimeUrl }) => ({
        connectionId: "conn_1",
        assignedDid: null,
        needsNumber: true,
        webhookUrl: `${runtimeUrl}/v1/telnyx/webhook`,
      }),
      storeAdminKey: async () => {},
      ...extras,
    });
    return { recordedSteps, result };
  } catch (error) {
    return { recordedSteps, error };
  }
}

test("create-only adapter without create steps fails and does not stamp inject/health/telnyx", async () => {
  const { recordedSteps, error } = await runPipeline(mockAdapter({
    async provision() {
      return { handles: { provider: "mock" } };
    },
  }));
  assert.ok(error);
  assert.match(String(error.message), /missing_step/);
  for (const step of POST_CREATE_STEPS) {
    assert.equal(recordedSteps.includes(step), false, `auto-completed ${step}`);
  }
});

test("full happy path records real post-create steps and returns ready urls", async () => {
  const { recordedSteps, result, error } = await runPipeline(mockAdapter());
  assert.equal(error, undefined);
  assert.deepEqual(missingCreateSteps(recordedSteps), []);
  assert.ok(recordedSteps.includes("inject_env"));
  assert.ok(recordedSteps.includes("wait_healthy"));
  assert.ok(recordedSteps.includes("configure_telnyx"));
  assert.ok(recordedSteps.includes("ready"));
  assert.equal(result.controlUrl, "https://ctrl.example.com");
  assert.equal(result.telnyx.needsNumber, true);
  assert.equal(result.webhookUrl, "https://rt.example.com/v1/telnyx/webhook");
});

test("health timeout fails the job and never records ready", async () => {
  const { recordedSteps, error } = await runPipeline(mockAdapter({
    async waitHealthy() {
      throw new Error("wait_healthy_timeout: health_pending");
    },
  }));
  assert.ok(error);
  assert.match(String(error.message), /wait_healthy_timeout/);
  assert.ok(recordedSteps.includes("inject_env"));
  assert.equal(recordedSteps.includes("wait_healthy"), false);
  assert.equal(recordedSteps.includes("configure_telnyx"), false);
  assert.equal(recordedSteps.includes("ready"), false);
});

test("waitUntilHealthy times out when probes never return 200", async () => {
  const fetchImpl = async () => ({ ok: false });
  await assert.rejects(
    () => waitUntilHealthy({
      controlUrl: "https://ctrl.example.com",
      runtimeUrl: "https://rt.example.com",
      timeoutMs: 20,
      intervalMs: 5,
      fetchImpl,
    }),
    /wait_healthy_timeout/,
  );
});

test("CloudStackEnv prefers tenant BYOK and rejects invented App Runner hosts", () => {
  const env = buildCloudStackEnv({
    tenantId: "shop-a",
    urls: urls(),
    secrets: generateCloudStackSecrets(),
    vendor: { openaiApiKey: "hub-openai", tenantLlmApiKey: "tenant-openai", tenantLlmModel: "gpt-4o" },
    telnyxConnectionId: "conn_1",
  });
  assert.equal(env.OPENAI_API_KEY, "tenant-openai");
  assert.equal(env.OPENAI_MODEL, "gpt-4o");
  assert.equal(env.DATABASE_URL, urls().databaseUrl);
  assert.equal(env.VERALUX_WEBHOOK_URL, webhookUrlForRuntime(urls().runtimeUrl));
  assert.equal(env.TELNYX_CONNECTION_ID, "conn_1");
  assert.equal(env.DEPLOYMENT_PROFILE, "cloud-api");
  assert.throws(() => assertPublicServiceUrl("https://abc.awsapprunner.com", "control"), /invented/);
  assert.throws(() => assertPublicServiceUrl("https://pending.invalid", "runtime"), /invented/);
});
