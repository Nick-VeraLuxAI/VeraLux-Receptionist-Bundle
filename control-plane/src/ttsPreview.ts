import type { TTSConfig } from "./config";

const MAX_PREVIEW_CHARS = 500;
const FETCH_TIMEOUT_MS = 90_000;

const DEFAULT_PHRASE =
  "Hello, this is a quick voice preview from your VeraLux receptionist settings.";

export function resolvePreviewText(raw: unknown): string {
  if (typeof raw !== "string" || !raw.trim()) return DEFAULT_PHRASE;
  const t = raw.trim();
  return t.length > MAX_PREVIEW_CHARS ? t.slice(0, MAX_PREVIEW_CHARS) : t;
}

function ttsPostUrl(base: string | undefined): string {
  if (!base || !String(base).trim()) {
    throw new Error("tts_url_missing");
  }
  const u = String(base).trim().replace(/\/$/, "");
  return u.endsWith("/tts") ? u : `${u}/tts`;
}

async function ensureAudioResponse(res: Response): Promise<{ body: Buffer; contentType: string }> {
  const ct = res.headers.get("content-type") || "";
  const body = Buffer.from(await res.arrayBuffer());
  const snippet = body.toString("utf8").slice(0, 2000);

  const parseJsonErr = (): string => {
    try {
      const j = JSON.parse(snippet) as { error?: string; detail?: unknown; message?: string };
      const d = j.detail;
      if (typeof d === "string") return d;
      if (typeof j.message === "string") return j.message;
      if (typeof j.error === "string") return j.error;
    } catch {
      /* ignore */
    }
    return snippet || "unknown error";
  };

  if (!res.ok) {
    const errText = ct.includes("application/json") ? parseJsonErr() : snippet;
    throw new Error(`${res.status}: ${errText || res.statusText}`);
  }

  if (ct.includes("application/json")) {
    throw new Error(parseJsonErr() || "TTS returned JSON instead of audio");
  }

  return { body, contentType: ct || "audio/wav" };
}

/**
 * Calls the tenant's configured HTTP TTS (aligned with voice runtime: Kokoro / Coqui / Chatterbox).
 */
export async function synthesizeTtsPreview(
  cfg: TTSConfig,
  text: string
): Promise<{ body: Buffer; contentType: string }> {
  const mode = cfg.ttsMode || "coqui_xtts";

  if (mode === "kokoro_http") {
    const url = ttsPostUrl(cfg.kokoroUrl || cfg.xttsUrl);
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text,
        voice_id: cfg.voiceId,
        language: cfg.language,
        rate: cfg.rate,
      }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    return ensureAudioResponse(res);
  }

  if (mode === "chatterbox_http") {
    const url = ttsPostUrl(cfg.chatterboxUrl || cfg.xttsUrl);
    const speaker =
      cfg.defaultVoiceMode === "cloned" && cfg.clonedVoice?.speakerWavUrl?.trim()
        ? cfg.clonedVoice.speakerWavUrl.trim()
        : undefined;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text,
        speaker_wav_url: speaker,
        language_id: (cfg.language || "en").trim() || "en",
      }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    return ensureAudioResponse(res);
  }

  // coqui_xtts
  const url = ttsPostUrl(cfg.coquiXttsUrl || cfg.xttsUrl);
  const body: Record<string, string | number> = {
    text,
    language: (cfg.language || "en").trim() || "en",
    speed: cfg.rate,
  };
  if (cfg.defaultVoiceMode === "cloned" && cfg.clonedVoice?.speakerWavUrl?.trim()) {
    body.speaker_wav = cfg.clonedVoice.speakerWavUrl.trim();
  } else {
    body.voice_id = cfg.voiceId;
    body.speaker = cfg.voiceId;
  }

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  return ensureAudioResponse(res);
}
