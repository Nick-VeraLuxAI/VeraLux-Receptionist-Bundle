import type { TTSConfig } from "./config";

const MAX_PREVIEW_CHARS = 500;

function previewFetchTimeoutMs(): number {
  const raw = process.env.TTS_PREVIEW_FETCH_TIMEOUT_MS;
  if (raw === undefined || raw === "") return 90_000;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 5_000) return 90_000;
  return Math.min(n, 300_000);
}

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

/** Node fetch often throws `fetch failed` with no context — add URL + Docker hint for operators. */
function getFetchErrCause(err: unknown): string {
  if (!err || typeof err !== "object") return "";
  const c = (err as { cause?: unknown }).cause;
  if (c === undefined) return "";
  return c instanceof Error ? c.message : String(c);
}

function wrapPreviewFetchError(err: unknown, humanName: string, postUrl: string): Error {
  const base = err instanceof Error ? err.message : String(err);
  const cause = getFetchErrCause(err);
  const core = cause && cause !== base ? `${base} — ${cause}` : base;

  let hostPart = postUrl;
  try {
    const u = new URL(postUrl);
    hostPart = `${u.protocol}//${u.host}`;
  } catch {
    /* keep postUrl */
  }

  const dockerHint =
    /localhost|127\.0\.0\.1/i.test(postUrl) || /localhost|127\.0\.0\.1/i.test(hostPart)
      ? " If the API runs inside Docker, localhost here is the control-plane container itself — use the Qwen3/Kokoro/etc. service name on the compose network (e.g. http://qwen3-tts:7010)."
      : " Confirm the TTS service is running and reachable from the control-plane host.";

  return new Error(`${humanName} unreachable at ${hostPart}: ${core}.${dockerHint}`);
}

async function fetchTtsPreview(
  humanName: string,
  postUrl: string,
  init: RequestInit
): Promise<Response> {
  try {
    return await fetch(postUrl, init);
  } catch (err: unknown) {
    throw wrapPreviewFetchError(err, humanName, postUrl);
  }
}

async function ensureAudioResponse(res: Response): Promise<{ body: Buffer; contentType: string }> {
  const ct = res.headers.get("content-type") || "";
  const body = Buffer.from(await res.arrayBuffer());
  const snippet = body.toString("utf8").slice(0, 2000);

  const parseJsonErr = (): string => {
    try {
      const j = JSON.parse(snippet) as { error?: string; detail?: unknown; message?: string };
      const err = typeof j.error === "string" ? j.error : "";
      const det = typeof j.detail === "string" && j.detail.trim() ? j.detail.trim() : "";
      if (err && det) return `${err}: ${det}`;
      if (det) return det;
      if (typeof j.message === "string") return j.message;
      if (err) return err;
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
    const res = await fetchTtsPreview("Kokoro TTS", url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text,
        voice_id: cfg.voiceId,
        language: cfg.language,
        rate: cfg.rate,
      }),
      signal: AbortSignal.timeout(previewFetchTimeoutMs()),
    });
    return ensureAudioResponse(res);
  }

  if (mode === "chatterbox_http") {
    const url = ttsPostUrl(cfg.chatterboxUrl || cfg.xttsUrl);
    const speaker =
      cfg.defaultVoiceMode === "cloned" && cfg.clonedVoice?.speakerWavUrl?.trim()
        ? cfg.clonedVoice.speakerWavUrl.trim()
        : undefined;
    const res = await fetchTtsPreview("Chatterbox TTS", url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text,
        speaker_wav_url: speaker,
        language_id: (cfg.language || "en").trim() || "en",
      }),
      signal: AbortSignal.timeout(previewFetchTimeoutMs()),
    });
    return ensureAudioResponse(res);
  }

  if (mode === "qwen3_tts_http") {
    const url = ttsPostUrl(cfg.qwen3TtsUrl || cfg.xttsUrl);
    const gen: Record<string, boolean | number> = {};
    if (cfg.qwen3DoSample !== undefined) gen.do_sample = cfg.qwen3DoSample;
    if (cfg.qwen3Temperature !== undefined) gen.temperature = cfg.qwen3Temperature;
    if (cfg.qwen3TopP !== undefined) gen.top_p = cfg.qwen3TopP;
    if (cfg.qwen3TopK !== undefined) gen.top_k = cfg.qwen3TopK;
    if (cfg.qwen3RepetitionPenalty !== undefined) gen.repetition_penalty = cfg.qwen3RepetitionPenalty;
    if (cfg.qwen3MaxNewTokens !== undefined) gen.max_new_tokens = cfg.qwen3MaxNewTokens;
    if (cfg.qwen3NonStreamingMode !== undefined) gen.non_streaming_mode = cfg.qwen3NonStreamingMode;
    if (cfg.qwen3SubtalkerDoSample !== undefined) gen.subtalker_dosample = cfg.qwen3SubtalkerDoSample;
    if (cfg.qwen3SubtalkerTopK !== undefined) gen.subtalker_top_k = cfg.qwen3SubtalkerTopK;
    if (cfg.qwen3SubtalkerTopP !== undefined) gen.subtalker_top_p = cfg.qwen3SubtalkerTopP;
    if (cfg.qwen3SubtalkerTemperature !== undefined) gen.subtalker_temperature = cfg.qwen3SubtalkerTemperature;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text,
        speaker: (cfg.voiceId || "Ryan").trim() || "Ryan",
        language: (cfg.language || "English").trim() || "English",
        instruct: cfg.qwen3Instruct?.trim() || "",
        ...gen,
      }),
      signal: AbortSignal.timeout(previewFetchTimeoutMs()),
    });
    return ensureAudioResponse(res);
  }

  // coqui_xtts
  const url = ttsPostUrl(cfg.coquiXttsUrl || cfg.xttsUrl);
  const body: Record<string, string | number | boolean> = {
    text,
    language: (cfg.language || "en").trim() || "en",
    speed: cfg.coquiSpeed ?? cfg.rate,
  };
  if (cfg.defaultVoiceMode === "cloned" && cfg.clonedVoice?.speakerWavUrl?.trim()) {
    body.speaker_wav = cfg.clonedVoice.speakerWavUrl.trim();
  } else {
    body.voice_id = cfg.voiceId;
    body.speaker = cfg.voiceId;
  }
  if (cfg.coquiTemperature != null) body.temperature = cfg.coquiTemperature;
  if (cfg.coquiLengthPenalty != null) body.length_penalty = cfg.coquiLengthPenalty;
  if (cfg.coquiRepetitionPenalty != null) body.repetition_penalty = cfg.coquiRepetitionPenalty;
  if (cfg.coquiTopK != null) body.top_k = cfg.coquiTopK;
  if (cfg.coquiTopP != null) body.top_p = cfg.coquiTopP;
  if (cfg.coquiSplitSentences != null) body.split_sentences = cfg.coquiSplitSentences;

  const res = await fetchTtsPreview("Coqui XTTS", url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(previewFetchTimeoutMs()),
  });
  return ensureAudioResponse(res);
}
