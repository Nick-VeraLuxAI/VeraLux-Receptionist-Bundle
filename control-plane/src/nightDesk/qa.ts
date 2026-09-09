import {
  emptyPromise,
  inferCompletionFromText,
  normalizeShopPlaybook,
} from "@veralux/shared";
import { maskCallerId, summarizeHistory } from "../callSanitizer";
import { getCallCompletion, getShopPlaybookRow, insertQaScore } from "./db";

export const QA_COACHING: Record<
  string,
  { label: string; pass: string; fail: string; action: string }
> = {
  terminalPersisted: {
    label: "Outcome saved",
    pass: "The call has a written ending (booked, callback, paged, or refused).",
    fail: "This call hung up with no saved outcome.",
    action: "Open the call and mark what happened so the shop is not guessing.",
  },
  orphanPromiseZero: {
    label: "Follow-up written",
    pass: "No leftover promise.",
    fail: "The receptionist promised a follow-up that was never written down.",
    action: "Call the customer back today and log the next step.",
  },
  noUnwrittenPromise: {
    label: "Promise logged",
    pass: "Any promise on the call was turned into a task.",
    fail: "Someone was told we would do something, and it was not tasked.",
    action: "Create the callback or job now, then listen to confirm the promise.",
  },
  bookedClaimBackedByWrite: {
    label: "Booking is real",
    pass: "If we said it was booked, a calendar/job write exists.",
    fail: "The caller was told they were booked, but nothing was written to the calendar.",
    action: "Confirm the slot with the customer and write the job before they show up to an empty board.",
  },
  emergencyEscalated: {
    label: "Emergency handled",
    pass: "Emergency language was paged or tasked.",
    fail: "The caller used emergency language and nobody was paged.",
    action: "Call the customer now and page on-call if it is still an emergency.",
  },
  noUnverifiedPrice: {
    label: "Price from the book",
    pass: "No invented price.",
    fail: "A dollar amount was spoken that is not on the rate card or quote.",
    action: "Listen for the number, then confirm or correct it with the customer.",
  },
};

const OUTCOME_LABELS: Record<string, string> = {
  booked: "Booked",
  tasked: "Callback tasked",
  approval_held: "Needs your approval",
  on_call_paged: "On-call paged",
  refused: "Turned away",
};

function leadField(lead: unknown, keys: string[]): string | null {
  if (!lead || typeof lead !== "object") return null;
  const rec = lead as Record<string, unknown>;
  for (const key of keys) {
    const value = rec[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function moneyLabel(cents: unknown): string | null {
  const n = Number(cents);
  if (!Number.isFinite(n) || n <= 0) return null;
  return `$${(n / 100).toFixed(0)}`;
}

export type QaFinding = {
  key: string;
  passed: boolean;
  label: string;
  detail: string;
  action?: string;
};

export type PresentedQaScore = {
  id: string;
  callId: string;
  createdAt: string;
  score: number;
  callerName: string | null;
  callerDisplay: string;
  issue: string | null;
  outcome: string | null;
  outcomeLabel: string;
  bookedCents: number | null;
  summary: string;
  headline: string;
  nextAction: string | null;
  needsReview: boolean;
  findings: QaFinding[];
  recordingUrl: string | null;
  rubric: Record<string, boolean>;
};

export function presentQaScore(row: Record<string, unknown>): PresentedQaScore {
  const rubricRaw = row.rubric && typeof row.rubric === "object" ? (row.rubric as Record<string, unknown>) : {};
  const rubric: Record<string, boolean> = {};
  for (const [key, value] of Object.entries(rubricRaw)) {
    rubric[key] = value === true;
  }
  const findings: QaFinding[] = Object.keys(QA_COACHING).map((key) => {
    const passed = rubric[key] !== false;
    const copy = QA_COACHING[key];
    return {
      key,
      passed,
      label: copy.label,
      detail: passed ? copy.pass : copy.fail,
      action: passed ? undefined : copy.action,
    };
  });
  const failed = findings.filter((f) => !f.passed);
  const outcome = typeof row.completion === "string" && row.completion
    ? row.completion
    : typeof row.outcome === "string"
      ? row.outcome
      : null;
  const issue = leadField(row.lead, ["issue", "jobType", "category", "service"]) ||
    (typeof row.issue === "string" ? row.issue : null);
  const bookedCents = Number(row.booked_cents ?? row.bookedCents);
  const money = moneyLabel(bookedCents);
  const callerName =
    (typeof row.caller_name === "string" && row.caller_name) ||
    (typeof row.callerName === "string" && row.callerName) ||
    leadField(row.lead, ["name", "callerName"]) ||
    null;
  const callerId = typeof row.caller_id === "string" ? row.caller_id : typeof row.callerId === "string" ? row.callerId : "";
  const score = Number(row.score);
  const needsReview = failed.length > 0 || (Number.isFinite(score) && score < 100);

  let headline: string;
  let nextAction: string | null = null;
  if (failed.length) {
    headline = failed[0].detail;
    nextAction = failed[0].action || null;
  } else if (outcome === "booked") {
    headline = money
      ? `Booked ${money}${issue ? ` for ${issue}` : ""}. The write is on the board.`
      : `Booked${issue ? ` — ${issue}` : ""}. The job was written down.`;
  } else if (outcome === "tasked") {
    headline = issue
      ? `Callback tasked for ${issue}. Nothing was left as a verbal promise.`
      : "A callback task was written. Nothing was left as a verbal promise.";
  } else if (outcome === "on_call_paged") {
    headline = "On-call was paged for this emergency.";
  } else if (outcome === "approval_held") {
    headline = "The receptionist held this for your approval.";
    nextAction = "Open Approvals and accept or rewrite the booking.";
  } else if (outcome === "refused") {
    headline = typeof row.reason === "string" && row.reason
      ? `Turned away (${row.reason.replace(/_/g, " ")}).`
      : "Turned away for a documented reason.";
  } else {
    headline = issue
      ? `Closed cleanly — ${issue}.`
      : "Closed cleanly. The next step was written.";
  }

  return {
    id: String(row.id || row.call_id || ""),
    callId: String(row.call_id || row.callId || ""),
    createdAt: String(row.created_at || row.createdAt || ""),
    score: Number.isFinite(score) ? score : 0,
    callerName,
    callerDisplay: callerName || maskCallerId(callerId),
    issue,
    outcome,
    outcomeLabel: outcome ? (OUTCOME_LABELS[outcome] || outcome) : "Outcome unknown",
    bookedCents: Number.isFinite(bookedCents) && bookedCents > 0 ? bookedCents : null,
    summary: summarizeHistory(row.history, 180),
    headline,
    nextAction,
    needsReview,
    findings,
    recordingUrl: typeof row.recording_url === "string" ? row.recording_url : typeof row.recordingUrl === "string" ? row.recordingUrl : null,
    rubric,
  };
}

export async function scoreNightDeskCall(input: {
  tenantId: string;
  callId: string;
  transcript?: string;
}) {
  const transcript = input.transcript || "";
  const [terminal, playbookRow] = await Promise.all([
    getCallCompletion(input.tenantId, input.callId),
    getShopPlaybookRow(input.tenantId),
  ]);
  const playbook = normalizeShopPlaybook(playbookRow?.playbook);
  const lower = transcript.toLowerCase();
  const namedPrice = /\$\s*[\d,.]+/.test(transcript);
  const knownPriceText = JSON.stringify(terminal?.input || {}).toLowerCase();
  const rubric = {
    terminalPersisted: Boolean(terminal?.completion),
    orphanPromiseZero: !Boolean(terminal?.orphan_promise),
    noUnwrittenPromise:
      !emptyPromise(transcript) || terminal?.completion === "tasked",
    bookedClaimBackedByWrite:
      inferCompletionFromText(transcript) !== "booked" ||
      terminal?.fsm_provider === "gcal_helper" ||
      Boolean(terminal?.fsm_job_id),
    emergencyEscalated:
      !playbook.emergencyKeywords.some((keyword) => lower.includes(keyword)) ||
      terminal?.completion === "on_call_paged" ||
      terminal?.completion === "tasked",
    noUnverifiedPrice:
      !namedPrice ||
      Boolean(terminal?.quote_cents) ||
      Boolean(terminal?.booked_cents) ||
      knownPriceText.includes("quote"),
  };
  const checks = Object.values(rubric);
  const score = Math.round(
    (checks.filter(Boolean).length / checks.length) * 100,
  );
  return insertQaScore(input.tenantId, input.callId, score, rubric);
}
