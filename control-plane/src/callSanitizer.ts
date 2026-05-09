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
    const r = row as { from?: unknown; message?: unknown; role?: unknown };
    const role = typeof r.role === "string" ? r.role : typeof r.from === "string" ? r.from : "?";
    const msg = typeof r.message === "string" ? r.message : "";
    if (!msg.trim()) continue;
    parts.push(`${role}: ${clip(msg, 180)}`);
  }
  return clip(parts.join(" · "), maxLen);
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
