import {
  emptyPromise,
  inferCompletionFromText,
  normalizeIntakeProfile,
  type CallCompletion,
} from "@veralux/shared";
import {
  createApproval,
  ensureCompletionLead,
  getCallCompletion,
  mirrorCompletionToCallAndLeads,
  upsertCallCompletion,
} from "./db";
import { writeBoardJob } from "../fsm";

export async function finalizeCallCompletion(input: {
  tenantId: string;
  callId: string;
  callerId?: string;
  transcript?: string;
  lead?: Record<string, unknown>;
  claimed?: CallCompletion | null;
}): Promise<{
  completion: CallCompletion;
  orphan: boolean;
  fsmJobId?: string;
  existing?: boolean;
}> {
  const existing = await getCallCompletion(input.tenantId, input.callId);
  if (existing?.completion) {
    return {
      completion: existing.completion as CallCompletion,
      orphan: Boolean(existing.orphan_promise),
      fsmJobId:
        typeof existing.fsm_job_id === "string"
          ? existing.fsm_job_id
          : undefined,
      existing: true,
    };
  }

  const text = `${input.transcript || ""} ${JSON.stringify(input.lead || {})}`;
  const inferred = input.claimed || inferCompletionFromText(text);
  const preventedEmptyPromise = !inferred && emptyPromise(text);
  let completion: CallCompletion = inferred || "tasked";
  if (preventedEmptyPromise) completion = "tasked";
  let fsmJobId: string | undefined;
  let fsmProvider: string | undefined;

  if (completion === "booked") {
    const writer = normalizeIntakeProfile(
      input.lead?.intakeProfile as never,
      input.tenantId,
    ).writer;
    if (writer === "gcal") {
      fsmJobId = `demo-shop-gcal:${input.callId}`;
      fsmProvider = "gcal_helper";
    } else {
      const write = await writeBoardJob(input.tenantId, {
        callId: input.callId,
        idempotencyKey: input.callId,
        customer: {
          name: String(
            input.lead?.name || input.lead?.customerName || "",
          ),
          phone: String(input.lead?.phone || input.callerId || ""),
          email:
            typeof input.lead?.email === "string"
              ? input.lead.email
              : undefined,
          address: String(
            input.lead?.address ||
              input.lead?.serviceAddress ||
              input.lead?.zip ||
              "",
          ),
        },
        jobType: String(
          input.lead?.jobType ||
            input.lead?.service ||
            input.lead?.issue ||
            "Service call",
        ),
        notes: (input.transcript || "").slice(0, 4000),
        membership:
          typeof input.lead?.membership === "string"
            ? input.lead.membership
            : undefined,
        warranty:
          typeof input.lead?.warranty === "string"
            ? input.lead.warranty
            : undefined,
        startIso:
          typeof input.lead?.startIso === "string"
            ? input.lead.startIso
            : undefined,
      });
      if (!write.ok || !write.jobId || write.dryRun) {
        completion = "tasked";
      } else {
        fsmJobId = write.jobId;
        fsmProvider = write.provider;
      }
    }
  }

  if (completion === "approval_held") {
    await createApproval(
      input.tenantId,
      "Held booking awaiting owner",
      input.lead || {},
      input.callId,
    );
  }

  if (completion === "tasked") {
    await ensureCompletionLead({
      tenantId: input.tenantId,
      callId: input.callId,
      name: String(input.lead?.name || ""),
      phone: input.callerId || "",
      email:
        typeof input.lead?.email === "string"
          ? input.lead.email
          : undefined,
      issue: String(input.lead?.issue || "Night desk follow-up"),
      category: "night_desk_task",
      priority: "normal",
      notes: (input.transcript || "").slice(0, 4000),
      rawExtract: {
        ...(input.lead || {}),
        completion: "tasked",
        completionReason: preventedEmptyPromise
          ? "empty_promise_prevented_at_hangup"
          : "hangup_without_terminal",
      },
    });
  }

  await upsertCallCompletion({
    tenantId: input.tenantId,
    callId: input.callId,
    completion,
    reason: preventedEmptyPromise
      ? "empty_promise_prevented_at_hangup"
      : completion === "tasked" && inferred === "booked"
        ? "fsm_write_failed_at_hangup"
        : inferred || "hangup_without_terminal",
    bookedCents: typeof input.lead?.bookedCents === "number" ? input.lead.bookedCents : undefined,
    quoteCents:
      typeof input.lead?.quoteCents === "number"
        ? input.lead.quoteCents
        : undefined,
    orphanPromise: false,
    source: "call_end",
    input: input.lead,
    fsmJobId,
    fsmProvider,
    actor: "voice_runtime",
    details: { preventedEmptyPromise },
  });
  await mirrorCompletionToCallAndLeads({
    tenantId: input.tenantId,
    callId: input.callId,
    completion,
    reason: preventedEmptyPromise
      ? "empty_promise_prevented_at_hangup"
      : inferred || "hangup_without_terminal",
  });
  return { completion, orphan: false, fsmJobId };
}
