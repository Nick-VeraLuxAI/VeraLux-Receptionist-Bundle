import dayjs from "dayjs";
import relativeTime from "dayjs/plugin/relativeTime";

dayjs.extend(relativeTime);

export const fmtDateTime = (v) => (v ? dayjs(v).format("MMM D, YYYY [at] h:mm A") : "—");
export const fmtDate = (v) => (v ? dayjs(v).format("MMM D, YYYY") : "—");
export const fmtShortDate = (v) => (v ? dayjs(v).format("MMM D") : "—");
export const fmtTime = (v) => (v ? dayjs(v).format("h:mm A") : "—");
export const fmtRelative = (v) => (v ? dayjs(v).fromNow() : "—");
export const fmtNumber = (n) => (n === null || n === undefined || Number.isNaN(Number(n)) ? "—" : Number(n).toLocaleString());

/** Newest call first, using the same timestamp the When column shows (started at). */
export function callWhenMs(call) {
  const raw = call?.createdAt ?? call?.created_at ?? call?.updatedAt ?? call?.updated_at;
  if (raw instanceof Date) return raw.getTime();
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  const t = Date.parse(raw || "");
  return Number.isFinite(t) ? t : 0;
}

export function sortCallsNewestFirst(calls) {
  return [...(calls || [])].sort((a, b) => {
    const diff = callWhenMs(b) - callWhenMs(a);
    if (diff !== 0) return diff;
    return String(b?.id || "").localeCompare(String(a?.id || ""));
  });
}
export const fmtMoney = (cents, currency = "usd") =>
  cents === null || cents === undefined ? "—" : new Intl.NumberFormat("en-US", { style: "currency", currency: currency.toUpperCase() }).format(cents / 100);
export const fmtPrice = (n) => (n === null || n === undefined ? "—" : new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n));

export function fmtDuration(ms) {
  if (!ms) return "0s";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return r ? `${m}m ${r}s` : `${m}m`;
}

export const titleCase = (s) =>
  (s || "")
    .toString()
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());

export const BILLING_LABELS = {
  trial: "Trial",
  active: "Active",
  past_due: "Payment needs attention",
  suspended: "Suspended",
  canceled: "Canceled",
};
export const billingLabel = (s) => BILLING_LABELS[s] || titleCase(s || "unknown");
export const billingTone = (s) => ({ active: "success", trial: "gold", past_due: "warning", suspended: "danger", canceled: "neutral" }[s] || "neutral");

export const BILLING_STATE_LABELS = {
  subscribed: "Subscribed",
  unbilled: "Unbilled",
  past_due: "Past due",
  canceled: "Canceled",
};
export const billingStateLabel = (s) => BILLING_STATE_LABELS[s] || titleCase(s || "unbilled");
export const billingStateTone = (s) => ({ subscribed: "success", unbilled: "neutral", past_due: "warning", canceled: "neutral" }[s] || "neutral");
export const serviceStatusLabel = (s) => (s === "active" ? "Active" : billingLabel(s));

export const STAGE_LABELS = {
  unknown: "No stage",
  inquiry: "Inquiry",
  qualified: "Qualified",
  ready_to_book: "Ready to book",
  booked: "Booked",
  lost: "Lost",
  live: "Live",
};
export const stageLabel = (s) => STAGE_LABELS[s] || titleCase(s);

export const PLAN_TIERS = ["starter", "professional", "pilot", "premium", "enterprise"];

export function centsToDollarInput(cents) {
  if (cents === "" || cents === null || cents === undefined) return "";
  const n = Number(cents);
  if (!Number.isFinite(n)) return "";
  return (n / 100).toFixed(2);
}

export function dollarInputToCents(value) {
  const cleaned = String(value ?? "").replace(/[^0-9.]/g, "");
  if (!cleaned) return "";
  const n = Number(cleaned);
  if (!Number.isFinite(n)) return "";
  return Math.round(n * 100);
}
export const BILLING_STATUSES = ["trial", "active", "past_due", "suspended", "canceled"];
export const OVERAGE_MODES = ["allow_and_bill", "throttle", "hard_stop"];

export const FEATURE_LABELS = {
  advancedAnalytics: "Analytics",
  multiLocation: "Transfer lines",
  crmIntegration: "Services & pricing",
  customWorkflows: "Workflows",
  afterHoursMode: "After-hours mode",
  smsFollowup: "SMS follow-up",
  calendarIntegration: "Calendar integration",
  callRecording: "Call recording",
  transcriptRetention: "Transcript retention",
  prioritySupport: "Priority support",
};

export const LIMIT_LABELS = {
  maxConcurrentCalls: "Concurrent calls",
  includedMonthlyMinutes: "Included minutes / month",
  maxMonthlyMinutesHardCap: "Hard cap minutes / month",
  maxDailyCalls: "Calls / day",
  maxMonthlyCalls: "Calls / month",
  maxKnowledgeBaseSizeMb: "Knowledge base (MB)",
  maxIntegrations: "Integrations",
  maxLocations: "Locations",
  maxPhoneNumbers: "Phone numbers",
  maxAdminUsers: "Admin users",
  maxEscalationContacts: "Escalation contacts",
  monthlyMinuteOverageRateCents: "Overage rate (cents / min)",
};

export const greeting = () => {
  const h = new Date().getHours();
  if (h < 12) return "Good morning";
  if (h < 17) return "Good afternoon";
  return "Good evening";
};

/**
 * Real sync state derived from API fields, never from a 200 on save.
 *  - synced: published timestamp exists, no pending changes, runtime healthy
 *  - not_live: never published, or saved changes pending publish
 *  - attention: runtime health degraded or publish failed
 */
export function computeSyncState({ lastPublishedAt, pendingChanges, healthOk = true, publishFailed = false }) {
  if (publishFailed || healthOk === false) return { state: "attention", label: "Needs attention" };
  if (!lastPublishedAt) return { state: "not_live", label: "Not published yet" };
  if (pendingChanges) return { state: "not_live", label: "Changes not live" };
  return { state: "synced", label: "Synced" };
}

export const pct = (used, limit) => (!limit || limit <= 0 ? 0 : Math.min(100, Math.round((Number(used || 0) / Number(limit)) * 100)));

export const isE164 = (v) => /^\+[1-9]\d{6,14}$/.test((v || "").trim());

/** Human label for opaque Telnyx / runtime call ids (never dump the full v3: blob). */
export function shortCallRef(id) {
  const s = String(id || "").trim();
  if (!s) return "Call";
  if (s.startsWith("v3:")) return `Call ${s.slice(3, 9)}`;
  if (s.length > 16) return `Call ${s.slice(0, 8)}`;
  return s;
}

export function callPartyLabel(item) {
  const name = item && (item.callerName || item.caller_name || item.name);
  const phone = item && (item.callerDisplay || item.callerId || item.caller_id || item.phone);
  if (name && String(name).trim()) return String(name).trim();
  if (phone && String(phone).trim() && !String(phone).startsWith("v3:")) return String(phone).trim();
  return shortCallRef(item && (item.call_id || item.callId || item.id));
}

export const QA_RUBRIC_LABELS = {
  noUnverifiedPrice: "No unverified price",
  orphanPromiseZero: "No orphan promise",
  terminalPersisted: "Outcome saved",
  emergencyEscalated: "Emergency handled",
  noUnwrittenPromise: "No unwritten promise",
  bookedClaimBackedByWrite: "Booking backed by write",
};

export const initials = (name) =>
  (name || "?")
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0])
    .join("")
    .toUpperCase();
