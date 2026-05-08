const TOKEN_RE = /\b(?:bearer\s+)?[A-Za-z0-9._~-]{20,}\b/gi;
const PHONE_RE = /\+?[1-9]\d{9,14}/g;
const EMAIL_RE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const STREAM_URL_RE = /(wss?:\/\/[^\s"'<>]+)/gi;

const SENSITIVE_KEY_RE =
  /(api[_-]?key|token|secret|signature|authorization|password|cookie|session|webhook)/i;

function redactString(value: string): string {
  return value
    .replace(STREAM_URL_RE, '[REDACTED_STREAM_URL]')
    .replace(EMAIL_RE, '[REDACTED_EMAIL]')
    .replace(PHONE_RE, '[REDACTED_PHONE]')
    .replace(TOKEN_RE, '[REDACTED_TOKEN]');
}

export function redactControlPlaneLogValue(value: unknown): unknown {
  if (value == null) return value;
  if (typeof value === 'string') return redactString(value);
  if (Array.isArray(value)) return value.map(redactControlPlaneLogValue);
  if (typeof value === 'object') {
    const input = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [key, raw] of Object.entries(input)) {
      if (SENSITIVE_KEY_RE.test(key)) {
        out[key] = '[REDACTED]';
        continue;
      }
      out[key] = redactControlPlaneLogValue(raw);
    }
    return out;
  }
  return value;
}
