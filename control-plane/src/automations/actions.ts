/**
 * Built-in workflow action handlers.
 *
 * Each action receives a PipelineContext and its step config,
 * and returns an output object.
 */

import type { PipelineContext, CallEndedEvent } from "./types";
import { createLead, findLeadByCallId, updateLead } from "./db";
import * as crypto from "crypto";
import { fetchWithTimeoutRetry } from "../httpClient";
import { checkFeatureEntitlement } from "../featureEntitlements";
import {
  bookCalendar,
  createApprovalAction,
  escalateOrphanAction,
  estimateFollowupAction,
  holdBookingAction,
  noshowAlertAction,
  pageOnCall,
  resolveEmailDestination,
  resolveSmsDestination,
  sendDigestAction,
  writeFsmJobAction,
} from "./templateActions";

// ── send_email ───────────────────────────────────

export async function sendEmail(
  ctx: PipelineContext,
  config: {
    to: string;
    subject?: string;
    body?: string;
    template?: string;
    smtpHost?: string;
    smtpPort?: number;
    smtpUser?: string;
    smtpPass?: string;
    fromAddress?: string;
  }
): Promise<{ sent: boolean; to: string; subject: string }> {
  // Dynamically import nodemailer (it may not be installed yet)
  let nodemailer: any;
  try {
    nodemailer = await import("nodemailer");
  } catch {
    console.warn("[actions/send_email] nodemailer not installed, skipping");
    return { sent: false, to: config.to, subject: config.subject ?? "" };
  }

  // Get SMTP config from step config or env
  const host = config.smtpHost || process.env.SMTP_HOST || "localhost";
  const port = config.smtpPort || parseInt(process.env.SMTP_PORT || "587");
  const user = config.smtpUser || process.env.SMTP_USER || "";
  const pass = config.smtpPass || process.env.SMTP_PASS || "";
  const from =
    config.fromAddress || process.env.SMTP_FROM || "noreply@localhost";

  const subject = interpolate(config.subject || "Workflow notification", ctx);
  const body = interpolate(config.body || config.template || "A workflow event occurred.", ctx);
  const to = await resolveEmailDestination(ctx, config.to);
  if (!to) {
    console.warn("[actions/send_email] No destination resolved");
    return { sent: false, to: config.to, subject };
  }

  const transporter = nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: user ? { user, pass } : undefined,
  });

  await transporter.sendMail({
    from,
    to,
    subject,
    text: body,
    html: body.replace(/\n/g, "<br>"),
  });

  return { sent: true, to, subject };
}

// ── send_sms ─────────────────────────────────────

export async function sendSms(
  ctx: PipelineContext,
  config: {
    to: string;
    message?: string;
    template?: string;
    from?: string;
    reviewUrl?: string;
  }
): Promise<{ sent: boolean; to: string; reason?: string }> {
  const entitled = await checkFeatureEntitlement(ctx.tenantId, "smsFollowup", { action: "send_sms" });
  if (!entitled.allowed) {
    return { sent: false, to: config.to || "", reason: "feature_denied_by_plan" };
  }
  const message = interpolate(
    config.message ||
      config.template ||
      process.env.WORKFLOW_SMS_DEFAULT_MESSAGE?.trim() ||
      "You have a new notification.",
    ctx,
  ).split("{{reviewUrl}}").join(String(config.reviewUrl || ""));
  const to = await resolveSmsDestination(ctx, config.to);
  const from = config.from || process.env.TELNYX_PHONE_NUMBER;

  if (!from) {
    console.warn("[actions/send_sms] No from number configured");
    return { sent: false, to };
  }
  if (!to) {
    console.warn("[actions/send_sms] No destination resolved");
    return { sent: false, to: config.to || "" };
  }

  const apiKey = process.env.TELNYX_API_KEY;
  if (!apiKey) {
    console.warn("[actions/send_sms] TELNYX_API_KEY not set");
    return { sent: false, to: config.to };
  }

  try {
    const resp = await fetchWithTimeoutRetry("https://api.telnyx.com/v2/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        from,
        to,
        text: message,
      }),
      timeoutMs: 10_000,
      retries: 2,
    });

    if (!resp.ok) {
      const errBody = await resp.text();
      console.error("[actions/send_sms] Telnyx error:", errBody);
      return { sent: false, to };
    }

    return { sent: true, to };
  } catch (err) {
    console.error("[actions/send_sms] Error:", err);
    return { sent: false, to };
  }
}

// ── fire_webhook ─────────────────────────────────

export async function fireWebhook(
  ctx: PipelineContext,
  config: {
    url: string;
    method?: string;
    headers?: Record<string, string>;
    secret?: string;
    includeTranscript?: boolean;
    includeStepOutputs?: boolean;
  }
): Promise<{ statusCode: number; success: boolean }> {
  const payload: Record<string, any> = {
    event: ctx.event.type,
    tenantId: ctx.tenantId,
    workflowId: ctx.workflow.id,
    workflowName: ctx.workflow.name,
    runId: ctx.runId,
    timestamp: new Date().toISOString(),
  };

  if (config.includeTranscript !== false && ctx.event.type !== "scheduled") {
    const callEvent = ctx.event as CallEndedEvent;
    payload.transcript = callEvent.transcript;
    payload.callId = callEvent.callId;
    payload.callerId = callEvent.callerId;
  }

  if (config.includeStepOutputs) {
    payload.previousSteps = ctx.stepOutputs;
  }

  const bodyStr = JSON.stringify(payload);

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(config.headers ?? {}),
  };

  // HMAC signature
  if (config.secret) {
    const sig = crypto
      .createHmac("sha256", config.secret)
      .update(bodyStr)
      .digest("hex");
    headers["X-Veralux-Signature"] = sig;
  }

  const resp = await fetchWithTimeoutRetry(config.url, {
    method: config.method || "POST",
    headers,
    body: bodyStr,
    timeoutMs: 10_000,
    retries: 2,
  });

  return {
    statusCode: resp.status,
    success: resp.ok,
  };
}

// ── ai_summarize ─────────────────────────────────

export async function aiSummarize(
  ctx: PipelineContext,
  config: {
    prompt?: string;
    maxTokens?: number;
    model?: string;
  }
): Promise<{ summary: string }> {
  const callEvent = ctx.event as CallEndedEvent;
  const transcript =
    callEvent.transcript ??
    callEvent.turns?.map(t => `${t.role}: ${t.content}`).join("\n") ??
    "";

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return { summary: "[OpenAI API key not configured]" };
  }

  const systemPrompt =
    config.prompt ??
    "You are an assistant that summarizes phone call transcripts. Provide a concise summary including key points, action items, and any follow-up needed.";

  const model = config.model || process.env.OPENAI_MODEL || "gpt-4o-mini";

  const resp = await fetchWithTimeoutRetry("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: `Please summarize the following call transcript:\n\n${transcript}` },
      ],
      max_tokens: config.maxTokens || 500,
      temperature: 0.3,
    }),
    timeoutMs: 25_000,
    retries: 1,
  });

  if (!resp.ok) {
    const errText = await resp.text();
    console.error("[actions/ai_summarize] OpenAI error:", errText);
    return { summary: `[AI summarize error: ${resp.status}]` };
  }

  const data = await resp.json() as any;
  return {
    summary: data.choices?.[0]?.message?.content?.trim() ?? "[No summary generated]",
  };
}

// ── ai_extract ───────────────────────────────────

export async function aiExtract(
  ctx: PipelineContext,
  config: {
    prompt?: string;
    fields?: string[];
    model?: string;
  }
): Promise<{ extracted: Record<string, any> }> {
  const callEvent = ctx.event as CallEndedEvent;
  const transcript =
    callEvent.transcript ??
    callEvent.turns?.map(t => `${t.role}: ${t.content}`).join("\n") ??
    "";

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return { extracted: { error: "OpenAI API key not configured" } };
  }

  const fields = config.fields ?? ["name", "phone", "email", "issue", "category", "priority"];

  const systemPrompt =
    config.prompt ??
    `You are a data extraction assistant. Extract the following fields from the phone call transcript: ${fields.join(", ")}. Return a JSON object with these fields. If a field is not found, use null.`;

  const model = config.model || process.env.OPENAI_MODEL || "gpt-4o-mini";

  const resp = await fetchWithTimeoutRetry("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: `Extract data from this call transcript:\n\n${transcript}` },
      ],
      max_tokens: 500,
      temperature: 0,
      response_format: { type: "json_object" },
    }),
    timeoutMs: 25_000,
    retries: 1,
  });

  if (!resp.ok) {
    const errText = await resp.text();
    console.error("[actions/ai_extract] OpenAI error:", errText);
    return { extracted: { error: `AI extraction error: ${resp.status}` } };
  }

  const data = await resp.json() as any;
  const content = data.choices?.[0]?.message?.content?.trim() ?? "{}";

  try {
    return { extracted: JSON.parse(content) };
  } catch {
    return { extracted: { raw: content } };
  }
}

// ── store_lead ───────────────────────────────────

export async function storeLead(
  ctx: PipelineContext,
  config: {
    /** Use extracted data from a previous ai_extract step (by order number) */
    fromStep?: number;
    name?: string;
    phone?: string;
    email?: string;
    issue?: string;
    category?: string;
    priority?: string;
    notes?: string;
    tag?: string;
    upsert?: boolean;
  }
): Promise<{ leadId: string; upserted?: boolean }> {
  const callEvent = ctx.event as CallEndedEvent;

  // Get data from a previous AI extract step if specified
  let extractedData: Record<string, any> = {};
  if (config.fromStep !== undefined && ctx.stepOutputs[config.fromStep]) {
    extractedData = ctx.stepOutputs[config.fromStep]?.extracted ?? {};
  }

  // Also check the event's lead data
  const eventLead = callEvent.lead ?? {};

  // Merge: config overrides > extracted > event lead
  const leadData = {
    tenantId: ctx.tenantId,
    callId: callEvent.callId ?? undefined,
    name: config.name || extractedData.name || eventLead.name || undefined,
    phone: config.phone || extractedData.phone || eventLead.phone || callEvent.callerId || undefined,
    email: config.email || extractedData.email || eventLead.email || undefined,
    issue: config.issue || extractedData.issue || eventLead.issue || undefined,
    category: config.category || extractedData.category || eventLead.category || config.tag || undefined,
    priority: config.priority || extractedData.priority || "normal",
    notes: config.notes || extractedData.notes || undefined,
    rawExtract: Object.keys(extractedData).length ? extractedData : undefined,
    sourceWorkflowId: ctx.workflow.id,
  };

  if (config.upsert !== false && leadData.callId) {
    const existing = await findLeadByCallId(ctx.tenantId, leadData.callId);
    if (existing) {
      const updated = await updateLead(existing.id, {
        name: leadData.name,
        phone: leadData.phone,
        email: leadData.email,
        issue: leadData.issue,
        category: leadData.category,
        priority: leadData.priority,
        notes: leadData.notes,
        rawExtract: leadData.rawExtract,
      });
      return { leadId: updated?.id || existing.id, upserted: true };
    }
  }

  const lead = await createLead(leadData);
  return { leadId: lead.id };
}

// ── Template interpolation ───────────────────────

/**
 * Simple template interpolation for email/SMS bodies.
 * Supports {{caller}}, {{transcript}}, {{summary}}, {{tenant}}, etc.
 */
function interpolate(template: string, ctx: PipelineContext): string {
  const callEvent = ctx.event as CallEndedEvent;
  const replacements: Record<string, string> = {
    "{{caller}}": callEvent.callerId ?? "Unknown",
    "{{callId}}": callEvent.callId ?? "",
    "{{tenant}}": ctx.tenantId,
    "{{workflow}}": ctx.workflow.name,
    "{{timestamp}}": new Date().toISOString(),
    "{{transcript}}":
      callEvent.transcript ??
      callEvent.turns?.map(t => `${t.role}: ${t.content}`).join("\n") ??
      "(no transcript)",
    "{{name}}": String(callEvent.lead?.name || callEvent.lead?.customerName || "there"),
    "{{reviewUrl}}": String(
      (ctx.stepOutputs && Object.values(ctx.stepOutputs).find((o) => o?.reviewUrl)?.reviewUrl) ||
        callEvent.reviewUrl ||
        callEvent.lead?.reviewUrl ||
        "",
    ),
  };

  // Also substitute step outputs like {{step.1.summary}}
  for (const [order, output] of Object.entries(ctx.stepOutputs)) {
    if (typeof output === "object" && output !== null) {
      for (const [key, value] of Object.entries(output)) {
        replacements[`{{step.${order}.${key}}}`] = String(value ?? "");
      }
    }
  }

  let result = template;
  for (const [token, value] of Object.entries(replacements)) {
    result = result.split(token).join(value);
  }
  return result;
}

// ── Action registry ──────────────────────────────

export const actionHandlers: Record<
  string,
  (ctx: PipelineContext, config: Record<string, any>) => Promise<any>
> = {
  send_email: sendEmail as any,
  send_sms: sendSms as any,
  fire_webhook: fireWebhook as any,
  ai_summarize: aiSummarize as any,
  ai_extract: aiExtract as any,
  store_lead: storeLead as any,
  book_calendar: bookCalendar as any,
  page_on_call: pageOnCall as any,
  send_digest: sendDigestAction as any,
  create_approval: createApprovalAction as any,
  write_fsm_job: writeFsmJobAction as any,
  escalate_orphan: escalateOrphanAction as any,
  hold_booking: holdBookingAction as any,
  estimate_followup: estimateFollowupAction as any,
  noshow_alert: noshowAlertAction as any,
};

