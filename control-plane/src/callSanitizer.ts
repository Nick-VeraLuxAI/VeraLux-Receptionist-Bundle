/**
 * Safe call list payloads for client portal (no secrets, masked caller IDs).
 */

export function maskCallerId(raw: string | null | undefined): string {
  if (!raw || !String(raw).trim()) return "Unknown";
  const digits = String(raw).replace(/\D/g, "");
  if (digits.length < 4) return "••••";
  return `••••••${digits.slice(-4)}`;
}

function clip(s: string, max: number): string {
  const t = s.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "").trim();
  if (!t) return "";
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

export function summarizeHistory(history: unknown, maxLen = 400): string {
  if (!Array.isArray(history) || history.length === 0) return "";
  const tail = history.slice(-6);
  const parts: string[] = [];
  for (const row of tail) {
    if (!row || typeof row !== "object") continue;
    const r = row as { from?: unknown; message?: unknown; role?: unknown; content?: unknown };
    const role = typeof r.role === "string" ? r.role : typeof r.from === "string" ? r.from : "?";
    const msg =
      typeof r.message === "string"
        ? r.message
        : typeof r.content === "string"
          ? r.content
          : "";
    if (!msg.trim()) continue;
    parts.push(`${role}: ${clip(msg, 180)}`);
  }
  return clip(parts.join(" · "), maxLen);
}

/**
 * Map runtime transcript turns ({ role, content }) to admin UI history items
 * ({ from, message, timestamp }) expected by admin.html call cards.
 */
export function normalizeHistoryForAdminUi(history: unknown): Array<{
  from: string;
  message: string;
  timestamp: number;
}> {
  if (!Array.isArray(history)) return [];
  const out: Array<{ from: string; message: string; timestamp: number }> = [];
  for (const item of history) {
    if (!item || typeof item !== "object") continue;
    const o = item as {
      from?: unknown;
      message?: unknown;
      role?: unknown;
      content?: unknown;
      timestamp?: unknown;
    };
    if (typeof o.message === "string" && typeof o.from === "string") {
      out.push({
        from: o.from,
        message: o.message,
        timestamp: typeof o.timestamp === "number" ? o.timestamp : Date.now(),
      });
      continue;
    }
    const role = typeof o.role === "string" ? o.role.toLowerCase() : "";
    const content = typeof o.content === "string" ? o.content : "";
    const fromMap: Record<string, string> = {
      user: "caller",
      caller: "caller",
      assistant: "assistant",
      system: "system",
    };
    const from = fromMap[role] || "assistant";
    let ts = Date.now();
    if (typeof o.timestamp === "string") {
      const p = Date.parse(o.timestamp);
      if (!Number.isNaN(p)) ts = p;
    } else if (typeof o.timestamp === "number") {
      ts = o.timestamp;
    }
    out.push({ from, message: content, timestamp: ts });
  }
  return out;
}

export function isMissedCallRow(row: {
  stage: string | null;
  lead: unknown;
}): boolean {
  const st = String(row.stage || "").toLowerCase();
  if (st.includes("miss") || st.includes("abandon") || st === "no_answer") return true;
  const lead = row.lead as { missed?: boolean; outcome?: string } | null;
  if (lead && typeof lead === "object") {
    if (lead.missed === true) return true;
    if (typeof lead.outcome === "string" && lead.outcome.toLowerCase().includes("miss")) {
      return true;
    }
  }
  return false;
}
