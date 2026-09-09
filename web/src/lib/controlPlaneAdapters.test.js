import {
  normalizeTtsPreviewJob,
  ttsPreviewAudioSrc,
  toSuggestRequest,
  fromSuggestResponse,
  normalizeTenantUpsert,
  lastPublishedFromRuntimeConfig,
  fromTtsConfigSave,
  mergeUsageWithLimits,
  fromTenantBillingSummary,
  fromAdminHealth,
  fromRuntimeHealth,
  isServiceStatusOk,
  fromAnalytics,
  mergeWorkflowListPayload,
  workflowStepToApi,
  workflowStepToUi,
  workflowWriteBody,
  fromWorkflowRuns,
  fromWorkflowTest,
  fromSubscription,
  REAL_WORKFLOW_ACTIONS,
  fromLlmConfig,
  toLlmConfigSave,
} from "./controlPlaneAdapters";
import { centsToDollarInput, dollarInputToCents, fmtMoney, PLAN_TIERS, shortCallRef, callPartyLabel, sortCallsNewestFirst } from "./format";

describe("normalizeTtsPreviewJob", () => {
  test("maps real control-plane done + audioWavBase64 to ready", () => {
    const n = normalizeTtsPreviewJob({
      status: "done",
      encoding: "base64",
      audioWavBase64: "UklGRg==",
    });
    expect(n.status).toBe("ready");
    expect(ttsPreviewAudioSrc(n)).toMatch(/^data:audio\/wav;base64,UklGRg==/);
  });

  test("keeps stub ready + audioUrl", () => {
    const n = normalizeTtsPreviewJob({ status: "ready", audioUrl: "https://x/a.wav" });
    expect(n.status).toBe("ready");
    expect(ttsPreviewAudioSrc(n)).toBe("https://x/a.wav");
  });

  test("maps failed", () => {
    expect(normalizeTtsPreviewJob({ status: "failed", error: "not_found" }).status).toBe("failed");
  });
});

describe("quick-reply suggest", () => {
  test("maps greeting/notes and stringifies forwarding profiles", () => {
    const body = toSuggestRequest({
      greeting: "Hi",
      notes: "walk-ins ok",
      forwardingLines: [{ name: "Front desk", number: "+1555", role: "owner" }],
      maxIntents: 8,
    });
    expect(body.greetingText).toBe("Hi");
    expect(body.pricingNotes).toBe("walk-ins ok");
    expect(body.forwardingLines).toEqual(["Front desk — +1555 — owner"]);
  });

  test("reads quickReplies from real response", () => {
    expect(fromSuggestResponse({ quickReplies: [{ id: "hours" }], dropped: 0 })).toEqual([{ id: "hours" }]);
    expect(fromSuggestResponse({ suggestions: [{ id: "x" }] })).toEqual([{ id: "x" }]);
  });
});

describe("tenant upsert", () => {
  test("wraps raw TenantMeta", () => {
    const { tenant, created } = normalizeTenantUpsert({ id: "acme", name: "Acme" });
    expect(tenant.id).toBe("acme");
    expect(created).toBe(false);
  });
});

describe("runtime publish timestamp", () => {
  test("reads config.lastRuntimePublishedAt", () => {
    expect(
      lastPublishedFromRuntimeConfig({
        config: { lastRuntimePublishedAt: "2026-09-05T12:00:00.000Z" },
      }),
    ).toBe("2026-09-05T12:00:00.000Z");
  });

  test("reads publish-from-tenant { status, config }", () => {
    expect(
      lastPublishedFromRuntimeConfig({
        status: "ok",
        config: { lastRuntimePublishedAt: "2026-09-05T13:00:00.000Z" },
      }),
    ).toBe("2026-09-05T13:00:00.000Z");
  });
});

describe("fromTtsConfigSave", () => {
  test("maps runtimePublish.ok to published", () => {
    const n = fromTtsConfigSave({ ttsMode: "chatterbox_http", runtimePublish: { ok: true } });
    expect(n.published).toBe(true);
  });

  test("maps failed runtime publish", () => {
    const n = fromTtsConfigSave({ runtimePublish: { ok: false, error: "runtime_publish_failed" } });
    expect(n.published).toBe(false);
  });
});

describe("health adapters", () => {
  test("real /api/admin/health without top-level status is ok when services are configured", () => {
    const n = fromAdminHealth({
      server: "ok",
      activeCallsGlobal: 2,
      llm: { status: "ready", provider: "openai" },
      stt: { status: "configured" },
      tts: { status: "configured" },
    });
    expect(n.ok).toBe(true);
    expect(n.status).toBe("ok");
    expect(n.activeCalls).toBe(2);
  });

  test("treats defaulting LLM as healthy", () => {
    expect(isServiceStatusOk("defaulting")).toBe(true);
    expect(fromAdminHealth({ server: "ok", llm: { status: "defaulting" }, stt: { status: "configured" }, tts: { status: "configured" } }).ok).toBe(true);
  });

  test("missing STT is degraded", () => {
    const n = fromAdminHealth({
      server: "ok",
      llm: { status: "ready" },
      stt: { status: "missing" },
      tts: { status: "configured" },
    });
    expect(n.ok).toBe(false);
    expect(n.status).toBe("degraded");
  });

  test("runtime health maps ok/latencyMs", () => {
    const n = fromRuntimeHealth({ ok: true, latencyMs: 4 });
    expect(n.status).toBe("ok");
    expect(n.ok).toBe(true);
    expect(n.redis.connected).toBe(true);
    expect(n.redis.latencyMs).toBe(4);
  });
});

describe("fromAnalytics", () => {
  test("maps flat control-plane totals onto totals.calls", () => {
    const n = fromAnalytics({ totalCalls: 12, missedCalls: 3, answeredCalls: 9, topQuestions: [{ text: "hours", count: 2 }] });
    expect(n.totals.calls).toBe(12);
    expect(n.totals.missedCalls).toBe(3);
    expect(n.daily).toEqual([]);
    expect(n.topQuestions[0].text).toBe("hours");
    expect(n.intents[0]).toEqual({ intent: "hours", count: 2 });
  });

  test("empty payload does not throw", () => {
    expect(fromAnalytics(null).totals.calls).toBe(0);
  });
});

describe("call labels", () => {
  test("shortCallRef hides opaque v3 ids", () => {
    expect(shortCallRef("v3:GG2vcr3L93KWbHQL2hhgg9ASjb9QHga4")).toBe("Call GG2vcr");
    expect(callPartyLabel({ call_id: "v3:GG2vcr3L93KWbHQL2hhgg9ASjb9QHga4" })).toBe("Call GG2vcr");
    expect(callPartyLabel({ callerName: "Nick DeSantis", call_id: "v3:abc" })).toBe("Nick DeSantis");
  });
});

describe("billing summary", () => {
  test("unwraps nested summary and does not invent a plan price", () => {
    const result = fromTenantBillingSummary(
      {
        tenantId: "demo-shop",
        summary: {
          planTier: "professional",
          billingStatus: "trial",
          includedMinutes: 500,
          billableMinutes: 42,
          overageMinutes: 0,
          estimatedOverageChargeCents: 0,
          callsCount: 8,
        },
      },
      { limits: { monthlyMinuteOverageRateCents: 12 } },
    );
    expect(result.planName).toBe("Professional");
    expect(result.billingStatus).toBe("trial");
    expect(result.minutesUsed).toBe(42);
    expect(result.includedMinutes).toBe(500);
    expect(result.overageMinutes).toBe(0);
    expect(result.overageRateCents).toBe(12);
    expect(result.estimatedTotalCents).toBe(0);
    expect(result.subscriptionConfigured).toBe(false);
  });
});

describe("usage + limits", () => {
  test("merges real endpoints and maps DB counter names", () => {
    const result = mergeUsageWithLimits(
      {
        usage: {
          dailyCalls: 2,
          monthlyCalls: 18,
          monthlyBillableMinutes: 42.5,
          activeCalls: 1,
        },
        overageMinutes: 0,
      },
      {
        limits: {
          planName: "Professional",
          overageMode: "allow",
          includedMonthlyMinutes: 500,
        },
      },
    );
    expect(result.limits.planName).toBe("Professional");
    expect(result.usage.minutesUsed).toBe(42.5);
    expect(result.usage.callsThisMonth).toBe(18);
    expect(result.usage.callsToday).toBe(2);
    expect(result.usage.concurrentCallsNow).toBe(1);
    expect(result.usage.concurrentCallsPeak).toBe(1);
    expect(mergeUsageWithLimits({ usage: { monthlyCalls: 26, activeCalls: 26 } }).usage.concurrentCallsNow).toBe(0);
    expect(mergeUsageWithLimits({ usage: { monthlyCalls: 26, activeCalls: 26 } }).usage.concurrentCallsPeak).toBe(0);
    expect(
      mergeUsageWithLimits({
        usage: { monthlyCalls: 52, dailyCalls: 3, concurrentCallsNow: 0, activeCalls: 0 },
      }).usage.concurrentCallsNow,
    ).toBe(0);
    expect(
      mergeUsageWithLimits({
        usage: { monthlyCalls: 52, concurrentCallsPeak: 52, activeCalls: 0 },
      }).usage.concurrentCallsNow,
    ).toBe(0);
    expect(result.overageMode).toBe("allow");
  });
});

describe("llm config adapters", () => {
  test("maps API platform_default to platform and exposes hasApiKey", () => {
    const n = fromLlmConfig({
      mode: "platform_default",
      configured: false,
      platformModel: "Qwen3.5-27B-GPTQ-Int4",
    });
    expect(n.mode).toBe("platform");
    expect(n.hasApiKey).toBe(false);
    expect(n.platformModel).toContain("Qwen");
  });

  test("maps tenant_api_key and provider aliases", () => {
    const n = fromLlmConfig({
      mode: "tenant_api_key",
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      configured: true,
    });
    expect(n.mode).toBe("tenant");
    expect(n.tenantProvider).toBe("anthropic");
    expect(n.tenantModel).toBe("claude-sonnet-4-5");
    expect(n.hasApiKey).toBe(true);
  });

  test("save body uses control-plane enums", () => {
    expect(toLlmConfigSave({ mode: "platform" })).toEqual({ mode: "platform_default" });
    expect(toLlmConfigSave({ mode: "tenant", tenantProvider: "google", tenantModel: "gemini-2.5-flash", apiKey: "sk-test-key" })).toEqual({
      mode: "tenant_api_key",
      tenantProvider: "google",
      tenantModel: "gemini-2.5-flash",
      apiKey: "sk-test-key",
    });
  });
});

describe("workflows", () => {
  test("merges list + settings endpoints", () => {
    const merged = mergeWorkflowListPayload(
      {
        workflows: [
          {
            id: "1",
            name: "Missed",
            triggerType: "missed_call",
            steps: [{ action: "send_sms", config: { to: "caller", template: "Hi" }, order: 0 }],
          },
        ],
      },
      { ownerCanEdit: true },
    );
    expect(merged.settings.ownerCanEdit).toBe(true);
    expect(merged.workflows[0].steps[0].type).toBe("send_sms");
    expect(merged.workflows[0].steps[0].template).toBe("Hi");
    expect(merged.triggerTypes).toContain("scheduled");
    expect(merged.triggerTypes).toContain("booking_succeeded");
    expect(merged.stepTypes).toContain("fire_webhook");
    expect(merged.stepTypes).toContain("book_calendar");
    expect(REAL_WORKFLOW_ACTIONS).toContain("page_on_call");
  });

  test("maps completed runs to succeeded and keeps today", () => {
    const mapped = fromWorkflowRuns({
      runs: [
        {
          id: "r1",
          workflowName: "Night desk capture & book",
          triggerEvent: { type: "call_ended" },
          status: "completed",
          startedAt: new Date().toISOString(),
          result: [{ status: "ok" }],
        },
        {
          id: "r-old",
          workflowName: "Yesterday",
          triggerEvent: { type: "scheduled" },
          status: "completed",
          startedAt: "2020-01-01T12:00:00.000Z",
        },
      ],
    });
    expect(mapped.today).toBe(true);
    expect(mapped.runs).toHaveLength(1);
    expect(mapped.runs[0].status).toBe("succeeded");
    expect(mapped.runs[0].trigger).toBe("call_ended");
  });

  test("trusts server today filter instead of dropping tenant-timezone rows", () => {
    const mapped = fromWorkflowRuns({
      today: true,
      timezone: "America/Los_Angeles",
      runs: [
        {
          id: "r-edge",
          workflowName: "Morning digest",
          triggerEvent: { type: "scheduled" },
          status: "completed",
          startedAt: "2020-01-01T12:00:00.000Z",
        },
      ],
    });
    expect(mapped.runs).toHaveLength(1);
  });

  test("maps dry-run test payload for the dialog", () => {
    const t = fromWorkflowTest({
      wouldMatch: true,
      enabled: true,
      steps: [{ action: "store_lead", output: { description: "Would store" } }],
    });
    expect(t.matched).toBe(true);
    expect(t.steps[0].type).toBe("store_lead");
    expect(t.steps[0].rendered).toContain("Would store");
  });

  test("maps stub webhook type to fire_webhook", () => {
    expect(workflowStepToApi({ type: "webhook", url: "https://ex" }, 1)).toEqual({
      action: "fire_webhook",
      config: { url: "https://ex" },
      order: 1,
    });
  });

  test("write body uses action/config/order", () => {
    const body = workflowWriteBody({
      name: "A",
      triggerType: "call_ended",
      triggerConfig: {},
      steps: [workflowStepToUi({ action: "store_lead", config: { tag: "hot" }, order: 0 })],
      enabled: true,
    });
    expect(body.steps[0].action).toBe("store_lead");
    expect(body.steps[0].config.tag).toBe("hot");
  });
});

describe("fromSubscription", () => {
  test("keeps Plan vs Billing state separate when unbilled", () => {
    const s = fromSubscription({
      configured: false,
      billingState: "unbilled",
      planName: "Professional",
      entitlements: { planName: "Professional", billingStatus: "active" },
      serviceStatus: "active",
    });
    expect(s.configured).toBe(false);
    expect(s.billingState).toBe("unbilled");
    expect(s.serviceStatus).toBe("active");
    expect(s.planName).toBe("Professional");
  });

  test("maps a live Stripe sub", () => {
    const s = fromSubscription({
      configured: true,
      billingState: "subscribed",
      stripeSubscriptionId: "sub_123",
      planName: "Pilot",
      priceCents: 150000,
      status: "active",
    });
    expect(s.configured).toBe(true);
    expect(s.billingState).toBe("subscribed");
    expect(s.stripeSubscriptionId).toBe("sub_123");
    expect(s.priceCents).toBe(150000);
  });
});

describe("billing money helpers", () => {
  test("converts cents to a dollar input and back", () => {
    expect(centsToDollarInput(150000)).toBe("1500.00");
    expect(centsToDollarInput(200000)).toBe("2000.00");
    expect(dollarInputToCents("1,500.00")).toBe(150000);
    expect(dollarInputToCents("3500")).toBe(350000);
    expect(fmtMoney(500000)).toBe("$5,000.00");
    expect(fmtMoney(350000)).toBe("$3,500.00");
  });

  test("includes Pilot in plan tiers", () => {
    expect(PLAN_TIERS).toContain("pilot");
  });
});

describe("call list order", () => {
  test("sorts by started-at newest first, not last-updated", () => {
    const ordered = sortCallsNewestFirst([
      { id: "old", createdAt: "2026-09-06T12:00:00.000Z", updatedAt: "2026-09-08T23:00:00.000Z" },
      { id: "newest", createdAt: "2026-09-08T20:00:00.000Z", updatedAt: "2026-09-08T20:00:10.000Z" },
      { id: "mid", createdAt: "2026-09-07T12:00:00.000Z", updatedAt: "2026-09-08T22:00:00.000Z" },
    ]);
    expect(ordered.map((c) => c.id)).toEqual(["newest", "mid", "old"]);
  });
});
