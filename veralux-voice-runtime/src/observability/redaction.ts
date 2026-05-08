const PHONE_RE = /\+?\d[\d\s().-]{7,}\d/g;
const EMAIL_RE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const BEARER_RE = /\bBearer\s+[A-Za-z0-9\-._~+/]+=*/gi;
const TOKEN_QUERY_RE = /([?&](?:token|signature|api_key|key|auth)=)[^&\s]+/gi;

const SENSITIVE_KEY_RE = /(token|authorization|api[-_]?key|secret|signature|password|passcode|cookie|session)/i;
const TRANSCRIPT_KEY_RE = /(transcript|history|message|content|utterance|text)/i;

const REDACTED = '[redacted]';
const REDACTED_TRANSCRIPT = '[redacted_transcript]';

function redactInline(text: string): string {
  return text
    .replace(BEARER_RE, 'Bearer [redacted]')
    .replace(TOKEN_QUERY_RE, '$1[redacted]')
    .replace(EMAIL_RE, REDACTED)
    .replace(PHONE_RE, (match) => {
      const digits = match.replace(/\D/g, '');
      return digits.length >= 10 ? REDACTED : match;
    });
}

export function redactValue(value: unknown, options?: { redactTranscripts?: boolean }): unknown {
  const redactTranscripts = options?.redactTranscripts ?? true;

  if (typeof value === 'string') {
    return redactInline(value);
  }
  if (value == null || typeof value !== 'object') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactValue(entry, options));
  }

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (SENSITIVE_KEY_RE.test(k)) {
      out[k] = REDACTED;
      continue;
    }
    if (redactTranscripts && TRANSCRIPT_KEY_RE.test(k) && typeof v === 'string' && v.trim() !== '') {
      out[k] = REDACTED_TRANSCRIPT;
      continue;
    }
    out[k] = redactValue(v, options);
  }
  return out;
}
