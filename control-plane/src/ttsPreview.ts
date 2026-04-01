import type { TTSConfig } from "./config";
import { logger } from "./middleware";

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

const QWEN3_SPEAKER_MAX = 100;
const QWEN3_LANG_MAX = 32;
const QWEN3_INSTRUCT_MAX = 500;
const CTRL = /[\x00-\x08\x0B\x0C\x0E-\x1F]/g;

function sanitizeQwen3Str(s: string | undefined, maxLen: number): string {
  const t = (s ?? "").replace(CTRL, "").trim();
  return t.length > maxLen ? t.slice(0, maxLen) : t;
}

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

/** Rich error fields for logs (Node fetch / system errors expose errno, code, syscall). */
export function serializeUnknownError(err: unknown): Record<string, unknown> {
  if (err == null) return { value: String(err) };
  if (!(err instanceof Error)) return { type: "non_error", value: String(err) };
  const o: Record<string, unknown> = { name: err.name, message: err.message };
  const ne = err as NodeJS.ErrnoException & {
    syscall?: string;
    address?: string;
    port?: number;
    cause?: unknown;
  };
  if (ne.code) o.code = ne.code;
  if (ne.errno !== undefined) o.errno = ne.errno;
  if (ne.syscall) o.syscall = ne.syscall;
  if (ne.address) o.address = ne.address;
  if (ne.port !== undefined) o.port = ne.port;
  if (ne.cause !== undefined) {
    if (ne.cause instanceof Error) {
      const c = ne.cause as NodeJS.ErrnoException & { address?: string; port?: number };
      o.causeDetail = {
        name: c.name,
        message: c.message,
        code: c.code,
        errno: c.errno,
        syscall: c.syscall,
        address: c.address,
        port: c.port,
      };
    } else {
      o.cause = String(ne.cause);
    }
  }
  if (err.stack) {
    const lines = err.stack.split("\n").slice(0, 8);
    o.stackHead = lines.join("\n");
  }
  return o;
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

  const lowCore = core.toLowerCase();
  const dnsFail =
    lowCore.includes("getaddrinfo") ||
    lowCore.includes("eai_again") ||
    lowCore.includes("enotfound") ||
    lowCore.includes("name or service not known");
  const refused =
    lowCore.includes("econnrefused") ||
    lowCore.includes("connection refused");

  let dockerHint: string;
  if (/localhost|127\.0\.0\.1/i.test(postUrl) || /localhost|127\.0\.0\.1/i.test(hostPart)) {
    dockerHint =
      " If the API runs inside Docker, localhost here is the control-plane container itself — use the TTS service hostname on the compose network (e.g. http://veralux-qwen3-tts:7010).";
  } else if (dnsFail && humanName === "Qwen3 TTS") {
    dockerHint =
      " Docker DNS could not resolve this host — the Qwen3 container is usually not running. In this stack, Qwen3 is service `qwen3-tts-gpu` (Compose profile `gpu`). Start: `docker compose --profile gpu up -d qwen3-tts-gpu` (NVIDIA GPU + image required). Until it is healthy, `qwen3-tts` / `veralux-qwen3-tts` will not resolve.";
  } else if (dnsFail) {
    dockerHint =
      " Docker DNS could not resolve this hostname — start the TTS container and ensure it uses the same Docker network as the control plane.";
  } else if (refused) {
    dockerHint =
      " Nothing accepted the connection on that host:port — the service may be down or the port wrong.";
  } else {
    dockerHint = " Confirm the TTS service is running and reachable from the control-plane host.";
  }

  return new Error(`${humanName} unreachable at ${hostPart}: ${core}.${dockerHint}`);
}

async function fetchTtsPreview(
  humanName: string,
  postUrl: string,
  init: RequestInit,
  logCtx?: Record<string, unknown>
): Promise<Response> {
  try {
    return await fetch(postUrl, init);
  } catch (err: unknown) {
    logger.error("tts_preview_fetch_network_error", {
      engine: humanName,
      postUrl,
      ...logCtx,
      error: serializeUnknownError(err),
    });
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
    logger.warn("tts_preview_tts_http_error", {
      status: res.status,
      statusText: res.statusText,
      contentType: ct || "(none)",
      bodySnippet: snippet.slice(0, 500),
    });
    throw new Error(`${res.status}: ${errText || res.statusText}`);
  }

  if (ct.includes("application/json")) {
    const parsed = parseJsonErr() || "TTS returned JSON instead of audio";
    logger.warn("tts_preview_tts_returned_json", {
      contentType: ct,
      bodySnippet: snippet.slice(0, 500),
    });
    throw new Error(parsed);
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
  const timeoutMs = previewFetchTimeoutMs();
  logger.info("tts_preview_synthesize_start", {
    mode,
    textChars: text.length,
    timeoutMs,
    kokoroUrl: cfg.kokoroUrl,
    coquiXttsUrl: cfg.coquiXttsUrl,
    chatterboxUrl: cfg.chatterboxUrl,
    qwen3TtsUrl: cfg.qwen3TtsUrl,
    xttsUrl: cfg.xttsUrl,
    voiceId: cfg.voiceId,
    envQwen3: process.env.QWEN3_TTS_URL ? "(set)" : "(unset)",
  });

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
      signal: AbortSignal.timeout(timeoutMs),
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
      signal: AbortSignal.timeout(timeoutMs),
    });
    return ensureAudioResponse(res);
  }

  if (mode === "qwen3_tts_http") {
    const url = ttsPostUrl(cfg.qwen3TtsUrl || cfg.xttsUrl);
    const gen: Record<string, boolean | number> = {};
    const putNum = (key: string, v: number | undefined, min: number, max: number) => {
      if (v === undefined || !Number.isFinite(v)) return;
      gen[key] = Math.min(max, Math.max(min, v));
    };
    const putInt = (key: string, v: number | undefined, min: number, max: number) => {
      if (v === undefined || !Number.isFinite(v)) return;
      gen[key] = Math.min(max, Math.max(min, Math.round(v)));
    };
    if (cfg.qwen3DoSample !== undefined) gen.do_sample = cfg.qwen3DoSample;
    else gen.do_sample = false;
    putNum("temperature", cfg.qwen3Temperature, 0, 2);
    putNum("top_p", cfg.qwen3TopP, 0, 1);
    putInt("top_k", cfg.qwen3TopK, 0, 1_000_000);
    putNum("repetition_penalty", cfg.qwen3RepetitionPenalty, 0.5, 2);
    putInt("max_new_tokens", cfg.qwen3MaxNewTokens, 1, 32768);
    if (cfg.qwen3NonStreamingMode !== undefined) gen.non_streaming_mode = cfg.qwen3NonStreamingMode;
    if (cfg.qwen3SubtalkerDoSample !== undefined) gen.subtalker_dosample = cfg.qwen3SubtalkerDoSample;
    putInt("subtalker_top_k", cfg.qwen3SubtalkerTopK, 0, 1_000_000);
    putNum("subtalker_top_p", cfg.qwen3SubtalkerTopP, 0, 1);
    putNum("subtalker_temperature", cfg.qwen3SubtalkerTemperature, 0, 2);
    const speaker = sanitizeQwen3Str(cfg.voiceId || "Ryan", QWEN3_SPEAKER_MAX) || "Ryan";
    const language = sanitizeQwen3Str(cfg.language || "English", QWEN3_LANG_MAX) || "English";
    const instruct = sanitizeQwen3Str(cfg.qwen3Instruct, QWEN3_INSTRUCT_MAX);

    const res = await fetchTtsPreview(
      "Qwen3 TTS",
      url,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text,
          speaker,
          language,
          instruct,
          ...gen,
        }),
        signal: AbortSignal.timeout(timeoutMs),
      },
      { qwen3PostUrl: url, resolvedFrom: cfg.qwen3TtsUrl ? "qwen3TtsUrl" : cfg.xttsUrl ? "xttsUrl" : "fallback" }
    );
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
    signal: AbortSignal.timeout(timeoutMs),
  });
  return ensureAudioResponse(res);
}
