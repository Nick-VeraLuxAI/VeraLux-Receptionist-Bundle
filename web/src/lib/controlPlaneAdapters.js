/**
 * Map Emergent UI shapes to the VeraLux control-plane contract.
 * Do not change backend JSON; adapt at the edge.
 */

export function normalizeTtsPreviewJob(job) {
  if (!job || typeof job !== "object") {
    return { status: "failed", error: "empty_job" };
  }
  const status = job.status;
  const ready = status === "ready" || status === "done";
  const failed = status === "failed" || status === "error";
  const audioB64 = job.audioWavBase64 || job.audioBase64 || null;
  const audioUrl = job.audioUrl || job.url || null;
  return {
    status: ready ? "ready" : failed ? "failed" : status || "pending",
    error: job.error || job.message || null,
    audioWavBase64: audioB64,
    audioUrl,
    contentType: job.contentType || "audio/wav",
  };
}

export function ttsPreviewAudioSrc(job) {
  const n = normalizeTtsPreviewJob(job);
  if (n.audioWavBase64) {
    return `data:${n.contentType};base64,${n.audioWavBase64}`;
  }
  return n.audioUrl || null;
}

export function toSuggestRequest(ui = {}) {
  const forwardingLines = Array.isArray(ui.forwardingLines)
    ? ui.forwardingLines.map((line) => {
        if (typeof line === "string") return line;
        if (line && typeof line === "object") {
          return [line.name, line.number, line.role].filter(Boolean).join(" — ");
        }
        return "";
      }).filter(Boolean)
    : undefined;
  return {
    greetingText: ui.greetingText || ui.greeting || undefined,
    systemPreamble: ui.systemPreamble || undefined,
    voicePrompt: ui.voicePrompt || undefined,
    policyPrompt: ui.policyPrompt || undefined,
    pricingItems: ui.pricingItems,
    pricingNotes: ui.pricingNotes || ui.notes || undefined,
    forwardingLines,
    maxIntents: ui.maxIntents,
  };
}

export function fromSuggestResponse(res) {
  const list = (res && (res.quickReplies || res.suggestions)) || [];
  return Array.isArray(list) ? list : [];
}

export function normalizeTenantUpsert(res) {
  if (!res || typeof res !== "object") return { tenant: null, created: false };
  if (res.tenant) {
    return { tenant: res.tenant, created: !!res.created };
  }
  return { tenant: res, created: false };
}

export function lastPublishedFromRuntimeConfig(res) {
  if (!res || typeof res !== "object") return null;
  if (res.lastRuntimePublishedAt) return res.lastRuntimePublishedAt;
  const cfg = res.config;
  if (cfg && cfg.lastRuntimePublishedAt) return cfg.lastRuntimePublishedAt;
  const rp = res.runtimePublish;
  if (rp && rp.lastRuntimePublishedAt) return rp.lastRuntimePublishedAt;
  return res.publishedAt || null;
}

/** POST /api/tts/config returns runtimePublish.ok, not published. */
export function fromTtsConfigSave(res) {
  if (!res || typeof res !== "object") {
    return { published: false, lastRuntimePublishedAt: null };
  }
  const runtime = res.runtimePublish;
  const published = res.published === true || (runtime && runtime.ok === true);
  return {
    published,
    lastRuntimePublishedAt: lastPublishedFromRuntimeConfig(res),
    runtimePublish: runtime || null,
  };
}

/** Live concurrency only — never fall back to monthly/daily totals or a stored peak. */
function liveConcurrentNow(raw = {}) {
  if (raw.concurrentCallsNow != null) {
    const n = Number(raw.concurrentCallsNow);
    return Number.isFinite(n) ? n : 0;
  }
  const active = raw.activeCalls;
  if (active == null) return 0;
  if (active === raw.monthlyCalls || active === raw.dailyCalls) return 0;
  const n = Number(active);
  return Number.isFinite(n) ? n : 0;
}

/** The real usage endpoint omits limits and uses DB-oriented counter names. */
export function mergeUsageWithLimits(usageRes = {}, limitsRes = {}) {
  const limits = limitsRes.limits || usageRes.limits || {};
  const raw = usageRes.usage || {};
  const usage = {
    ...raw,
    minutesUsed: raw.minutesUsed ?? raw.monthlyBillableMinutes,
    callsThisMonth: raw.callsThisMonth ?? raw.monthlyCalls,
    callsToday: raw.callsToday ?? raw.dailyCalls,
    concurrentCallsNow: liveConcurrentNow(raw),
    concurrentCallsPeak: raw.concurrentCallsPeak ?? liveConcurrentNow(raw),
    phoneNumbers: raw.phoneNumbers,
  };
  return {
    ...usageRes,
    usage,
    limits,
    overageMode: usageRes.overageMode ?? limits.overageMode,
  };
}

function finiteNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** GET billing-summary returns { tenantId, summary }, not the flat card fields. */
export function fromTenantBillingSummary(res = {}, limitsRes = {}) {
  const summary = res && res.summary && typeof res.summary === "object" ? res.summary : res || {};
  const limits = (limitsRes && limitsRes.limits) || {};
  const minutesUsed = finiteNumber(summary.billableMinutes ?? summary.minutesUsed) ?? 0;
  const includedMinutes = finiteNumber(summary.includedMinutes ?? limits.includedMonthlyMinutes) ?? 0;
  const overageMinutes = finiteNumber(summary.overageMinutes) ?? 0;
  const overageRateCents = finiteNumber(
    summary.overageRateCents ?? summary.monthlyMinuteOverageRateCents ?? limits.monthlyMinuteOverageRateCents,
  );
  const overageChargeCents = finiteNumber(summary.estimatedOverageChargeCents) ?? (
    overageRateCents == null ? 0 : overageMinutes * overageRateCents
  );
  const callsCount = finiteNumber(summary.callsCount) ?? 0;
  const planTier = summary.planTier || limits.planTier || "";
  const billingStatus = summary.billingStatus || limits.billingStatus || "";
  return {
    month: summary.month || null,
    planTier,
    planName: planTier ? String(planTier).replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()) : "No plan",
    billingStatus: billingStatus || "unknown",
    currency: "usd",
    minutesUsed,
    includedMinutes,
    overageMinutes,
    overageRateCents,
    estimatedOverageChargeCents: overageChargeCents,
    estimatedTotalCents: overageChargeCents,
    callsCount,
    lineItems: [{ label: "Overage charge", amountCents: overageChargeCents }],
    subscriptionConfigured: false,
  };
}

export async function loadBillingSummary(api, tenantId, month) {
  const [summaryRes, limitsRes] = await Promise.all([
    api.get(`/api/admin/tenants/${tenantId}/billing-summary?month=${month}`),
    api.get(`/api/admin/tenants/${tenantId}/limits`),
  ]);
  return fromTenantBillingSummary(summaryRes, limitsRes);
}

export async function loadUsageWithLimits(api, tenantId) {
  const [usageRes, limitsRes] = await Promise.all([
    api.get(`/api/admin/tenants/${tenantId}/usage`),
    api.get(`/api/admin/tenants/${tenantId}/limits`),
  ]);
  return mergeUsageWithLimits(usageRes, limitsRes);
}

const HEALTHY_SERVICE_STATUSES = new Set(["ok", "ready", "configured", "defaulting", "healthy", "up"]);

/** Real /api/admin/health uses ready/configured, not status:"ok". */
export function isServiceStatusOk(status) {
  if (status == null || status === "") return false;
  return HEALTHY_SERVICE_STATUSES.has(String(status).toLowerCase());
}

/**
 * GET /api/admin/health returns { server, llm.status, stt.status, tts.status }
 * with no top-level status. Portal/admin treated that as degraded.
 */
export function fromAdminHealth(res) {
  if (!res || typeof res !== "object") {
    return { status: "unreachable", ok: false, activeCalls: 0 };
  }
  const llmOk = !res.llm || isServiceStatusOk(res.llm.status);
  const sttOk = !res.stt || isServiceStatusOk(res.stt.status);
  const ttsOk = !res.tts || isServiceStatusOk(res.tts.status);
  const explicit = typeof res.status === "string" ? res.status.toLowerCase() : "";
  const serverOk = res.server === "ok" || explicit === "ok" || res.ok === true;
  const ok = explicit === "degraded" || explicit === "error"
    ? false
    : explicit === "ok" || (serverOk && llmOk && sttOk && ttsOk);
  return {
    ...res,
    status: ok ? "ok" : explicit || "degraded",
    ok,
    activeCalls: res.activeCalls ?? res.activeCallsGlobal ?? 0,
    timestamp: res.timestamp || null,
  };
}

/** GET /api/admin/runtime/health returns { ok, latencyMs }, not status:"ok". */
export function fromRuntimeHealth(res) {
  if (!res || typeof res !== "object") {
    return { status: "degraded", ok: false };
  }
  const ok = res.ok === true || res.status === "ok";
  return {
    ...res,
    ok,
    status: ok ? "ok" : res.status || "degraded",
    redis: res.redis || { connected: ok, latencyMs: res.latencyMs },
    checkedAt: res.checkedAt || null,
  };
}

/**
 * GET /api/admin/analytics returns flat totals (totalCalls, missedCalls),
 * not { totals: { calls }, daily, previousPeriod }.
 */
export function fromAnalytics(res) {
  if (!res || typeof res !== "object") {
    return {
      totals: { calls: 0, leads: 0, missedCalls: 0, minutes: 0, avgDurationSec: 0, booked: 0 },
      previousPeriod: null,
      daily: [],
      byHour: [],
      intents: [],
      outcomes: [],
      leadStages: [],
      topQuestions: [],
    };
  }
  const topQuestions = Array.isArray(res.topQuestions) ? res.topQuestions : [];
  const intents = Array.isArray(res.intents) && res.intents.length
    ? res.intents
    : topQuestions.map((q) => ({ intent: q.text || q.intent, count: q.count }));
  const totals = res.totals && typeof res.totals === "object"
    ? {
        calls: res.totals.calls ?? res.totalCalls ?? res.callCount ?? 0,
        leads: res.totals.leads ?? 0,
        missedCalls: res.totals.missedCalls ?? res.missedCalls ?? 0,
        minutes: res.totals.minutes ?? 0,
        avgDurationSec: res.totals.avgDurationSec ?? 0,
        booked: res.totals.booked ?? 0,
      }
    : {
        calls: res.totalCalls ?? res.callCount ?? 0,
        leads: res.leads ?? 0,
        missedCalls: res.missedCalls ?? 0,
        minutes: res.minutes ?? 0,
        avgDurationSec: res.avgDurationSec ?? 0,
        booked: res.booked ?? 0,
      };
  return {
    ...res,
    totals,
    previousPeriod: res.previousPeriod || null,
    daily: Array.isArray(res.daily) ? res.daily : [],
    byHour: Array.isArray(res.byHour) ? res.byHour : [],
    intents,
    outcomes: Array.isArray(res.outcomes) ? res.outcomes : [],
    leadStages: Array.isArray(res.leadStages) ? res.leadStages : [],
    topQuestions,
  };
}

export const REAL_WORKFLOW_TRIGGERS = [
  "call_ended",
  "after_hours_call",
  "keyword_detected",
  "missed_call",
  "scheduled",
  "booking_succeeded",
  "qa_flagged",
  "job_completed",
];

export const REAL_WORKFLOW_ACTIONS = [
  "send_email",
  "send_sms",
  "fire_webhook",
  "ai_summarize",
  "ai_extract",
  "store_lead",
  "book_calendar",
  "page_on_call",
  "send_digest",
  "create_approval",
  "write_fsm_job",
  "escalate_orphan",
  "hold_booking",
  "estimate_followup",
  "noshow_alert",
];

const ACTION_FROM_UI_TYPE = {
  send_sms: "send_sms",
  send_email: "send_email",
  fire_webhook: "fire_webhook",
  webhook: "fire_webhook",
  ai_summarize: "ai_summarize",
  ai_extract: "ai_extract",
  store_lead: "store_lead",
  tag_lead: "store_lead",
  notify_owner: "send_sms",
  book_calendar: "book_calendar",
  page_on_call: "page_on_call",
  send_digest: "send_digest",
  create_approval: "create_approval",
  write_fsm_job: "write_fsm_job",
  escalate_orphan: "escalate_orphan",
  hold_booking: "hold_booking",
  estimate_followup: "estimate_followup",
  noshow_alert: "noshow_alert",
};

export function workflowStepToUi(step, index = 0) {
  if (!step || typeof step !== "object") {
    return { type: "send_sms", to: "caller", template: "", order: index };
  }
  const action = step.action || ACTION_FROM_UI_TYPE[step.type] || step.type || "send_sms";
  const config = step.config && typeof step.config === "object" ? step.config : {};
  return {
    type: action,
    action,
    order: step.order != null ? step.order : index,
    to: step.to || config.to || "caller",
    template: step.template || config.template || config.body || config.message || "",
    url: step.url || config.url || "",
    tag: step.tag || config.tag || "",
    channel: step.channel || config.channel || "sms",
    provider: step.provider || config.provider || "",
    config,
  };
}

export function workflowStepToApi(step, index = 0) {
  const type = step.action || ACTION_FROM_UI_TYPE[step.type] || step.type || "send_sms";
  const config = { ...(step.config && typeof step.config === "object" ? step.config : {}) };
  if (type === "send_sms" || type === "send_email") {
    if (step.to) config.to = step.to;
    if (step.template) config.template = step.template;
    if (step.channel) config.channel = step.channel;
  }
  if ((type === "fire_webhook" || type === "book_calendar") && step.url) config.url = step.url;
  if (type === "store_lead" && step.tag) config.tag = step.tag;
  if (type === "write_fsm_job" && step.provider) config.provider = step.provider;
  return { action: type, config, order: index };
}

export function workflowToUi(workflow) {
  if (!workflow) return workflow;
  return {
    ...workflow,
    steps: (workflow.steps || []).map((s, i) => workflowStepToUi(s, i)),
  };
}

export function mergeWorkflowListPayload(workflowsRes, settingsRes) {
  const workflows = ((workflowsRes && workflowsRes.workflows) || []).map(workflowToUi);
  const settings = (settingsRes && typeof settingsRes === "object")
    ? settingsRes
    : { ownerCanEdit: false };
  return {
    workflows,
    settings,
    triggerTypes: REAL_WORKFLOW_TRIGGERS,
    stepTypes: REAL_WORKFLOW_ACTIONS,
  };
}

export const TENANT_LLM_PROVIDERS = [
  { id: "openai", label: "OpenAI", defaultModel: "gpt-4o-mini" },
  { id: "anthropic", label: "Anthropic", defaultModel: "claude-sonnet-4-5" },
  { id: "google", label: "Google Gemini", defaultModel: "gemini-2.5-flash" },
  { id: "groq", label: "Groq", defaultModel: "openai/gpt-oss-120b" },
  { id: "xai", label: "xAI Grok", defaultModel: "grok-3-mini" },
];

export const ONPREM_PLATFORM_MODEL = "Qwen3.5-27B-GPTQ-Int4";

/** GET llm-config uses platform_default / tenant_api_key; the panel uses platform / tenant. */
export function fromLlmConfig(data) {
  const raw = data && typeof data === "object" ? data : {};
  const mode =
    raw.mode === "tenant_api_key" || raw.mode === "tenant" ? "tenant" : "platform";
  const tenantProvider = raw.tenantProvider || raw.provider || "openai";
  return {
    mode,
    tenantProvider,
    tenantModel: raw.tenantModel || raw.model || "",
    hasApiKey: raw.hasApiKey === true || raw.configured === true,
    platformModel: raw.platformModel || ONPREM_PLATFORM_MODEL,
    platformProvider: raw.platformProvider || "local",
    lastStatus: raw.lastStatus || null,
    lastTestedAt: raw.lastTestedAt || null,
  };
}

export function toLlmConfigSave(form = {}) {
  if (form.mode === "tenant") {
    const body = {
      mode: "tenant_api_key",
      tenantProvider: form.tenantProvider || "openai",
      tenantModel: form.tenantModel || undefined,
    };
    if (form.apiKey) body.apiKey = form.apiKey;
    if (form.removeApiKey) body.removeApiKey = true;
    return body;
  }
  return { mode: "platform_default" };
}

export function workflowWriteBody(form) {
  return {
    name: form.name,
    triggerType: form.triggerType,
    triggerConfig: form.triggerConfig || {},
    steps: (form.steps || []).map((s, i) => workflowStepToApi(s, i)),
    enabled: form.enabled,
    adminLocked: form.adminLocked,
    templateId: form.templateId || undefined,
  };
}

export function fromWorkflowRuns(res, now = Date.now()) {
  const runs = Array.isArray(res && res.runs) ? res.runs : [];
  const serverAlreadyToday = Boolean(res && res.today);
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  return {
    today: true,
    timezone: (res && res.timezone) || null,
    runs: runs
      .filter((r) => {
        if (serverAlreadyToday) return true;
        if (!r || !r.startedAt) return true;
        const started = new Date(r.startedAt).getTime();
        return Number.isFinite(started) && started >= startOfToday.getTime();
      })
      .map((r) => ({
        ...r,
        workflowName: r.workflowName || r.name || "Workflow",
        trigger: r.trigger || (r.triggerEvent && r.triggerEvent.type) || r.triggerType || "call_ended",
        status:
          r.status === "completed"
            ? "succeeded"
            : r.status === "dry_run"
              ? "dry_run"
              : r.status,
        stepResults: r.stepResults || r.result || [],
      })),
  };
}

export function fromSubscription(res) {
  const raw = res && typeof res === "object" ? res : {};
  const stripeSubId = raw.stripeSubscriptionId && raw.stripeSubscriptionId !== "present" ? raw.stripeSubscriptionId : raw.stripeSubscriptionId || null;
  const billingState =
    raw.billingState ||
    (!stripeSubId && raw.configured !== true
      ? "unbilled"
      : raw.status === "past_due" || raw.status === "unpaid"
        ? "past_due"
        : raw.status === "canceled" || raw.status === "cancelled"
          ? "canceled"
          : stripeSubId || raw.configured
            ? "subscribed"
            : "unbilled");
  const entitlements = raw.entitlements || {};
  return {
    ...raw,
    configured: billingState !== "unbilled",
    billingState,
    billingStateLabel: raw.billingStateLabel || billingState,
    planName: raw.planName || entitlements.planName || null,
    priceCents: raw.priceCents ?? null,
    currency: raw.currency || "usd",
    billingInterval: raw.billingInterval || raw.billingFrequency || "month",
    status: raw.status || null,
    currentPeriodStart: raw.currentPeriodStart || null,
    currentPeriodEnd: raw.currentPeriodEnd || raw.nextBillingDate || null,
    showBillingPortal: !!raw.showBillingPortal,
    liveMode: !!raw.liveMode,
    serviceStatus: raw.serviceStatus || entitlements.billingStatus || null,
    entitlements,
    stripeCustomerId: raw.stripeCustomerId || null,
    stripeSubscriptionId: stripeSubId,
    stripePriceId: raw.stripePriceId || null,
  };
}

export function fromWorkflowTest(res) {
  const raw = res && typeof res === "object" ? res : {};
  const steps = Array.isArray(raw.steps) ? raw.steps : [];
  return {
    matched: raw.matched === true || raw.wouldMatch === true,
    wouldMatch: raw.wouldMatch === true || raw.matched === true,
    enabled: raw.enabled !== false,
    reason: raw.reason || (raw.wouldMatch || raw.matched ? "Trigger would fire" : "Trigger would not fire"),
    sample: raw.sample || null,
    run: raw.run || null,
    steps: steps.map((s) => ({
      ...s,
      type: s.type || s.action,
      rendered: s.rendered || (s.output && s.output.description) || "",
    })),
  };
}
