/**
 * Redact sensitive / internal fields from a published RuntimeTenantConfig
 * before returning it to admin APIs or logs.
 */
import type { RuntimeTenantConfig } from "./runtimeContract";

const URL_LIKE_KEYS = new Set([
  "whisperUrl",
  "kokoroUrl",
  "coquiXttsUrl",
  "chatterboxUrl",
  "qwen3TtsUrl",
  "misoTtsUrl",
  "magpieTtsUrl",
  "meloTtsUrl",
  "xttsUrl",
  "publicBaseUrl",
  "speakerWavUrl",
  "audioUrl",
  "url",
]);

function isInternalHostname(host: string): boolean {
  const h = host.toLowerCase();
  return (
    h === "localhost" ||
    h === "127.0.0.1" ||
    h === "::1" ||
    h.endsWith(".local") ||
    h === "whisper" ||
    h === "kokoro" ||
    h === "xtts" ||
    h === "chatterbox" ||
    h === "brain" ||
    h === "control" ||
    h === "veralux-qwen3-tts" ||
    h === "veralux-miso-tts" ||
    h === "miso-tts" ||
    h === "veralux-magpie-tts" ||
    h === "magpie-tts" ||
    h === "veralux-melo-tts" ||
    h === "melo-tts" ||
    h.startsWith("172.") ||
    h.startsWith("10.") ||
    h.startsWith("192.168.")
  );
}

/** Redact URL string to host class only (no path, query, or credentials). */
export function redactHttpUrlToPlaceholder(url: string | undefined): string | undefined {
  if (!url || typeof url !== "string") return undefined;
  const t = url.trim();
  if (!t) return undefined;
  try {
    const u = new URL(t);
    const internal = isInternalHostname(u.hostname);
    return internal ? "[redacted-internal]" : `[redacted-host:${u.hostname}]`;
  } catch {
    return "[redacted]";
  }
}

function redactKeyValue(key: string, value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string" && URL_LIKE_KEYS.has(key)) {
    return redactHttpUrlToPlaceholder(value) ?? "[redacted]";
  }
  return value;
}

/**
 * Returns a deep-cloned JSON-safe object with provider URLs and webhook material removed or replaced.
 */
export function redactPublishedRuntimeConfig(config: RuntimeTenantConfig): Record<string, unknown> {
  const raw = JSON.parse(JSON.stringify(config)) as Record<string, unknown>;
  delete raw.webhookSecret;
  if (typeof raw.webhookSecretRef === "string" && raw.webhookSecretRef.length > 0) {
    raw.webhookSecretRef = "[redacted]";
  }
  if (raw.stt && typeof raw.stt === "object") {
    const stt = raw.stt as Record<string, unknown>;
    if (typeof stt.whisperUrl === "string") stt.whisperUrl = redactHttpUrlToPlaceholder(stt.whisperUrl) ?? "[redacted]";
    if (stt.config && typeof stt.config === "object") {
      const c = stt.config as Record<string, unknown>;
      if (typeof c.url === "string") c.url = redactHttpUrlToPlaceholder(c.url) ?? "[redacted]";
    }
  }
  if (raw.tts && typeof raw.tts === "object") {
    const tts = raw.tts as Record<string, unknown>;
    for (const k of ["kokoroUrl", "coquiXttsUrl", "chatterboxUrl", "qwen3TtsUrl", "misoTtsUrl", "magpieTtsUrl", "meloTtsUrl"]) {
      if (typeof tts[k] === "string") tts[k] = redactHttpUrlToPlaceholder(tts[k] as string) ?? "[redacted]";
    }
  }
  if (raw.audio && typeof raw.audio === "object") {
    const a = raw.audio as Record<string, unknown>;
    if (typeof a.publicBaseUrl === "string") {
      a.publicBaseUrl = redactHttpUrlToPlaceholder(a.publicBaseUrl as string) ?? "[redacted]";
    }
  }
  if (Array.isArray(raw.transferProfiles)) {
    for (const p of raw.transferProfiles) {
      if (p && typeof p === "object" && typeof (p as { audioUrl?: string }).audioUrl === "string") {
        (p as { audioUrl: string }).audioUrl =
          redactHttpUrlToPlaceholder((p as { audioUrl: string }).audioUrl) ?? "[redacted]";
      }
    }
  }
  if (raw.callForwarding && typeof raw.callForwarding === "object") {
    const cf = raw.callForwarding as { audioUrl?: string };
    if (typeof cf.audioUrl === "string") {
      cf.audioUrl = redactHttpUrlToPlaceholder(cf.audioUrl) ?? "[redacted]";
    }
  }
  if (raw.llmContext && typeof raw.llmContext === "object") {
    const ctx = raw.llmContext as Record<string, unknown>;
    if (ctx.prompts && typeof ctx.prompts === "object") {
      /* keep prompts text; no URLs expected in keys */
    }
  }
  return raw;
}
