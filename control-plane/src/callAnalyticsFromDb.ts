import { pool } from "./db";
import { isMissedCallRow } from "./callSanitizer";
import type { AnalyticsSnapshot } from "./analytics";

export type CallAnalyticsRow = {
  stage: string | null;
  lead: unknown;
  history: unknown;
  created_at?: Date | string | null;
};

export type CallAnalyticsPayload = AnalyticsSnapshot & {
  missedCalls: number;
  answeredCalls: number;
  callCount: number;
  callerMessageCount: number;
  totals: {
    calls: number;
    leads: number;
    missedCalls: number;
    minutes: number;
    avgDurationSec: number;
    booked: number;
  };
  previousPeriod: {
    calls: number;
    leads: number;
    missedCalls: number;
    minutes: number;
    booked: number;
  } | null;
  daily: Array<{ date: string; calls: number; missed: number }>;
  byHour: Array<{ hour: number; calls: number }>;
  intents: Array<{ intent: string; count: number }>;
  outcomes: Array<{ outcome: string; count: number }>;
  leadStages: Array<{ stage: string; count: number }>;
};

function normalizeQuestion(text: string): string {
  return text.trim().toLowerCase().slice(0, 160);
}

function extractRoleAndMessage(item: unknown): { role: string; message: string } | null {
  if (!item || typeof item !== "object") return null;
  const o = item as Record<string, unknown>;
  if (typeof o.message === "string" && typeof o.from === "string") {
    return { role: o.from, message: o.message };
  }
  const role = typeof o.role === "string" ? o.role : "";
  const message =
    typeof o.content === "string"
      ? o.content
      : typeof o.message === "string"
        ? o.message
        : "";
  return { role, message };
}

function isCallerRole(role: string): boolean {
  const r = role.trim().toLowerCase();
  return r === "user" || r === "caller";
}

function asDate(value: Date | string | null | undefined): Date | null {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function leadRecord(lead: unknown): Record<string, unknown> {
  return lead && typeof lead === "object" ? (lead as Record<string, unknown>) : {};
}

function isBooked(row: CallAnalyticsRow): boolean {
  const stage = String(row.stage || "").toLowerCase();
  const lead = leadRecord(row.lead);
  const leadStage = String(lead.stage || "").toLowerCase();
  const completion = String(lead.completion || "").toLowerCase();
  return stage === "booked" || leadStage === "booked" || completion === "booked";
}

function hasLead(row: CallAnalyticsRow): boolean {
  const lead = leadRecord(row.lead);
  return Boolean(lead.name || lead.phone || lead.stage || lead.intent || Object.keys(lead).length);
}

function outcomeLabel(row: CallAnalyticsRow): string {
  const lead = leadRecord(row.lead);
  if (typeof lead.completion === "string" && lead.completion.trim()) return lead.completion;
  if (isMissedCallRow(row)) return "missed";
  if (row.stage && row.stage !== "end") return String(row.stage);
  return "completed";
}

function leadStageLabel(row: CallAnalyticsRow): string | null {
  const lead = leadRecord(row.lead);
  if (typeof lead.stage === "string" && lead.stage.trim()) return lead.stage;
  return null;
}

function countMap(entries: string[]): Array<{ key: string; count: number }> {
  const m = new Map<string, number>();
  for (const key of entries) {
    if (!key) continue;
    m.set(key, (m.get(key) ?? 0) + 1);
  }
  return [...m.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([key, count]) => ({ key, count }));
}

function summarizeWindow(rows: CallAnalyticsRow[]) {
  const calls = rows.length;
  const missedCalls = rows.filter((r) => isMissedCallRow(r)).length;
  const booked = rows.filter(isBooked).length;
  const leads = rows.filter(hasLead).length;
  return { calls, leads, missedCalls, minutes: 0, booked };
}

/**
 * Derives the admin analytics snapshot from persisted `calls` rows (same table
 * as GET /api/admin/calls). Caller rows must be tenant-scoped before calling.
 */
export function aggregateCallRowsToAnalytics(
  rows: Array<CallAnalyticsRow>,
  topLimit = 10,
  opts?: { days?: number; now?: Date },
): CallAnalyticsPayload {
  const now = opts?.now || new Date();
  const days = opts?.days && opts.days > 0 ? Math.min(90, Math.max(1, Math.round(opts.days))) : undefined;
  const windowMs = days ? days * 86400000 : null;
  const currentStart = windowMs ? new Date(now.getTime() - windowMs) : null;
  const previousStart = windowMs ? new Date(now.getTime() - 2 * windowMs) : null;

  const dated = rows.map((row) => ({ row, at: asDate(row.created_at) }));
  const currentRows = currentStart
    ? dated.filter((d) => d.at && d.at >= currentStart && d.at <= now).map((d) => d.row)
    : rows;
  const previousRows = currentStart && previousStart
    ? dated.filter((d) => d.at && d.at >= previousStart && d.at < currentStart).map((d) => d.row)
    : [];

  let totalCallerMessages = 0;
  const q = new Map<string, number>();
  for (const row of currentRows) {
    const hist = Array.isArray(row.history) ? row.history : [];
    for (const item of hist) {
      const ex = extractRoleAndMessage(item);
      if (!ex) continue;
      if (!isCallerRole(ex.role)) continue;
      const msg = ex.message.trim();
      if (!msg) continue;
      totalCallerMessages += 1;
      const key = normalizeQuestion(msg);
      if (!key) continue;
      q.set(key, (q.get(key) ?? 0) + 1);
    }
  }

  const topQuestions = [...q.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, topLimit)
    .map(([text, count]) => ({ text, count }));

  const totals = { ...summarizeWindow(currentRows), avgDurationSec: 0, minutes: 0 };
  totals.calls = currentRows.length;
  const missedCalls = totals.missedCalls;
  const answeredCalls = Math.max(0, totals.calls - missedCalls);

  const dayCount = days || 30;
  const daily: Array<{ date: string; calls: number; missed: number }> = [];
  const byDay = new Map<string, { calls: number; missed: number }>();
  for (const row of currentRows) {
    const at = asDate(row.created_at);
    if (!at) continue;
    const key = ymd(at);
    const cur = byDay.get(key) || { calls: 0, missed: 0 };
    cur.calls += 1;
    if (isMissedCallRow(row)) cur.missed += 1;
    byDay.set(key, cur);
  }
  for (let i = dayCount - 1; i >= 0; i -= 1) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - i));
    const key = ymd(d);
    daily.push({ date: key, calls: byDay.get(key)?.calls || 0, missed: byDay.get(key)?.missed || 0 });
  }

  const hourCounts = Array.from({ length: 24 }, (_, hour) => ({ hour, calls: 0 }));
  for (const row of currentRows) {
    const at = asDate(row.created_at);
    if (!at) continue;
    hourCounts[at.getUTCHours()].calls += 1;
  }

  return {
    totalCalls: totals.calls,
    totalCallerMessages,
    topQuestions,
    missedCalls,
    answeredCalls,
    callCount: totals.calls,
    callerMessageCount: totalCallerMessages,
    totals,
    previousPeriod: windowMs ? summarizeWindow(previousRows) : null,
    daily,
    byHour: hourCounts,
    intents: topQuestions.map((q) => ({ intent: q.text, count: q.count })),
    outcomes: countMap(currentRows.map(outcomeLabel)).map(({ key, count }) => ({ outcome: key, count })),
    leadStages: countMap(currentRows.map(leadStageLabel).filter((s): s is string => Boolean(s))).map(({ key, count }) => ({
      stage: key,
      count,
    })),
  };
}

/** Analytics for one tenant from Postgres call history (tenant_id filter). */
export async function getCallAnalyticsPayloadForTenant(
  tenantId: string,
  days?: number,
): Promise<CallAnalyticsPayload> {
  const client = await pool.connect();
  try {
    const r = await client.query(
      `select stage, lead, history, created_at from calls where tenant_id = $1 order by created_at desc`,
      [tenantId],
    );
    return aggregateCallRowsToAnalytics(
      r.rows as CallAnalyticsRow[],
      10,
      { days: days || 30 },
    );
  } finally {
    client.release();
  }
}
