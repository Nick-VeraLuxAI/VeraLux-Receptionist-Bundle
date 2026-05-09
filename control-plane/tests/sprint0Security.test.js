"use strict";
/**
 * Sprint 0 security & cohesion regression tests (unit-level).
 *
 * These cover the surface that does NOT require Postgres / Redis at the
 * shell level (kept here for fast `npm test`). The full HTTP A/B tenant
 * isolation matrix lives in productionReadiness.integration.test.js.
 */
const test = require("node:test");
const assert = require("node:assert/strict");

// Built outputs
const { deleteLead } = require("../dist/automations/db.js");
const {
  parseRuntimeTenantConfig,
} = require("../dist/runtime/runtimeContract.js");
const {
  buildTenantRuntimeConfig,
} = require("../dist/runtime/buildTenantRuntimeConfig.js");

// ── deleteLead now accepts an optional tenant filter ───────────────────────

test("deleteLead accepts optional tenantId scoping arg", () => {
  // deleteLead now has signature (id, tenantId?). We can't actually call it
  // without Postgres, but we can confirm the function exists and accepts two
  // formal parameters (TypeScript's optional `?` does not change .length).
  assert.equal(typeof deleteLead, "function");
  assert.equal(
    deleteLead.length,
    2,
    "deleteLead now exposes (id, tenantId?) signature",
  );
});

// ── Greeting cohesion: per-tenant greeting is published into Redis contract ─

function baseTenantContext(overrides = {}) {
  // Minimal fake matching the TenantContext shape used by buildTenantRuntimeConfig.
  return {
    id: overrides.id || "tenantA",
    meta: {
      id: overrides.id || "tenantA",
      name: overrides.name || "Tenant A",
      numbers: ["+15551234567"],
    },
    forwardingProfiles: [],
    pricing: { items: [], notes: undefined },
    config: {
      getPrompts: () => ({
        systemPreamble: overrides.systemPreamble ?? "SYS-A",
        schemaHint: "SCHEMA-A",
        policyPrompt: overrides.policyPrompt ?? "POLICY-A",
        voicePrompt: overrides.voicePrompt ?? "VOICE-A",
        greetingText: overrides.greetingText ?? "",
      }),
      getSttConfig: () => ({ whisperUrl: "http://whisper:9000/transcribe" }),
      getTtsConfig: () => ({
        ttsMode: "kokoro_http",
        kokoroUrl: "http://kokoro:7001/tts",
        rate: 0.95,
      }),
    },
  };
}

test("buildTenantRuntimeConfig publishes per-tenant prompts (system/policy/tone)", () => {
  // TELNYX_WEBHOOK_SECRET fallback so build doesn't throw on missing webhook secret.
  const prevSecret = process.env.TELNYX_WEBHOOK_SECRET;
  process.env.TELNYX_WEBHOOK_SECRET = "whsec_test_sprint0";
  try {
    const tenant = baseTenantContext({
      id: "alpha",
      systemPreamble: "TENANT-ALPHA-SYS",
      policyPrompt: "TENANT-ALPHA-POLICY",
      voicePrompt: "TENANT-ALPHA-VOICE",
    });
    const cfg = buildTenantRuntimeConfig(tenant, null, null);
    const parsed = parseRuntimeTenantConfig(cfg);
    assert.ok(parsed.llmContext, "llmContext is published");
    assert.equal(parsed.llmContext.prompts.systemPreamble, "TENANT-ALPHA-SYS");
    assert.equal(parsed.llmContext.prompts.policyPrompt, "TENANT-ALPHA-POLICY");
    assert.equal(parsed.llmContext.prompts.voicePrompt, "TENANT-ALPHA-VOICE");
  } finally {
    if (prevSecret !== undefined) process.env.TELNYX_WEBHOOK_SECRET = prevSecret;
    else delete process.env.TELNYX_WEBHOOK_SECRET;
  }
});

test("buildTenantRuntimeConfig publishes per-tenant greetingText when set", () => {
  const prevSecret = process.env.TELNYX_WEBHOOK_SECRET;
  process.env.TELNYX_WEBHOOK_SECRET = "whsec_test_sprint0";
  try {
    const tenant = baseTenantContext({
      id: "beta",
      greetingText: "Hi, this is Beta receptionist!",
    });
    const cfg = buildTenantRuntimeConfig(tenant, null, null);
    const parsed = parseRuntimeTenantConfig(cfg);
    assert.equal(
      parsed.llmContext.prompts.greetingText,
      "Hi, this is Beta receptionist!",
      "tenant greetingText is published into the runtime contract",
    );
  } finally {
    if (prevSecret !== undefined) process.env.TELNYX_WEBHOOK_SECRET = prevSecret;
    else delete process.env.TELNYX_WEBHOOK_SECRET;
  }
});

test("buildTenantRuntimeConfig omits greetingText when blank (env fallback applies on runtime)", () => {
  const prevSecret = process.env.TELNYX_WEBHOOK_SECRET;
  process.env.TELNYX_WEBHOOK_SECRET = "whsec_test_sprint0";
  try {
    const tenant = baseTenantContext({ id: "gamma", greetingText: "   " });
    const cfg = buildTenantRuntimeConfig(tenant, null, null);
    const parsed = parseRuntimeTenantConfig(cfg);
    assert.equal(
      parsed.llmContext.prompts.greetingText,
      undefined,
      "blank greeting is not published; runtime falls back to env.GREETING_TEXT",
    );
  } finally {
    if (prevSecret !== undefined) process.env.TELNYX_WEBHOOK_SECRET = prevSecret;
    else delete process.env.TELNYX_WEBHOOK_SECRET;
  }
});

test("tenant A and tenant B prompts are isolated in their published configs", () => {
  const prevSecret = process.env.TELNYX_WEBHOOK_SECRET;
  process.env.TELNYX_WEBHOOK_SECRET = "whsec_test_sprint0";
  try {
    const a = buildTenantRuntimeConfig(
      baseTenantContext({
        id: "tenantA",
        systemPreamble: "SYS-A",
        greetingText: "Greet A",
      }),
      null,
      null,
    );
    const b = buildTenantRuntimeConfig(
      baseTenantContext({
        id: "tenantB",
        systemPreamble: "SYS-B",
        greetingText: "Greet B",
      }),
      null,
      null,
    );
    const pa = parseRuntimeTenantConfig(a);
    const pb = parseRuntimeTenantConfig(b);
    assert.equal(pa.llmContext.prompts.systemPreamble, "SYS-A");
    assert.equal(pb.llmContext.prompts.systemPreamble, "SYS-B");
    assert.equal(pa.llmContext.prompts.greetingText, "Greet A");
    assert.equal(pb.llmContext.prompts.greetingText, "Greet B");
  } finally {
    if (prevSecret !== undefined) process.env.TELNYX_WEBHOOK_SECRET = prevSecret;
    else delete process.env.TELNYX_WEBHOOK_SECRET;
  }
});
