/**
 * Workflow matcher: given a trigger event, finds all matching workflows
 * for the tenant and enqueues them for execution.
 */

import type { TriggerType, WorkflowEvent, Workflow, CallEndedEvent } from "./types";
import { getEnabledWorkflowsByTrigger } from "./db";
import { enqueueJob } from "./jobQueue";

function eventText(event: WorkflowEvent): string {
  const callEvent = event as CallEndedEvent;
  return (
    callEvent.transcript ??
    callEvent.turns?.map((t) => t.content).join(" ") ??
    ""
  ).toLowerCase();
}

function keywordsMatch(keywords: string[] | undefined, text: string): boolean {
  if (!keywords?.length) return false;
  return keywords.some((kw) => text.includes(String(kw).toLowerCase()));
}

function hasNameAndContact(event: CallEndedEvent): boolean {
  const lead = event.lead || {};
  const name = String(lead.name || lead.customerName || "").trim();
  const contact = String(lead.phone || lead.email || event.callerId || "").trim();
  return Boolean(name && contact);
}

function quoteHeld(event: CallEndedEvent): boolean {
  const lead = event.lead || {};
  if (event.completion === "approval_held") return true;
  if (event.completionReason === "quote_hold") return true;
  if (typeof lead.quoteCents === "number" && lead.quoteCents > 0) return true;
  const text = eventText(event);
  return /\b(estimate|quote)\b/.test(text) && /\b(hold|held|approval)\b/.test(text);
}

function membershipHit(event: CallEndedEvent, extraNames: string[] = []): boolean {
  const lead = event.lead || {};
  if (typeof lead.membership === "string" && lead.membership.trim()) return true;
  if (lead.vip === true || String(lead.priority || "").toLowerCase() === "high" && lead.tag === "vip") {
    return true;
  }
  const names = [
    ...(event.membershipNames || []),
    ...extraNames,
  ].map((n) => n.toLowerCase()).filter(Boolean);
  if (!names.length) return false;
  const text = `${eventText(event)} ${JSON.stringify(lead)}`.toLowerCase();
  return names.some((name) => text.includes(name));
}

function whenMatches(workflow: Workflow, event: WorkflowEvent): boolean {
  const when = workflow.triggerConfig.when;
  if (!when) return true;
  const callEvent = event as CallEndedEvent;
  const completion = callEvent.completion || String(callEvent.lead?.completion || "");
  const reason = callEvent.completionReason || String(callEvent.lead?.completionReason || callEvent.lead?.reason || "");

  if (when.completions?.length && !when.completions.includes(completion)) return false;
  if (when.reasons?.length && !when.reasons.includes(reason)) return false;
  if (when.stormMode === true && callEvent.stormMode !== true) return false;
  if (when.incompleteCapture === true && hasNameAndContact(callEvent)) return false;
  if (when.quoteHeld === true && !quoteHeld(callEvent)) return false;
  if (when.membershipMatch === true && !membershipHit(callEvent, workflow.triggerConfig.keywords)) {
    return false;
  }
  if (when.qaRisk === true && callEvent.qa?.risk !== true) return false;
  if (when.requireKeywords === true && !keywordsMatch(workflow.triggerConfig.keywords, eventText(event))) {
    return false;
  }
  return true;
}

/**
 * Check if a workflow's trigger conditions match the event.
 */
export function evaluateConditions(workflow: Workflow, event: WorkflowEvent): boolean {
  const cfg = workflow.triggerConfig;

  switch (workflow.triggerType) {
    case "call_ended":
      return whenMatches(workflow, event);

    case "booking_succeeded": {
      const callEvent = event as CallEndedEvent;
      const completion = callEvent.completion || String(callEvent.lead?.completion || "");
      if (event.type !== "booking_succeeded" && completion !== "booked") return false;
      return whenMatches(workflow, event);
    }

    case "qa_flagged": {
      const callEvent = event as CallEndedEvent;
      if (event.type !== "qa_flagged" && callEvent.qa?.risk !== true) return false;
      return whenMatches(workflow, event);
    }

    case "job_completed": {
      const callEvent = event as CallEndedEvent;
      const status = callEvent.jobStatus || String(callEvent.lead?.jobStatus || "");
      if (event.type !== "job_completed" && status !== "complete" && status !== "completed") {
        return false;
      }
      return whenMatches(workflow, event);
    }

    case "after_hours_call": {
      const start = cfg.businessHoursStart ?? "09:00";
      const end = cfg.businessHoursEnd ?? "17:00";
      const tz = cfg.timezone ?? "America/New_York";

      try {
        const eventTime = new Date(event.timestamp);
        const formatter = new Intl.DateTimeFormat("en-US", {
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
          timeZone: tz,
        });
        const parts = formatter.formatToParts(eventTime);
        const hour = parseInt(parts.find(p => p.type === "hour")?.value ?? "12");
        const minute = parseInt(parts.find(p => p.type === "minute")?.value ?? "0");
        const currentMinutes = hour * 60 + minute;

        const [startH, startM] = start.split(":").map(Number);
        const [endH, endM] = end.split(":").map(Number);
        const startMinutes = startH * 60 + startM;
        const endMinutes = endH * 60 + endM;

        const afterHours = currentMinutes < startMinutes || currentMinutes >= endMinutes;
        if (!afterHours) return false;
        return whenMatches(workflow, event);
      } catch {
        return false;
      }
    }

    case "keyword_detected": {
      const callEvent = event as CallEndedEvent;
      const text = eventText(event);
      const keywords = cfg.keywords ?? [];
      if (cfg.when?.membershipMatch) {
        if (!membershipHit(callEvent, keywords) && !keywordsMatch(keywords, text)) return false;
      } else if (!keywordsMatch(keywords, text)) {
        return false;
      }
      return whenMatches(workflow, event);
    }

    case "missed_call": {
      const callEvent = event as CallEndedEvent;
      const maxDuration = (cfg.maxDurationSeconds ?? 15) * 1000;
      const minTurns = cfg.minTurns ?? 2;

      const duration = callEvent.durationMs ?? 0;
      const turnCount = callEvent.turns?.length ?? 0;

      if (!(duration < maxDuration || turnCount < minTurns)) return false;
      return whenMatches(workflow, event);
    }

    case "scheduled":
      return true;

    default:
      return false;
  }
}

/**
 * Find all matching workflows for a trigger event and enqueue them.
 */
export async function matchAndEnqueue(
  tenantId: string,
  triggerType: TriggerType,
  event: WorkflowEvent
): Promise<number> {
  const workflows = await getEnabledWorkflowsByTrigger(tenantId, triggerType);
  let enqueued = 0;

  for (const wf of workflows) {
    if (evaluateConditions(wf, event)) {
      try {
        await enqueueJob({
          workflowId: wf.id,
          tenantId,
          event,
        });
        enqueued++;
        console.log(`[matcher] Enqueued workflow "${wf.name}" (${wf.id}) for ${triggerType}`);
      } catch (err) {
        console.error(`[matcher] Failed to enqueue workflow ${wf.id}:`, err);
      }
    }
  }

  return enqueued;
}
