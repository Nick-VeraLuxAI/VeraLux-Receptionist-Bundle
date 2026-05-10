import { pool } from "./db";
import { isMissedCallRow } from "./callSanitizer";
import type { AnalyticsSnapshot } from "./analytics";

export type CallAnalyticsPayload = AnalyticsSnapshot & {
  missedCalls: number;
  answeredCalls: number;
  /** Legacy keys used by portal.html */
  callCount: number;
  callerMessageCount: number;
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

/**
 * Derives the admin analytics snapshot from persisted `calls` rows (same table
 * as GET /api/admin/calls). Caller rows must be tenant-scoped before calling.
 */
export function aggregateCallRowsToAnalytics(
  rows: Array<{ stage: string | null; lead: unknown; history: unknown }>,
  topLimit = 10,
): CallAnalyticsPayload {
  const totalCalls = rows.length;
  let totalCallerMessages = 0;
  const q = new Map<string, number>();
  let missedCalls = 0;

  for (const row of rows) {
    if (isMissedCallRow(row)) missedCalls += 1;
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

  const answeredCalls = Math.max(0, totalCalls - missedCalls);

  return {
    totalCalls,
    totalCallerMessages,
    topQuestions,
    missedCalls,
    answeredCalls,
    callCount: totalCalls,
    callerMessageCount: totalCallerMessages,
  };
}

/** Analytics for one tenant from Postgres call history (tenant_id filter). */
export async function getCallAnalyticsPayloadForTenant(tenantId: string): Promise<CallAnalyticsPayload> {
  const client = await pool.connect();
  try {
    const r = await client.query(
      `select stage, lead, history from calls where tenant_id = $1 order by updated_at desc`,
      [tenantId],
    );
    return aggregateCallRowsToAnalytics(r.rows as Array<{ stage: string | null; lead: unknown; history: unknown }>);
  } finally {
    client.release();
  }
}
