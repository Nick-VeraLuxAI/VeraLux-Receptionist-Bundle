import { hasUsableApiKey } from "@veralux/shared";
import type { TtsMode, TTSConfig } from "./config";
import { logger } from "./middleware";
import { applyWavSpeakingRate, stripSpeakingRateInstruct } from "./audio/wavSpeakingRate";

const MAX_PREVIEW_CHARS = 500;

function previewFetchTimeoutMs(): number {
  const raw = process.env.TTS_PREVIEW_FETCH_TIMEOUT_MS;
  if (raw === undefined || raw === "") return 90_000;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 5_000) return 90_000;
  return Math.min(n, 300_000);
}

const DEFAULT_PHRASE =
  process.env.TTS_PREVIEW_SAMPLE_TEXT?.trim() ||
  "Hello, this is a quick voice preview from your receptionist settings.";

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

const PREVIEW_TTS_MODES = new Set<TtsMode>(["kokoro_http"]);

function previewNum(v: unknown, min: number, max: number): number | undefined {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  if (!Number.isFinite(n)) return undefined;
  return Math.min(max, Math.max(min, n));
}

function previewBool(v: unknown): boolean | undefined {
  if (v === true || v === false) return v;
  return undefined;
}

/**
 * Hear-voice sends the sliders the user is looking at. Merge those onto the
 * saved tenant config for this job only — do not persist, and ignore provider URLs.
 */
export function applyPreviewOverrides(cfg: TTSConfig, raw: unknown): TTSConfig {
  if (!raw || typeof raw !== "object") return cfg;
  const body = raw as Record<string, unknown>;
  const next: TTSConfig = { ...cfg };
  if (typeof body.ttsMode === "string" && PREVIEW_TTS_MODES.has(body.ttsMode as TtsMode)) {
    next.ttsMode = body.ttsMode as TtsMode;
  }
  if (typeof body.voiceId === "string" && body.voiceId.trim()) {
    next.voiceId = body.voiceId.trim().slice(0, 100);
  }
  if (typeof body.language === "string" && body.language.trim()) {
    next.language = body.language.trim().slice(0, 32);
  }
  const rate = previewNum(body.rate, 0.8, 1.2);
  if (rate !== undefined) next.rate = rate;
  const sdp = previewNum(body.meloSdpRatio, 0, 1);
  if (sdp !== undefined) next.meloSdpRatio = sdp;
  const noise = previewNum(body.meloNoiseScale, 0, 2);
  if (noise !== undefined) next.meloNoiseScale = noise;
  const noiseW = previewNum(body.meloNoiseScaleW, 0, 2);
  if (noiseW !== undefined) next.meloNoiseScaleW = noiseW;
  const magpieTemp = previewNum(body.magpieTemperature, 0.05, 1.5);
  if (magpieTemp !== undefined) next.magpieTemperature = magpieTemp;
  const magpieCfg = previewNum(body.magpieCfgScale, 0.5, 5);
  if (magpieCfg !== undefined) next.magpieCfgScale = magpieCfg;
  const magpieTopK = previewNum(body.magpieTopK, 1, 200);
  if (magpieTopK !== undefined) next.magpieTopK = Math.round(magpieTopK);
  const useCfg = previewBool(body.magpieUseCfg);
  if (useCfg !== undefined) next.magpieUseCfg = useCfg;
  const applyTn = previewBool(body.magpieApplyTn);
  if (applyTn !== undefined) next.magpieApplyTn = applyTn;
  if (typeof body.preset === "string" && /^(neutral|warm|energetic|calm)$/i.test(body.preset)) {
    next.preset = body.preset.toLowerCase() as TTSConfig["preset"];
  }
  next.ttsMode = "kokoro_http";
  return next;
}

const KOKORO_PRESET_SPEED: Record<string, number> = { neutral: 1, warm: 0.96, energetic: 1.08, calm: 0.88 };

function kokoroVoiceForLanguage(voice: string | undefined, language: string | undefined): string {
  const lang = String(language || "").toLowerCase().startsWith("en-gb") ? "en-GB" : "en-US";
  const id = String(voice || "af_bella").trim() || "af_bella";
  if (!/^(a[fm]_|b[fm]_)[a-z]+$/i.test(id)) {
    return lang === "en-GB" ? "bf_emma" : "af_bella";
  }
  const british = /^(bf_|bm_)/i.test(id);
  if (british === (lang === "en-GB")) return id;
  return /^(am_|bm_)/i.test(id) ? (lang === "en-GB" ? "bm_george" : "am_adam") : lang === "en-GB" ? "bf_emma" : "af_heart";
}

function kokoroSpeedForTuning(preset: string | undefined, rate: number | undefined): number {
  const base = Number.isFinite(rate) ? Math.min(1.2, Math.max(0.8, Number(rate))) : 1;
  const mul = KOKORO_PRESET_SPEED[String(preset || "neutral")] || 1;
  return Math.min(1.5, Math.max(0.5, Math.round(base * mul * 100) / 100));
}

function kokoroTextForPreset(text: string, preset: string | undefined): string {
  const t = String(text || "").trim();
  if (!t || !preset || preset === "neutral" || preset === "warm") return t;
  if (preset === "calm") return t.replace(/([.!?])\s+/g, "$1  ");
  if (preset === "energetic") return t.replace(/\s{2,}/g, " ");
  return t;
}

const ENGINE_DEFAULTS: Record<string, string> = {
  kokoro: process.env.KOKORO_URL || "http://kokoro:7001/tts",
  chatterbox: process.env.CHATTERBOX_URL || "http://chatterbox:7005",
  qwen3: process.env.QWEN3_TTS_URL || "http://veralux-qwen3-tts:7010",
  miso: process.env.MISO_TTS_URL || "http://veralux-miso-tts:7011",
  magpie: process.env.MAGPIE_TTS_URL || "http://veralux-magpie-tts:7012",
  melo: process.env.MELO_TTS_URL || "http://veralux-melo-tts:7013",
  coqui: process.env.COQUI_XTTS_URL || process.env.XTTS_URL || "http://xtts:7002/tts",
};

function belongsToEngine(url: string | undefined, token: string): string | undefined {
  const raw = String(url || "").trim();
  if (!raw) return undefined;
  try {
    const host = new URL(raw).hostname.toLowerCase();
    if (host.includes(token)) return raw;
  } catch {
    return undefined;
  }
  return undefined;
}

function engineUrl(token: keyof typeof ENGINE_DEFAULTS, saved: string | undefined): string {
  return belongsToEngine(saved, token) || ENGINE_DEFAULTS[token];
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
  } else if (dnsFail && humanName === "Miso TTS") {
    dockerHint =
      " Docker DNS could not resolve this host — the Miso container is usually not running. In this stack, Miso is service `miso-tts-gpu` (Compose profile `gpu`). Start: `docker compose --profile gpu up -d miso-tts-gpu` (high-VRAM NVIDIA GPU recommended). Until it is healthy, `miso-tts` / `veralux-miso-tts` will not resolve.";
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
  const mode = "kokoro_http";
  const timeoutMs = previewFetchTimeoutMs();
  logger.info("tts_preview_synthesize_start", {
    mode,
    textChars: text.length,
    timeoutMs,
    kokoroUrl: cfg.kokoroUrl,
    coquiXttsUrl: cfg.coquiXttsUrl,
    chatterboxUrl: cfg.chatterboxUrl,
    qwen3TtsUrl: cfg.qwen3TtsUrl,
    misoTtsUrl: cfg.misoTtsUrl,
    magpieTtsUrl: cfg.magpieTtsUrl,
    meloTtsUrl: cfg.meloTtsUrl,
    xttsUrl: cfg.xttsUrl,
    voiceId: cfg.voiceId,
    language: cfg.language,
    rate: cfg.rate,
    meloSdpRatio: cfg.meloSdpRatio,
    meloNoiseScale: cfg.meloNoiseScale,
    meloNoiseScaleW: cfg.meloNoiseScaleW,
    envQwen3: process.env.QWEN3_TTS_URL ? "(set)" : "(unset)",
  });

  if (mode === "kokoro_http") {
    const url = ttsPostUrl(engineUrl("kokoro", cfg.kokoroUrl));
    const voice = kokoroVoiceForLanguage(cfg.voiceId, cfg.language);
    const rate = kokoroSpeedForTuning(cfg.preset, cfg.rate);
    const res = await fetchTtsPreview("Kokoro TTS", url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: kokoroTextForPreset(text, cfg.preset),
        voice_id: voice,
        voice,
        rate,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    return ensureAudioResponse(res);
  }

  if (mode === "chatterbox_http") {
    const url = ttsPostUrl(engineUrl("chatterbox", cfg.chatterboxUrl));
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
    const url = ttsPostUrl(engineUrl("qwen3", cfg.qwen3TtsUrl));
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
    const instruct = sanitizeQwen3Str(stripSpeakingRateInstruct(cfg.qwen3Instruct), QWEN3_INSTRUCT_MAX);

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
    const audio = await ensureAudioResponse(res);
    return {
      body: applyWavSpeakingRate(audio.body, cfg.rate),
      contentType: audio.contentType,
    };
  }

  if (mode === "openai_tts") {
    const apiKey = process.env.OPENAI_API_KEY?.trim() || "";
    if (!hasUsableApiKey(apiKey)) {
      throw new Error("OpenAI TTS needs a real OPENAI_API_KEY (or tenant OpenAI BYOK). The current platform key is missing or a placeholder.");
    }
    const voice = (cfg.voiceId || "alloy").trim() || "alloy";
    const model = (cfg.cloudTtsModel || "tts-1").trim() || "tts-1";
    const res = await fetchTtsPreview("OpenAI TTS", "https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        voice,
        input: text,
        response_format: "wav",
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    return ensureAudioResponse(res);
  }

  if (mode === "elevenlabs") {
    const apiKey = process.env.ELEVENLABS_API_KEY?.trim() || "";
    if (!hasUsableApiKey(apiKey)) {
      throw new Error("ElevenLabs TTS needs ELEVENLABS_API_KEY on the control plane.");
    }
    const voice = encodeURIComponent((cfg.voiceId || "EXAVITQu4vr4xnSDxMaL").trim() || "EXAVITQu4vr4xnSDxMaL");
    const model = (cfg.cloudTtsModel || "eleven_turbo_v2_5").trim() || "eleven_turbo_v2_5";
    const url = `https://api.elevenlabs.io/v1/text-to-speech/${voice}?output_format=mp3_44100_128`;
    const res = await fetchTtsPreview("ElevenLabs", url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "xi-api-key": apiKey,
        Accept: "audio/mpeg",
      },
      body: JSON.stringify({ text, model_id: model }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    return ensureAudioResponse(res);
  }

  if (mode === "miso_tts_http") {
    const url = ttsPostUrl(engineUrl("miso", cfg.misoTtsUrl));
    const speakerRaw = Number.parseInt((cfg.voiceId || "0").trim(), 10);
    const speaker = Number.isFinite(speakerRaw) && speakerRaw >= 0 ? speakerRaw : 0;
    const body: Record<string, string | number> = {
      text,
      speaker,
    };
    if (cfg.misoMaxAudioLengthMs !== undefined) {
      body.max_audio_length_ms = Math.min(90_000, Math.max(500, Math.round(cfg.misoMaxAudioLengthMs)));
    }
    if (cfg.misoTemperature !== undefined && Number.isFinite(cfg.misoTemperature)) {
      body.temperature = Math.min(2, Math.max(0, cfg.misoTemperature));
    }
    if (cfg.misoTopK !== undefined && Number.isFinite(cfg.misoTopK)) {
      body.top_k = Math.min(1000, Math.max(1, Math.round(cfg.misoTopK)));
    }

    const res = await fetchTtsPreview(
      "Miso TTS",
      url,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      },
      { misoPostUrl: url, resolvedFrom: cfg.misoTtsUrl ? "misoTtsUrl" : cfg.xttsUrl ? "xttsUrl" : "fallback" }
    );
    return ensureAudioResponse(res);
  }

  if (mode === "magpie_tts_http") {
    const url = ttsPostUrl(engineUrl("magpie", cfg.magpieTtsUrl));
    const body: Record<string, string | number | boolean> = {
      text,
      speaker: (cfg.voiceId || "Sofia").trim() || "Sofia",
      language: (/^en/i.test(cfg.language || "") || (cfg.language || "").toLowerCase() === "english"
        ? "en"
        : (cfg.language || "en").trim().slice(0, 2).toLowerCase()) || "en",
    };
    if (cfg.magpieTemperature !== undefined && Number.isFinite(cfg.magpieTemperature)) {
      body.temperature = Math.min(1.5, Math.max(0.05, cfg.magpieTemperature));
    }
    if (cfg.magpieCfgScale !== undefined && Number.isFinite(cfg.magpieCfgScale)) {
      body.cfg_scale = Math.min(5, Math.max(0.5, cfg.magpieCfgScale));
    }
    if (cfg.magpieTopK !== undefined && Number.isFinite(cfg.magpieTopK)) {
      body.top_k = Math.min(200, Math.max(1, Math.round(cfg.magpieTopK)));
    }
    body.use_cfg = cfg.magpieUseCfg === true;
    body.apply_tn = cfg.magpieApplyTn === true;
    const res = await fetchTtsPreview(
      "Magpie TTS",
      url,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      },
      { magpiePostUrl: url, resolvedFrom: cfg.magpieTtsUrl ? "magpieTtsUrl" : "fallback" }
    );
    const audio = await ensureAudioResponse(res);
    return {
      body: applyWavSpeakingRate(audio.body, cfg.rate),
      contentType: audio.contentType,
    };
  }

  if (mode === "melo_tts_http") {
    const url = ttsPostUrl(engineUrl("melo", cfg.meloTtsUrl));
    const body: Record<string, string | number> = {
      text,
      speaker: (cfg.voiceId || "EN-US").trim() || "EN-US",
      language: (cfg.language || "EN").trim() || "EN",
      speed: Number.isFinite(cfg.rate) ? cfg.rate : 1,
      sdp_ratio: Number.isFinite(cfg.meloSdpRatio) ? Number(cfg.meloSdpRatio) : 0.2,
      noise_scale: Number.isFinite(cfg.meloNoiseScale) ? Number(cfg.meloNoiseScale) : 0.6,
      noise_scale_w: Number.isFinite(cfg.meloNoiseScaleW) ? Number(cfg.meloNoiseScaleW) : 0.8,
    };
    const res = await fetchTtsPreview(
      "MeloTTS",
      url,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      },
      { meloPostUrl: url, resolvedFrom: cfg.meloTtsUrl ? "meloTtsUrl" : "fallback" }
    );
    return ensureAudioResponse(res);
  }

  // coqui_xtts
  const url = ttsPostUrl(engineUrl("coqui", cfg.coquiXttsUrl));
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
