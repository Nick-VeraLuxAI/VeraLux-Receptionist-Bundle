import {
  claimDueOncallPages,
  ensureCompletionLead,
  getCallCompletion,
  mirrorCompletionToCallAndLeads,
  resolveOncallPage,
  setOncallTransferLeg,
  upsertCallCompletion,
} from "./db";
import { sendNightDeskSms } from "./sms";

let timer: NodeJS.Timeout | null = null;

async function taskFallback(page: Record<string, unknown>, reason: string) {
  const tenantId = String(page.tenant_id);
  const callId = String(page.call_id);
  const completion = await getCallCompletion(tenantId, callId);
  const rawInput =
    completion?.input && typeof completion.input === "object"
      ? (completion.input as Record<string, unknown>)
      : {};
  await ensureCompletionLead({
    tenantId,
    callId,
    name:
      typeof rawInput.name === "string" ? rawInput.name : undefined,
    phone:
      typeof rawInput.phone === "string" ? rawInput.phone : undefined,
    email:
      typeof rawInput.email === "string" ? rawInput.email : undefined,
    issue: "On-call page was not answered",
    category: "on_call_fallback",
    priority: "urgent",
    notes: `On-call destination ${String(
      page.destination_e164 || "",
    )} did not answer. Reason: ${reason}.`,
    rawExtract: {
      ...rawInput,
      completion: "tasked",
      completionReason: reason,
    },
  });
  await upsertCallCompletion({
    tenantId,
    callId,
    completion: "tasked",
    reason,
    source: "oncall_fallback",
    input: rawInput,
    actor: "oncall_worker",
    details: {
      pageId: page.id,
      destinationE164: page.destination_e164,
    },
  });
  await mirrorCompletionToCallAndLeads({
    tenantId,
    callId,
    completion: "tasked",
    reason,
  });
  await resolveOncallPage({
    tenantId,
    callId,
    status: "tasked",
    reason,
  });
  await sendNightDeskSms(
    String(page.destination_e164 || ""),
    `VeraLux: page for call ${callId} was not answered. An urgent task has been created.`,
    tenantId,
  );
}

export async function handleOncallTransferOutcome(input: {
  tenantId: string;
  callId: string;
  transferCallControlId?: string;
  status: "initiated" | "answered" | "failed";
  reason?: string;
}): Promise<void> {
  if (input.transferCallControlId) {
    await setOncallTransferLeg(
      input.tenantId,
      input.callId,
      input.transferCallControlId,
    );
  }
  if (input.status === "initiated") return;
  if (input.status === "answered") {
    const page = await resolveOncallPage({
      tenantId: input.tenantId,
      callId: input.callId,
      transferCallControlId: input.transferCallControlId,
      status: "answered",
    });
    if (page) {
      await upsertCallCompletion({
        tenantId: input.tenantId,
        callId: input.callId,
        completion: "on_call_paged",
        reason: "oncall_answered",
        source: "telnyx_transfer_webhook",
        actor: "voice_runtime",
        details: { transferCallControlId: input.transferCallControlId },
      });
      await mirrorCompletionToCallAndLeads({
        tenantId: input.tenantId,
        callId: input.callId,
        completion: "on_call_paged",
        reason: "oncall_answered",
      });
    }
    return;
  }
  const failed = await resolveOncallPage({
    tenantId: input.tenantId,
    callId: input.callId,
    transferCallControlId: input.transferCallControlId,
    status: "failed",
    reason: input.reason || "oncall_transfer_failed",
  });
  if (failed) {
    await taskFallback(
      failed,
      input.reason || "oncall_transfer_failed",
    );
  }
}

export async function sweepDueOncallPages(): Promise<number> {
  const pages = await claimDueOncallPages();
  for (const page of pages) {
    try {
      await taskFallback(page, "oncall_page_timeout");
    } catch (error) {
      await resolveOncallPage({
        tenantId: String(page.tenant_id),
        callId: String(page.call_id),
        status: "failed",
        reason:
          error instanceof Error
            ? error.message.slice(0, 500)
            : "fallback_task_failed",
      }).catch(() => undefined);
    }
  }
  return pages.length;
}

export function startOncallFallbackLoop(): void {
  if (timer) return;
  timer = setInterval(() => {
    void sweepDueOncallPages().catch((error) =>
      console.error("[oncall] fallback sweep failed", error),
    );
  }, 5_000);
  timer.unref?.();
}

export function stopOncallFallbackLoop(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
