/**
 * In-process event bus for workflow triggers.
 *
 * The voice runtime POSTs call events to the control plane.
 * This module receives those events, derives secondary triggers
 * (after_hours, keyword, missed, booking, QA, job complete),
 * and dispatches to the matcher.
 */

import { CALL_COMPLETIONS, type CallCompletion } from "@veralux/shared";
import type { CallEndedEvent, WorkflowEvent, TriggerType } from "./types";
import { matchAndEnqueue } from "./matcher";
import { finalizeCallCompletion } from "../nightDesk/complete";
import { scoreNightDeskCall } from "../nightDesk/qa";
import { getShopPlaybookRow } from "../nightDesk/db";
import { evaluateBusinessHours } from "@veralux/shared";
import { checkFeatureEntitlement } from "../featureEntitlements";
import { sendNightDeskSms } from "../nightDesk/sms";
import { tenants } from "../tenants";

type Listener = (event: WorkflowEvent) => void;

const listeners = new Map<string, Set<Listener>>();

const QA_RISK_PHRASES = [
  "i'll sue",
  "i will sue",
  "attorney",
  "lawsuit",
  "this is illegal",
  "speak to a manager",
  "speak to your manager",
  "racist",
  "i'm furious",
  "i am furious",
  "this is ridiculous",
];

export function qaLooksRisky(input: {
  score?: number;
  rubric?: Record<string, boolean>;
  transcript?: string;
}): boolean {
  if (typeof input.score === "number" && input.score < 70) return true;
  const rubric = input.rubric || {};
  if (rubric.emergencyEscalated === false) return true;
  if (rubric.noUnwrittenPromise === false) return true;
  const text = String(input.transcript || "").toLowerCase();
  return QA_RISK_PHRASES.some((phrase) => text.includes(phrase));
}

export function on(eventType: string, fn: Listener): void {
  if (!listeners.has(eventType)) listeners.set(eventType, new Set());
  listeners.get(eventType)!.add(fn);
}

export function off(eventType: string, fn: Listener): void {
  listeners.get(eventType)?.delete(fn);
}

function emit(eventType: string, event: WorkflowEvent): void {
  const fns = listeners.get(eventType);
  if (fns) {
    for (const fn of fns) {
      try {
        fn(event);
      } catch (err) {
        console.error(`[eventBus] listener error for ${eventType}:`, err);
      }
    }
  }
}

async function dispatch(tenantId: string, trigger: TriggerType, event: WorkflowEvent): Promise<void> {
  emit(trigger, { ...event, type: trigger as any });
  try {
    await matchAndEnqueue(tenantId, trigger, event);
  } catch (err) {
    console.error(`[eventBus] matchAndEnqueue failed for ${trigger}:`, err);
  }
}

/**
 * Called when the voice runtime reports a call has ended.
 * Derives all applicable trigger types and dispatches them.
 */
export async function handleCallEnded(event: CallEndedEvent): Promise<void> {
  const raw =
    event.lead && typeof event.lead.completion === "string"
      ? event.lead.completion
      : "";
  const claimed = (CALL_COMPLETIONS as readonly string[]).includes(raw)
    ? (raw as CallCompletion)
    : undefined;
  const finalized = await finalizeCallCompletion({
    tenantId: event.tenantId,
    callId: event.callId,
    callerId: event.callerId,
    transcript: event.transcript,
    lead: event.lead,
    claimed: claimed || null,
  });
  let qa: { score: number; rubric?: Record<string, boolean>; risk?: boolean } | undefined;
  try {
    const scored = await scoreNightDeskCall({
      tenantId: event.tenantId,
      callId: event.callId,
      transcript: event.transcript,
    });
    const rubric =
      scored?.rubric && typeof scored.rubric === "object"
        ? (scored.rubric as Record<string, boolean>)
        : undefined;
    const score = Number(scored?.score ?? 100);
    qa = {
      score,
      rubric,
      risk: qaLooksRisky({ score, rubric, transcript: event.transcript }),
    };
  } catch (err) {
    console.error("[eventBus] scoreNightDeskCall failed:", err);
  }

  let stormMode = false;
  let membershipNames: string[] = [];
  try {
    const playbook = await getShopPlaybookRow(event.tenantId);
    stormMode = Boolean(playbook?.playbook.stormMode?.enabled);
    membershipNames = playbook?.playbook.membershipNames || [];
  } catch {
    /* playbook optional */
  }

  const enriched: CallEndedEvent = {
    ...event,
    completion: finalized.completion,
    completionReason:
      typeof event.lead?.completionReason === "string"
        ? event.lead.completionReason
        : undefined,
    stormMode,
    membershipNames,
    qa,
    jobStatus:
      typeof event.lead?.jobStatus === "string" ? event.lead.jobStatus : event.jobStatus,
    lead: {
      ...(event.lead || {}),
      completion: finalized.completion,
    },
  };

  const triggers: TriggerType[] = ["call_ended"];
  const afterHoursEntitled = await checkFeatureEntitlement(event.tenantId, "afterHoursMode");
  if (afterHoursEntitled.allowed) {
    const hours = evaluateBusinessHours(tenants.getOrCreate(event.tenantId).businessHours);
    if (!hours.isOpen) triggers.push("after_hours_call");
  }
  if (enriched.transcript || enriched.turns?.length) {
    triggers.push("keyword_detected");
  }
  const turnCount = enriched.turns?.length ?? 0;
  const durationSec = (enriched.durationMs ?? 0) / 1000;
  if (turnCount <= 1 || durationSec < 15) {
    triggers.push("missed_call");
  }
  if (finalized.completion === "booked") {
    triggers.push("booking_succeeded");
  }
  if (enriched.qa?.risk) {
    triggers.push("qa_flagged");
  }
  const jobStatus = String(enriched.jobStatus || enriched.lead?.jobStatus || "");
  if (jobStatus === "complete" || jobStatus === "completed") {
    triggers.push("job_completed");
  }

  for (const trigger of triggers) {
    await dispatch(event.tenantId, trigger, enriched);
  }

  const sms = await checkFeatureEntitlement(event.tenantId, "smsFollowup");
  if (sms.allowed && event.callerId) {
    const name = typeof event.lead?.name === "string" ? event.lead.name : "there";
    await sendNightDeskSms(
      event.callerId,
      `Hi ${name}, thanks for calling. We have your request and will follow up shortly.`,
      event.tenantId,
    );
  }
}

export async function handleJobCompleted(input: {
  tenantId: string;
  callId: string;
  callerId?: string;
  reviewUrl?: string;
  lead?: Record<string, unknown>;
  transcript?: string;
}): Promise<void> {
  const event: CallEndedEvent = {
    type: "job_completed",
    tenantId: input.tenantId,
    callId: input.callId,
    callerId: input.callerId,
    timestamp: new Date().toISOString(),
    jobStatus: "complete",
    reviewUrl: input.reviewUrl,
    lead: { ...(input.lead || {}), jobStatus: "complete", reviewUrl: input.reviewUrl },
    transcript: input.transcript,
  };
  await dispatch(input.tenantId, "job_completed", event);
}

/**
 * Called by the scheduled trigger loop.
 */
export async function handleScheduledTrigger(
  tenantId: string,
  workflowId: string
): Promise<void> {
  const event: WorkflowEvent = {
    type: "scheduled",
    tenantId,
    workflowId,
    timestamp: new Date().toISOString(),
  };
  emit("scheduled", event);
  try {
    await matchAndEnqueue(tenantId, "scheduled", event);
  } catch (err) {
    console.error(`[eventBus] scheduled matchAndEnqueue failed:`, err);
  }
}
