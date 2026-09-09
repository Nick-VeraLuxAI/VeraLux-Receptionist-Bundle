/**
 * Workflow actions that wrap existing night-desk / FSM / digest primitives.
 */

import type { CallEndedEvent, PipelineContext } from "./types";
import { claimWorkflowFollowup } from "./db";
import { fetchWithTimeoutRetry } from "../httpClient";
import { createApproval, createOncallPage, getShopPlaybookRow, listCompletionsSince, upsertCallCompletion } from "../nightDesk/db";
import { resolveOnCallE164 } from "../nightDesk/oncallResolve";
import { sendNightDeskSms } from "../nightDesk/sms";
import { sendNightDeskEmail } from "../nightDesk/email";
import { sendMorningDigest } from "../nightDesk/digest";
import { checkFeatureEntitlement } from "../featureEntitlements";
import { fsmAdapter, writeBoardJob } from "../fsm";
import type { FsmProvider } from "../fsm/types";

function callEvent(ctx: PipelineContext): CallEndedEvent {
  return ctx.event as CallEndedEvent;
}

function leadFrom(ctx: PipelineContext): Record<string, any> {
  const ev = callEvent(ctx);
  const extracted = Object.values(ctx.stepOutputs).find(
    (out) => out && typeof out === "object" && out.extracted,
  );
  return {
    ...(ev.lead || {}),
    ...(extracted?.extracted || {}),
  };
}

export async function resolveOwnerSms(tenantId: string): Promise<string> {
  const playbook = await getShopPlaybookRow(tenantId);
  return (
    playbook?.playbook?.digest?.smsE164 ||
    playbook?.playbook?.onCallE164 ||
    ""
  );
}

export async function resolveOwnerEmail(tenantId: string): Promise<string> {
  const playbook = await getShopPlaybookRow(tenantId);
  return playbook?.playbook?.digest?.emails?.[0] || "";
}

export async function resolveSmsDestination(
  ctx: PipelineContext,
  to: string | undefined,
): Promise<string> {
  const ev = callEvent(ctx);
  const dest = String(to || "").trim();
  if (!dest || dest === "caller") {
    return String(leadFrom(ctx).phone || ev.callerId || "");
  }
  if (dest === "owner") return resolveOwnerSms(ctx.tenantId);
  return dest;
}

export async function resolveEmailDestination(
  ctx: PipelineContext,
  to: string | undefined,
): Promise<string> {
  const dest = String(to || "").trim();
  if (!dest || dest === "owner") return resolveOwnerEmail(ctx.tenantId);
  if (dest === "caller") return String(leadFrom(ctx).email || "");
  return dest;
}

export async function bookCalendar(
  ctx: PipelineContext,
  config: {
    url?: string;
    holdOnly?: boolean;
    includeTranscript?: boolean;
    includeStepOutputs?: boolean;
  },
): Promise<{ booked: boolean; held: boolean; statusCode?: number; url?: string; reason?: string }> {
  const entitled = await checkFeatureEntitlement(ctx.tenantId, "calendarIntegration", { action: "book_calendar" });
  if (!entitled.allowed) {
    return { booked: false, held: false, reason: "feature_denied_by_plan" };
  }
  if (config.holdOnly) {
    return { booked: false, held: true };
  }
  const ev = callEvent(ctx);
  const lead = leadFrom(ctx);
  const url =
    (config.url && String(config.url).trim()) ||
    process.env.BOOK_HELPER_URL ||
    process.env.DEMO_SHOP_BOOK_HELPER_URL ||
    (ctx.tenantId === "demo-shop"
      ? "http://demo-shop-book-helper:8791/book"
      : "");
  if (!url) {
    return { booked: false, held: true, url: "" };
  }
  const payload: Record<string, unknown> = {
    tenantId: ctx.tenantId,
    callId: ev.callId,
    call_control_id: ev.callId,
    callerId: ev.callerId,
    name: lead.name || lead.customerName,
    phone: lead.phone || ev.callerId,
    email: lead.email,
    address: lead.address || lead.serviceAddress,
    jobType: lead.jobType || lead.issue,
    startIso: lead.startIso,
    notes: ev.transcript,
  };
  if (config.includeStepOutputs) payload.previousSteps = ctx.stepOutputs;
  const resp = await fetchWithTimeoutRetry(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    timeoutMs: 10_000,
    retries: 1,
  });
  return { booked: resp.ok, held: !resp.ok, statusCode: resp.status, url };
}

export async function pageOnCall(
  ctx: PipelineContext,
  config: { reason?: string; timeoutSecs?: number },
): Promise<{ paged: boolean; destination?: string; pageId?: string; reason: string }> {
  const ev = callEvent(ctx);
  const priority = await checkFeatureEntitlement(ctx.tenantId, "prioritySupport", { action: "page_on_call" });
  const resolved = await resolveOnCallE164(ctx.tenantId);
  if (!resolved.e164 || (resolved.quietHours && !priority.allowed)) {
    return { paged: false, reason: `${config.reason || "page"}:no_destination` };
  }
  const page = await createOncallPage({
    tenantId: ctx.tenantId,
    callId: ev.callId || `wf-${ctx.runId}`,
    destinationE164: resolved.e164,
    timeoutSecs: config.timeoutSecs || resolved.timeoutSecs,
  });
  await sendNightDeskSms(
    resolved.e164,
    `VeraLux on-call page: caller ${ev.callerId || "unknown"} (${config.reason || "workflow"}).`,
    ctx.tenantId,
  );
  return {
    paged: true,
    destination: resolved.e164,
    pageId: page?.id,
    reason: config.reason || "page_on_call",
  };
}

export async function sendDigestAction(
  ctx: PipelineContext,
  config: { force?: boolean },
): Promise<{ sent: boolean; localDate?: string; text?: string }> {
  const result = await sendMorningDigest(ctx.tenantId, { force: Boolean(config.force) });
  return { sent: result.sent, localDate: result.localDate, text: result.text };
}

export async function createApprovalAction(
  ctx: PipelineContext,
  config: { summary?: string },
): Promise<{ approvalId?: string; created: boolean }> {
  const ev = callEvent(ctx);
  const summary = String(config.summary || `Workflow inbox item — ${ctx.workflow.name}`).replace(
    "{{callId}}",
    ev.callId || "",
  );
  const row = await createApproval(
    ctx.tenantId,
    summary,
    {
      ...(ev.lead || {}),
      transcript: ev.transcript,
      qa: ev.qa,
      workflowId: ctx.workflow.id,
      workflowName: ctx.workflow.name,
    },
    ev.callId,
  );
  return { approvalId: row?.id, created: Boolean(row?.id) };
}

export async function writeFsmJobAction(
  ctx: PipelineContext,
  config: { provider?: FsmProvider },
): Promise<{ ok: boolean; provider?: string; jobId?: string; dryRun?: boolean; error?: string }> {
  const ev = callEvent(ctx);
  const lead = leadFrom(ctx);
  const input = {
    callId: ev.callId || `wf-${ctx.runId}`,
    idempotencyKey: ev.callId || ctx.runId,
    customer: {
      name: String(lead.name || lead.customerName || ""),
      phone: String(lead.phone || ev.callerId || ""),
      email: typeof lead.email === "string" ? lead.email : undefined,
      address: String(lead.address || lead.serviceAddress || lead.zip || ""),
    },
    jobType: String(lead.jobType || lead.service || lead.issue || "Service call"),
    notes: (ev.transcript || "").slice(0, 4000),
    membership: typeof lead.membership === "string" ? lead.membership : undefined,
    startIso: typeof lead.startIso === "string" ? lead.startIso : undefined,
  };
  const provider = config.provider;
  const result = provider
    ? await fsmAdapter(provider).createCustomerAndJob(ctx.tenantId, input)
    : await writeBoardJob(ctx.tenantId, input);
  return {
    ok: result.ok,
    provider: result.provider,
    jobId: result.jobId,
    dryRun: result.dryRun,
    error: result.error,
  };
}

export async function escalateOrphanAction(
  ctx: PipelineContext,
  _config: Record<string, unknown>,
): Promise<{ escalated: boolean; orphan: boolean; destination?: string }> {
  const ev = callEvent(ctx);
  const playbook = await getShopPlaybookRow(ctx.tenantId);
  const overflow = playbook?.playbook?.humanOverflowE164;
  const callId = ev.callId || `wf-${ctx.runId}`;
  await upsertCallCompletion({
    tenantId: ctx.tenantId,
    callId,
    completion: overflow ? "on_call_paged" : "tasked",
    reason: "orphan_escalate",
    orphanPromise: true,
    source: "workflow",
    input: ev.lead,
    actor: "workflow",
  });
  if (overflow) {
    await createOncallPage({
      tenantId: ctx.tenantId,
      callId,
      destinationE164: overflow,
      timeoutSecs: 45,
    });
    await sendNightDeskSms(
      overflow,
      `VeraLux overflow: unanswered on-call page for ${ev.callerId || callId}.`,
      ctx.tenantId,
    );
    await createApproval(
      ctx.tenantId,
      `Orphan / overflow page for ${callId}`,
      { callerId: ev.callerId, reason: "orphan_escalate" },
      callId,
    );
    return { escalated: true, orphan: true, destination: overflow };
  }
  await createApproval(
    ctx.tenantId,
    `Orphan promise — no overflow destination (${callId})`,
    { callerId: ev.callerId, reason: "orphan_escalate" },
    callId,
  );
  return { escalated: false, orphan: true };
}

export async function holdBookingAction(
  ctx: PipelineContext,
  config: { reason?: string },
): Promise<{ held: boolean; approvalId?: string }> {
  const ev = callEvent(ctx);
  const reason = config.reason || "hold_booking";
  const row = await createApproval(
    ctx.tenantId,
    reason === "storm_mode"
      ? "Storm / surge hold — callback queue"
      : "Booking held by workflow",
    { ...(ev.lead || {}), reason },
    ev.callId,
  );
  if (ev.callId) {
    await upsertCallCompletion({
      tenantId: ctx.tenantId,
      callId: ev.callId,
      completion: "approval_held",
      reason,
      source: "workflow",
      input: ev.lead,
      actor: "workflow",
    });
  }
  return { held: true, approvalId: row?.id };
}

function startIsoFromRow(row: Record<string, any>): string | null {
  const input = row.input && typeof row.input === "object" ? row.input : {};
  const raw = input.startIso || input.start_iso || input.appointmentStart;
  return typeof raw === "string" && raw ? raw : null;
}

export async function estimateFollowupAction(
  ctx: PipelineContext,
  config: {
    delayHours?: number;
    to?: string;
    ownerFallback?: boolean;
    message?: string;
  },
): Promise<{ scanned: number; sent: number }> {
  const delayHours = Number(config.delayHours || 24);
  const since = new Date(Date.now() - (delayHours + 24) * 3600_000).toISOString();
  const cutoff = Date.now() - delayHours * 3600_000;
  const rows = await listCompletionsSince(ctx.tenantId, since);
  let sent = 0;
  let scanned = 0;
  const message =
    config.message ||
    "Hi, just checking in on the estimate we discussed. Reply here or call us back when you are ready.";
  for (const row of rows) {
    const created = new Date(row.created_at || row.updated_at || 0).getTime();
    const completion = String(row.completion || "");
    const reason = String(row.reason || "");
    const input = row.input && typeof row.input === "object" ? row.input : {};
    const held =
      completion === "approval_held" ||
      reason === "quote_hold" ||
      (typeof input.quoteCents === "number" && input.quoteCents > 0);
    if (!held || created > cutoff) continue;
    scanned += 1;
    const callId = String(row.call_id || "");
    const claimed = await claimWorkflowFollowup({
      tenantId: ctx.tenantId,
      callId,
      kind: "estimate_followup",
      workflowId: ctx.workflow.id,
    });
    if (!claimed.claimed) continue;
    const phone = String(input.phone || "");
    const owner = await resolveOwnerSms(ctx.tenantId);
    const dest =
      config.to === "owner" ? owner : phone || (config.ownerFallback === false ? "" : owner);
    if (!dest) continue;
    const text = message.replace("{{name}}", String(input.name || "there"));
    const ok = await sendNightDeskSms(dest, text, ctx.tenantId);
    if (ok) sent += 1;
  }
  return { scanned, sent };
}

export async function noshowAlertAction(
  ctx: PipelineContext,
  config: { windowHours?: number; to?: string },
): Promise<{ scanned: number; sent: number }> {
  const windowHours = Number(config.windowHours || 2);
  const since = new Date(Date.now() - 14 * 86400_000).toISOString();
  const rows = await listCompletionsSince(ctx.tenantId, since);
  let sent = 0;
  let scanned = 0;
  const ownerSms = await resolveOwnerSms(ctx.tenantId);
  const ownerEmail = await resolveOwnerEmail(ctx.tenantId);
  for (const row of rows) {
    if (String(row.completion) !== "booked") continue;
    const startIso = startIsoFromRow(row);
    const start = startIso
      ? Date.parse(startIso)
      : new Date(row.created_at || 0).getTime();
    if (!Number.isFinite(start)) continue;
    const windowEnd = start + windowHours * 3600_000;
    if (Date.now() < windowEnd) continue;
    const input = row.input && typeof row.input === "object" ? row.input : {};
    if (input.checkedIn || input.completed || input.jobStatus === "complete") continue;
    scanned += 1;
    const callId = String(row.call_id || "");
    const claimed = await claimWorkflowFollowup({
      tenantId: ctx.tenantId,
      callId,
      kind: "noshow_alert",
      workflowId: ctx.workflow.id,
    });
    if (!claimed.claimed) continue;
    const text = `VeraLux no-show: booked window for ${input.name || callId} passed without check-in.`;
    let ok = false;
    if (ownerSms) ok = await sendNightDeskSms(ownerSms, text, ctx.tenantId);
    if (ownerEmail) {
      const emailed = await sendNightDeskEmail({
        to: ownerEmail,
        subject: "Booked no-show — follow up",
        text,
      });
      ok = ok || emailed;
    }
    if (ok) sent += 1;
  }
  return { scanned, sent };
}
