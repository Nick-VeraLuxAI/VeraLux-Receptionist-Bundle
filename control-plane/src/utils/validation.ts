const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isUuid(s: string): boolean {
  return typeof s === "string" && UUID_REGEX.test(s.trim());
}

/** Telnyx call_control_id is typically `v3:` plus a token — colon must be allowed. */
const CALL_CONTROL_ID_REGEX = /^[A-Za-z0-9_.:+=/-]{1,256}$/;

export function sanitizeCallControlId(id: unknown): string | null {
  if (typeof id !== "string") return null;
  const t = id.trim();
  if (!t || t.length > 256) return null;
  if (!CALL_CONTROL_ID_REGEX.test(t)) return null;
  return t;
}
