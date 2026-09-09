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

function asLead(lead: unknown): Record<string, unknown> {
  return lead && typeof lead === "object" ? (lead as Record<string, unknown>) : {};
}

function textField(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** Talk time from stored lead.durationMs, else first-to-last transcript timestamps. */
export function durationMsFromCall(row: {
  lead: unknown;
  history: unknown;
}): number | null {
  const lead = asLead(row.lead);
  const stored = Number(lead.durationMs);
  if (Number.isFinite(stored) && stored > 0) return Math.round(stored);

  if (!Array.isArray(row.history) || row.history.length < 2) return null;
  const stamps = row.history
    .map((item) => {
      if (!item || typeof item !== "object") return NaN;
      const ts = (item as { timestamp?: unknown }).timestamp;
      if (typeof ts === "number" && Number.isFinite(ts)) return ts;
      if (typeof ts === "string") return Date.parse(ts);
      return NaN;
    })
    .filter((n) => Number.isFinite(n));
  if (stamps.length < 2) return null;
  const span = Math.max(...stamps) - Math.min(...stamps);
  if (!Number.isFinite(span) || span < 0 || span > 4 * 60 * 60 * 1000) return null;
  return Math.round(span);
}

function transcriptTurns(history: unknown, createdAt: string | null) {
  const start = createdAt ? Date.parse(createdAt) : NaN;
  return normalizeHistoryForAdminUi(history).map((turn) => ({
    role: turn.from === "caller" ? "caller" : "assistant",
    text: turn.message,
    atMs: Number.isFinite(start) ? Math.max(0, turn.timestamp - start) : 0,
  }));
}

function qualityScore(status: unknown): number | null {
  if (status === "good") return 5;
  if (status === "warning") return 3;
  if (status === "poor") return 1;
  return null;
}

export function presentAdminCall(
  row: {
    id: string;
    tenant_id: string;
    caller_id: string | null;
    stage: string | null;
    lead: unknown;
    history: unknown;
    created_at: string;
    updated_at: string;
  },
  qualitySummary?: Record<string, unknown> | null,
  options?: { includeRecording?: boolean },
) {
  const lead = asLead(row.lead);
  const name = textField(lead.name);
  const phone = textField(lead.phone) || row.caller_id;
  const intent = textField(lead.issue) || textField(lead.jobType);
  const outcome = textField(lead.completion) || textField(lead.outcome);
  const callControlId = textField(lead.voiceCallControlId);
  const toNumber = textField(lead.toNumber) || textField(lead.to_number);
  const hasLead = Boolean(name || textField(lead.issue) || textField(lead.phone) || intent);
  const stage = row.stage === "end" ? "ended" : row.stage || "unknown";
  const score = qualityScore(qualitySummary?.qualityStatus);
  const audioIssues: string[] = [];
  if (qualitySummary?.interruptionDetected === true) audioIssues.push("caller_interrupted");
  if (qualitySummary?.deadAirDetected === true) audioIssues.push("no_speech_detected");
  const echo = qualitySummary?.echoRisk;
  if (echo === "high" || echo === "medium") audioIssues.push("background_noise");

  return {
    id: row.id,
    tenantId: row.tenant_id,
    callerId: row.caller_id,
    callerDisplay: maskCallerId(row.caller_id),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    durationMs: durationMsFromCall(row),
    missed: isMissedCallRow({ stage: row.stage, lead: row.lead }),
    stage,
    outcome,
    intent,
    toNumber,
    callControlId,
    recordingUrl: options?.includeRecording
      ? textField(lead.recordingUrl) || textField(lead.recording_url) || null
      : null,
    transcriptSummary: summarizeHistory(row.history),
    transcript: transcriptTurns(row.history, row.created_at),
    history: normalizeHistoryForAdminUi(row.history),
    lead: hasLead
      ? {
          name,
          phone,
          intent,
          stage: outcome === "booked" ? "booked" : stage,
          needsAttention: textField(lead.completionReason) === "hangup_without_terminal",
        }
      : null,
    callQuality: score == null
      ? null
      : {
          score,
          latencyMs: typeof qualitySummary?.avgLlmLatencyMs === "number" ? qualitySummary.avgLlmLatencyMs : null,
          interruptions: qualitySummary?.interruptionDetected === true ? 1 : 0,
          sttConfidence: typeof qualitySummary?.transcriptQuality === "string"
            ? qualitySummary.transcriptQuality === "good"
              ? 0.9
              : qualitySummary.transcriptQuality === "medium"
                ? 0.7
                : 0.4
            : null,
          audioIssues,
        },
  };
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

export type CallHistoryRow = {
  id: string;
  caller_id?: string | null;
  stage: string | null;
  lead: unknown;
  history: unknown;
  created_at: string | Date;
};

const GREETING_STUB_WINDOW_MS = 15 * 60 * 1000;

function rowCreatedMs(row: CallHistoryRow): number {
  const raw = row.created_at;
  if (raw instanceof Date) return raw.getTime();
  const t = Date.parse(String(raw || ""));
  return Number.isFinite(t) ? t : 0;
}

function voiceControlIdFromLead(lead: unknown): string {
  if (!lead || typeof lead !== "object") return "";
  const v = (lead as { voiceCallControlId?: unknown }).voiceCallControlId;
  return typeof v === "string" ? v.trim() : "";
}

function isTerminalCallStage(stage: unknown): boolean {
  const s = String(stage || "").toLowerCase();
  return s === "end" || s === "ended" || s === "closed" || s === "completed" || s === "missed";
}

/** Empty pickup row written at call start, before hangup writes the real record. */
export function isGreetingCallStub(row: CallHistoryRow): boolean {
  if (isTerminalCallStage(row.stage)) return false;
  const lead = asLead(row.lead);
  const duration = Number(lead.durationMs);
  if (Number.isFinite(duration) && duration > 0) return false;
  if (Array.isArray(row.history) && row.history.length > 0) return false;
  const stage = String(row.stage || "").toLowerCase();
  return stage === "greeting" || stage === "unknown" || !stage;
}

/**
 * One conversation is currently written twice: a greeting stub at answer, then a
 * separate ended row at hangup. Hide the stub when a completed row for the same
 * caller (or call-control id) exists shortly after.
 */
export function dedupeCallHistoryRows<T extends CallHistoryRow>(rows: T[]): T[] {
  const hide = new Set<string>();
  const stubs = rows.filter(isGreetingCallStub).sort((a, b) => rowCreatedMs(a) - rowCreatedMs(b));
  const completed = rows.filter((row) => !isGreetingCallStub(row)).sort((a, b) => rowCreatedMs(a) - rowCreatedMs(b));
  const unpaired = [...completed];

  for (const stub of stubs) {
    const stubCc = voiceControlIdFromLead(stub.lead);
    const stubT = rowCreatedMs(stub);
    const idx = unpaired.findIndex((end) => {
      const endCc = voiceControlIdFromLead(end.lead);
      if (stubCc && endCc && stubCc === endCc) return true;
      if (stub.caller_id && end.caller_id === stub.caller_id) {
        const te = rowCreatedMs(end);
        return te >= stubT - 5_000 && te - stubT <= GREETING_STUB_WINDOW_MS;
      }
      return false;
    });
    if (idx >= 0) {
      hide.add(stub.id);
      unpaired.splice(idx, 1);
    }
  }
  return rows.filter((row) => !hide.has(row.id));
}
