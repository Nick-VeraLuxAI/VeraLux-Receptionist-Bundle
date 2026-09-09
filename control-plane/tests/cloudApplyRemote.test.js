"use strict";

process.env.SECRET_MANAGER = process.env.SECRET_MANAGER || "db";
process.env.SECRET_ENCRYPTION_KEY =
  process.env.SECRET_ENCRYPTION_KEY || "test-secret-encryption-key-32bytes-minimum";

const test = require("node:test");
const assert = require("node:assert/strict");
const { applyPipelineToRemote } = require("../dist/cloud/applyRemote.js");
const { applyReadyDeploymentRemote } = require("../dist/cloud/applyPipeline.js");

test("applyPipelineToRemote posts tenant, pipeline, and apply with the bootstrap admin key", async () => {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, method: init.method, headers: init.headers, body: init.body });
    return { ok: true, status: 200 };
  };
  const result = await applyPipelineToRemote({
    controlUrl: "https://ctrl.example.com",
    adminApiKey: "vl_admin",
    tenantId: "shop-a",
    tenantName: "Shop A",
    numbers: ["+15551212"],
    skus: { sttSku: "openai:whisper-1", llmSku: "openai:gpt-4o-mini", ttsSku: "openai:tts-1" },
    fetchImpl,
  });
  assert.equal(result.ok, true);
  assert.equal(calls.length, 3);
  assert.ok(calls[0].url.endsWith("/api/admin/tenants"));
  assert.ok(calls[1].url.includes("/pipeline"));
  assert.ok(calls[2].url.endsWith("/pipeline/apply"));
  assert.equal(calls[0].headers["x-admin-key"], "vl_admin");
});

test("Apply without a ready deployment stays hub-only", async () => {
  const calls = [];
  const result = await applyReadyDeploymentRemote("shop-apply-hub", {}, {
    getReadyDeployment: async () => null,
    applyRemote: async () => {
      calls.push("remote");
      return { ok: true };
    },
  });
  assert.deepEqual(result, {});
  assert.equal(calls.length, 0);
});

test("Apply with a ready deployment hits the remote control", async () => {
  const calls = [];
  const result = await applyReadyDeploymentRemote(
    "shop-apply-remote",
    { sttSku: "openai:whisper-1", ttsSku: "openai:tts-1" },
    {
      getReadyDeployment: async () => ({
        id: "dep-ready",
        tenantId: "shop-apply-remote",
        host: "render",
        region: "oregon",
        size: "starter",
        status: "ready",
        controlUrl: "https://ctrl.example.com",
        runtimeUrl: "https://rt.example.com",
        handles: {},
        lastError: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
      loadAdminKey: async () => "vl_remote",
      applyRemote: async (input) => {
        calls.push(input);
        return { ok: true };
      },
    },
  );
  assert.equal(result.remoteApplied, true);
  assert.equal(result.remoteApplyError, undefined);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].controlUrl, "https://ctrl.example.com");
  assert.equal(calls[0].adminApiKey, "vl_remote");
  assert.equal(calls[0].skus.sttSku, "openai:whisper-1");
});
