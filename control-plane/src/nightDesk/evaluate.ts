import {
  bookingMissingFields,
  emptyPromise,
  evaluateShopAction,
  extractQuoteCents,
  extractZip,
  inferCompletionFromText,
  inferShopIntent,
  normalizeIntakeProfile,
  type CallCompletion,
  type ShopActionInput,
} from "@veralux/shared";
import { writeBoardJob } from "../fsm";
import { tenants } from "../tenants";
import {
  createApproval,
  createOncallPage,
  ensureCompletionLead,
  getShopPlaybookRow,
  mirrorCompletionToCallAndLeads,
  upsertCutoverItem,
  upsertCallCompletion,
} from "./db";
import { resolveOnCallE164 } from "./oncallResolve";
import { sendNightDeskSms } from "./sms";

export type NightDeskTurnInput = {
  tenantId: string;
  callId: string;
  callerId?: string;
  utterance: string;
  proposedReply: string;
  transcript?: string;
  lead?: Record<string, unknown>;
  afterHours?: boolean;
  distanceMiles?: number;
  existingOpenJobs?: number;
  membership?: string;
  allowDryRun?: boolean;
};

export type NightDeskTurnResult = {
  text: string;
  decision: "allow" | "refuse" | "hold" | "escalate";
  reason: string;
  completion?: CallCompletion;
  persisted: boolean;
  transfer?: {
    to: string;
    timeoutSecs: number;
    pageId?: string;
  };
  fsm?: {
    provider: string;
    jobId?: string;
    dryRun?: boolean;
    taggedAiBooked?: boolean;
  };
};

function stringField(
  lead: Record<string, unknown> | undefined,
  ...keys: string[]
): string | undefined {
  for (const key of keys) {
    const value = lead?.[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function bookingMissing(
  lead: Record<string, unknown> | undefined,
  callerId?: string,
  tenantId?: string,
): string[] {
  return bookingMissingFields(
    (lead?.intakeProfile as never) || undefined,
    lead,
    callerId,
    tenantId,
  );
}

function deskActionOf(lead: Record<string, unknown> | undefined): string | undefined {
  const value = lead?.deskAction;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function configuredPriceCents(tenantId: string): Set<number> {
  const pricing = tenants.getOrCreate(tenantId).pricing;
  const allowed = new Set<number>();
  for (const item of pricing.items || []) {
    const match = /[\d,]+(?:\.\d{1,2})?/.exec(String(item.price || ""));
    if (!match) continue;
    const cents = Math.round(Number(match[0].replace(/,/g, "")) * 100);
    if (Number.isFinite(cents) && cents >= 0) allowed.add(cents);
  }
  return allowed;
}

function allMoneyCents(text: string): number[] {
  return [...String(text || "").matchAll(/\$\s*([\d,]+(?:\.\d{1,2})?)/g)]
    .map((match) =>
      Math.round(Number(match[1].replace(/,/g, "")) * 100),
    )
    .filter((value) => Number.isFinite(value) && value >= 0);
}

async function persistTerminal(input: {
  tenantId: string;
  callId: string;
  completion: CallCompletion;
  reason: string;
  source: string;
  lead?: Record<string, unknown>;
  quoteCents?: number;
  bookedCents?: number;
  fsmJobId?: string;
  fsmProvider?: string;
  details?: unknown;
}): Promise<void> {
  await upsertCallCompletion({
    tenantId: input.tenantId,
    callId: input.callId,
    completion: input.completion,
    reason: input.reason,
    source: input.source,
    input: input.lead,
    quoteCents: input.quoteCents,
    bookedCents: input.bookedCents,
    fsmJobId: input.fsmJobId,
    fsmProvider: input.fsmProvider,
    actor: "voice_runtime",
    details: input.details,
  });
  await mirrorCompletionToCallAndLeads({
    tenantId: input.tenantId,
    callId: input.callId,
    completion: input.completion,
    reason: input.reason,
  });
}

async function createTask(
  input: NightDeskTurnInput,
  reason: string,
  priority: "normal" | "urgent" = "normal",
): Promise<void> {
  await ensureCompletionLead({
    tenantId: input.tenantId,
    callId: input.callId,
    name: stringField(input.lead, "name", "customerName"),
    phone: stringField(input.lead, "phone") || input.callerId,
    email: stringField(input.lead, "email"),
    issue:
      stringField(input.lead, "issue", "jobType", "service") ||
      "Night desk follow-up",
    category: priority === "urgent" ? "night_desk_urgent" : "night_desk_task",
    priority,
    notes: (input.transcript || input.utterance).slice(0, 4000),
    rawExtract: {
      ...(input.lead || {}),
      completion: "tasked",
      completionReason: reason,
    },
  });
  await persistTerminal({
    tenantId: input.tenantId,
    callId: input.callId,
    completion: "tasked",
    reason,
    source: "mid_call_gate",
    lead: input.lead,
  });
}

export async function processNightDeskTurn(
  input: NightDeskTurnInput,
): Promise<NightDeskTurnResult> {
  const row = await getShopPlaybookRow(input.tenantId);
  const playbook = row?.playbook;
  const proposedAmounts = allMoneyCents(input.proposedReply);
  const proposedQuoteCents = proposedAmounts[0];
  const quoteCandidates = [
    typeof input.lead?.quoteCents === "number"
      ? input.lead.quoteCents
      : undefined,
    extractQuoteCents(input.utterance),
    proposedQuoteCents,
  ].filter((value): value is number => typeof value === "number");
  const quoteCents = quoteCandidates.length
    ? Math.max(...quoteCandidates)
    : undefined;
  const actionInput: ShopActionInput = {
    intent: inferShopIntent(input.utterance),
    utterance: input.utterance,
    zip: stringField(input.lead, "zip", "postalCode") || extractZip(input.utterance),
    city: stringField(input.lead, "city"),
    distanceMiles: input.distanceMiles,
    quoteCents,
    afterHours: input.afterHours,
    membership: input.membership,
    existingOpenJobs: input.existingOpenJobs,
  };
  const evaluation = evaluateShopAction(playbook, actionInput);

  if (
    evaluation.decision === "allow" &&
    typeof proposedQuoteCents === "number"
  ) {
    const allowed = configuredPriceCents(input.tenantId);
    if (playbook?.afterHoursFeeCents) {
      allowed.add(playbook.afterHoursFeeCents);
    }
    const unlisted = proposedAmounts.find((amount) => !allowed.has(amount));
    if (typeof unlisted === "number") {
      await createApproval(
        input.tenantId,
        `Unlisted price ${(unlisted / 100).toFixed(
          2,
        )} requires approval`,
        {
          ...(input.lead || {}),
          quoteCents: unlisted,
          utterance: input.utterance,
          reason: "unlisted_price",
        },
        input.callId,
      );
      await persistTerminal({
        tenantId: input.tenantId,
        callId: input.callId,
        completion: "approval_held",
        reason: "unlisted_price",
        source: "mid_call_gate",
        lead: input.lead,
        quoteCents: unlisted,
      });
      return {
        text:
          "That price is not on the published shop list. I have held it for owner approval instead of quoting or booking it.",
        decision: "hold",
        reason: "unlisted_price",
        completion: "approval_held",
        persisted: true,
      };
    }
  }

  if (evaluation.decision === "refuse") {
    await persistTerminal({
      tenantId: input.tenantId,
      callId: input.callId,
      completion: "refused",
      reason: evaluation.reason,
      source: "mid_call_gate",
      lead: input.lead,
      quoteCents,
    });
    if (evaluation.reason === "out_of_area") {
      await upsertCutoverItem(
        input.tenantId,
        "refuse_out_of_area",
        true,
        `Verified on call ${input.callId}`,
      );
    }
    return {
      text: evaluation.speak,
      decision: evaluation.decision,
      reason: evaluation.reason,
      completion: "refused",
      persisted: true,
    };
  }

  if (evaluation.decision === "hold") {
    await createApproval(
      input.tenantId,
      evaluation.reason === "quote_hold"
        ? `Quote ${(quoteCents || 0) / 100} requires approval`
        : "Storm-mode booking requires approval",
      {
        ...(input.lead || {}),
        quoteCents,
        utterance: input.utterance,
        reason: evaluation.reason,
      },
      input.callId,
    );
    await persistTerminal({
      tenantId: input.tenantId,
      callId: input.callId,
      completion: "approval_held",
      reason: evaluation.reason,
      source: "mid_call_gate",
      lead: input.lead,
      quoteCents,
    });
    await upsertCutoverItem(
      input.tenantId,
      "book_or_hold",
      true,
      `Held by shop law on call ${input.callId}`,
    );
    return {
      text: evaluation.speak,
      decision: evaluation.decision,
      reason: evaluation.reason,
      completion: "approval_held",
      persisted: true,
    };
  }

  if (evaluation.decision === "escalate") {
    const isOverflow = evaluation.reason === "human_overflow";
    const resolved = isOverflow
      ? {
          e164: playbook?.humanOverflowE164,
          timeoutSecs: 45,
          quietHours: false,
        }
      : await resolveOnCallE164(input.tenantId);
    if (!resolved.e164 || resolved.quietHours) {
      await createTask(input, `${evaluation.reason}:no_page_destination`, "urgent");
      return {
        text:
          "I have written an urgent task for the shop right now. It will not be left as an unwritten promise.",
        decision: "escalate",
        reason: `${evaluation.reason}:tasked`,
        completion: "tasked",
        persisted: true,
      };
    }
    const page = await createOncallPage({
      tenantId: input.tenantId,
      callId: input.callId,
      destinationE164: resolved.e164,
      timeoutSecs: resolved.timeoutSecs,
    });
    const smsSent = await sendNightDeskSms(
      resolved.e164,
      `VeraLux ${isOverflow ? "overflow" : "emergency"} page: caller ${
        input.callerId || "unknown"
      } is on the line.`,
      input.tenantId,
    );
    await persistTerminal({
      tenantId: input.tenantId,
      callId: input.callId,
      completion: "on_call_paged",
      reason: evaluation.reason,
      source: "mid_call_gate",
      lead: input.lead,
      details: { smsSent, pageId: page.id },
    });
    return {
      text: evaluation.speak,
      decision: "escalate",
      reason: evaluation.reason,
      completion: "on_call_paged",
      persisted: true,
      transfer: {
        to: resolved.e164,
        timeoutSecs: resolved.timeoutSecs,
        pageId: page.id,
      },
    };
  }

  const proposedCompletion =
    deskActionOf(input.lead) === "write_book"
      ? "booked"
      : deskActionOf(input.lead) === "write_task"
        ? "tasked"
        : inferCompletionFromText(input.proposedReply);

  if (deskActionOf(input.lead) === "quote_hold") {
    const holdCents = quoteCents || 0;
    await createApproval(
      input.tenantId,
      holdCents
        ? `Quote ${(holdCents / 100).toFixed(2)} requires approval`
        : "Unlisted price requires owner approval",
      {
        ...(input.lead || {}),
        quoteCents,
        utterance: input.utterance,
        reason: "unlisted_price",
      },
      input.callId,
    );
    await persistTerminal({
      tenantId: input.tenantId,
      callId: input.callId,
      completion: "approval_held",
      reason: "unlisted_price",
      source: "mid_call_gate",
      lead: input.lead,
      quoteCents,
    });
    await upsertCutoverItem(
      input.tenantId,
      "quote_or_hold",
      true,
      `Call board held unlisted quote on ${input.callId}`,
    );
    return {
      text: input.proposedReply,
      decision: "hold",
      reason: "unlisted_price",
      completion: "approval_held",
      persisted: true,
    };
  }

  if (proposedCompletion === "booked") {
    const writer = normalizeIntakeProfile(
      input.lead?.intakeProfile as never,
      input.tenantId,
    ).writer;
    if (writer === "gcal" || input.lead?.bookingAdapter === "gcal_helper") {
      await persistTerminal({
        tenantId: input.tenantId,
        callId: input.callId,
        completion: "booked",
        reason: "demo_shop_gcal_write_succeeded",
        source: "mid_call_gate",
        lead: input.lead,
        quoteCents,
        bookedCents: quoteCents,
        fsmJobId: `demo-shop-gcal:${input.callId}`,
        fsmProvider: "gcal_helper",
      });
      await upsertCutoverItem(
        input.tenantId,
        "book_or_hold",
        true,
        `Demo Shop calendar write completed on ${input.callId}`,
      );
      return {
        text: input.proposedReply,
        decision: "allow",
        reason: "demo_shop_gcal_write_succeeded",
        completion: "booked",
        persisted: true,
        fsm: {
          provider: "gcal_helper",
          jobId: `demo-shop-gcal:${input.callId}`,
          taggedAiBooked: true,
        },
      };
    }
    const missing = bookingMissing(input.lead, input.callerId, input.tenantId);
    if (missing.length) {
      return {
        text: `Before I can book that, I still need your ${missing.join(
          ", ",
        )}.`,
        decision: "allow",
        reason: "booking_details_required",
        persisted: false,
      };
    }
    const fsm = await writeBoardJob(input.tenantId, {
      callId: input.callId,
      idempotencyKey: input.callId,
      customer: {
        name: stringField(input.lead, "name", "customerName"),
        phone: stringField(input.lead, "phone") || input.callerId,
        email: stringField(input.lead, "email"),
        address: stringField(input.lead, "address", "serviceAddress"),
      },
      jobType: stringField(input.lead, "jobType", "service", "issue"),
      notes: (input.transcript || input.utterance).slice(0, 4000),
      membership:
        input.membership || stringField(input.lead, "membership"),
      warranty: stringField(input.lead, "warranty"),
      startIso: stringField(input.lead, "startIso", "scheduledAt"),
    });
    if (!fsm.ok || !fsm.jobId || (fsm.dryRun && !input.allowDryRun)) {
      await createTask(
        input,
        fsm.dryRun ? "fsm_not_connected" : "fsm_write_failed",
        "urgent",
      );
      return {
        text:
          "I could not write the job to the dispatch board, so I have created an urgent task instead. I will not claim it is booked.",
        decision: "allow",
        reason: fsm.dryRun ? "fsm_not_connected" : "fsm_write_failed",
        completion: "tasked",
        persisted: true,
        fsm: {
          provider: fsm.provider,
          jobId: fsm.jobId,
          dryRun: fsm.dryRun,
          taggedAiBooked: fsm.taggedAiBooked,
        },
      };
    }
    const bookedCents =
      typeof input.lead?.bookedCents === "number"
        ? input.lead.bookedCents
        : quoteCents;
    await persistTerminal({
      tenantId: input.tenantId,
      callId: input.callId,
      completion: "booked",
      reason: "fsm_write_succeeded",
      source: "mid_call_gate",
      lead: input.lead,
      quoteCents,
      bookedCents,
      fsmJobId: fsm.jobId,
      fsmProvider: fsm.provider,
      details: {
        dryRun: fsm.dryRun,
        taggedAiBooked: fsm.taggedAiBooked,
      },
    });
    await upsertCutoverItem(
      input.tenantId,
      "book_or_hold",
      true,
      `FSM job ${fsm.jobId} written before confirmation`,
    );
    return {
      text: input.proposedReply,
      decision: "allow",
      reason: "fsm_write_succeeded",
      completion: "booked",
      persisted: true,
      fsm: {
        provider: fsm.provider,
        jobId: fsm.jobId,
        dryRun: fsm.dryRun,
        taggedAiBooked: fsm.taggedAiBooked,
      },
    };
  }

  if (proposedCompletion === "tasked") {
    await createTask(input, "task_claim_persisted");
    return {
      text: input.proposedReply,
      decision: "allow",
      reason: "task_claim_persisted",
      completion: "tasked",
      persisted: true,
    };
  }

  if (
    proposedCompletion === "approval_held" ||
    proposedCompletion === "on_call_paged" ||
    proposedCompletion === "refused"
  ) {
    await createTask(input, `model_terminal_not_authorized:${proposedCompletion}`);
    return {
      text:
        "That action was not authorized by the shop rules. I have written a task for the shop instead.",
      decision: "allow",
      reason: `model_terminal_not_authorized:${proposedCompletion}`,
      completion: "tasked",
      persisted: true,
    };
  }

  if (emptyPromise(input.proposedReply)) {
    await createTask(input, "empty_promise_prevented");
    return {
      text:
        "I have written a task for the shop so this does not get lost. The next step is recorded now.",
      decision: "allow",
      reason: "empty_promise_prevented",
      completion: "tasked",
      persisted: true,
    };
  }

  return {
    text: input.proposedReply,
    decision: "allow",
    reason: evaluation.reason,
    persisted: false,
  };
}
