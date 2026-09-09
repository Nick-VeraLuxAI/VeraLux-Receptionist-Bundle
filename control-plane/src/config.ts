import dotenv from "dotenv";
dotenv.config();
import { hasUsableApiKey, ONPREM_NEMOTRON_CHAT_URL, ONPREM_NEMOTRON_MODEL } from "@veralux/shared";

export type LLMProvider = "local" | "openai";

export interface LLMRuntimeConfig {
  provider: LLMProvider;
  localUrl?: string;
  openaiModel?: string;
  openaiApiKey?: string;
}

const DEFAULT_LOCAL_URL = process.env.LOCAL_LLM_URL || ONPREM_NEMOTRON_CHAT_URL;
const DEFAULT_OPENAI_MODEL = "gpt-4o-mini";
const DEFAULT_ONPREM_MODEL = process.env.LOCAL_LLM_MODEL || process.env.OPENAI_MODEL || ONPREM_NEMOTRON_MODEL;

function defaultLlmProvider(): LLMProvider {
  return (process.env.LLM_PROVIDER || "").toLowerCase() === "openai" ? "openai" : "local";
}

// STT defaults (env → fallback)
const DEFAULT_WHISPER_URL =
  process.env.WHISPER_URL || "http://127.0.0.1:9000/transcribe";

// TTS defaults (env → fallback). Kokoro is the only live engine.
const DEFAULT_TTS_URL =
  process.env.KOKORO_URL ||
  "http://kokoro:7001/tts";

const DEFAULT_TTS_VOICE =
  process.env.KOKORO_VOICE_ID ||
  "af_bella";

// ───────────────────────────────────────────────
// Voice tuning + presets (XTTS & Kokoro)
// NOTE: Kokoro servers commonly don’t support “energy/variation” style knobs.
// We are hiding/removing those and keeping only: voiceId, language, rate, preset.
// ───────────────────────────────────────────────

export type VoicePreset = "neutral" | "warm" | "energetic" | "calm";
export type TtsMode = "kokoro_http" | "coqui_xtts" | "chatterbox_http" | "qwen3_tts_http" | "miso_tts_http" | "magpie_tts_http" | "melo_tts_http" | "openai_tts" | "elevenlabs";
export type ChatterboxVariant = "turbo" | "standard" | "multilingual";
export type VoiceMode = "preset" | "cloned";

export interface ClonedVoiceConfig {
  speakerWavUrl: string;    // URL to reference WAV file for voice cloning
  label?: string;            // Friendly name (e.g., "Sarah's Voice")
}

/**
 * Tenant-facing / portal-safe TTS snapshot: no raw provider URLs.
 * Superadmin diagnostics may still attach redacted host previews separately.
 */
export interface SafeTtsPublicConfig {
  ttsMode: TtsMode;
  voiceId: string;
  language: string;
  rate: number;
  preset?: VoicePreset;
  chatterboxVariant?: ChatterboxVariant;
  defaultVoiceMode?: VoiceMode;
  /** True when an XTTS / legacy base URL is configured (value not exposed). */
  xttsEndpointConfigured: boolean;
  kokoroEndpointConfigured: boolean;
  coquiXttsEndpointConfigured: boolean;
  chatterboxEndpointConfigured: boolean;
  qwen3EndpointConfigured: boolean;
  misoEndpointConfigured: boolean;
  magpieEndpointConfigured: boolean;
  meloEndpointConfigured: boolean;
  openaiTtsConfigured: boolean;
  elevenlabsConfigured: boolean;
  cloudTtsModel?: string;
  clonedVoiceReferenceConfigured: boolean;
  clonedVoiceLabel?: string;
  /** Portal-safe: no speakerWavUrl; use speakerWavConfigured + label only. */
  clonedVoice?: { label?: string; speakerWavConfigured: boolean };
  qwen3Instruct?: string;
  qwen3DoSample?: boolean;
  qwen3Temperature?: number;
  qwen3TopP?: number;
  qwen3TopK?: number;
  qwen3RepetitionPenalty?: number;
  qwen3MaxNewTokens?: number;
  qwen3NonStreamingMode?: boolean;
  qwen3SubtalkerDoSample?: boolean;
  qwen3SubtalkerTopK?: number;
  qwen3SubtalkerTopP?: number;
  qwen3SubtalkerTemperature?: number;
  qwen3Streaming?: boolean;
  misoMaxAudioLengthMs?: number;
  misoTemperature?: number;
  misoTopK?: number;
  magpieTemperature?: number;
  magpieCfgScale?: number;
  magpieTopK?: number;
  magpieUseCfg?: boolean;
  magpieApplyTn?: boolean;
  meloSdpRatio?: number;
  meloNoiseScale?: number;
  meloNoiseScaleW?: number;
  coquiTemperature?: number;
  coquiLengthPenalty?: number;
  coquiRepetitionPenalty?: number;
  coquiTopK?: number;
  coquiTopP?: number;
  coquiSpeed?: number;
  coquiSplitSentences?: boolean;
}

export interface TTSConfig {
  xttsUrl: string;           // TTS server URL (XTTS or Kokoro)
  voiceId: string;           // maps to the upstream TTS provider voice key
  language: string;          // XTTS: ISO 639-1 (e.g. en); Kokoro: often "a" / "b"
  rate: number;              // 1.0 = normal speed (we default to 0.95 for phone)
  preset?: VoicePreset;
  
  // Extended fields for XTTS voice cloning
  ttsMode?: TtsMode;
  /** OpenAI TTS / ElevenLabs model id (voice stays in voiceId). */
  cloudTtsModel?: string;
  coquiXttsUrl?: string;                  // URL for XTTS server
  kokoroUrl?: string;                     // URL for Kokoro server
  /** Chatterbox TTS HTTP base (e.g. http://host:7005 — /tts is appended by runtime). */
  chatterboxUrl?: string;
  /** Qwen3-TTS HTTP base (e.g. http://host:7010 — /tts is appended by preview/runtime). */
  qwen3TtsUrl?: string;
  /** Miso TTS 8B HTTP base (e.g. http://host:7011 — /tts is appended by preview/runtime). */
  misoTtsUrl?: string;
  /** NVIDIA Magpie HTTP base (e.g. http://host:7012). */
  magpieTtsUrl?: string;
  /** MeloTTS HTTP base (e.g. http://host:7013). */
  meloTtsUrl?: string;
  /** Optional style hint for Qwen3 CustomVoice preview. */
  qwen3Instruct?: string;
  /** Qwen3 CustomVoice generation (optional; forwarded to qwen3_tts_server / generate_custom_voice). */
  qwen3DoSample?: boolean;
  qwen3Temperature?: number;
  qwen3TopP?: number;
  qwen3TopK?: number;
  qwen3RepetitionPenalty?: number;
  qwen3MaxNewTokens?: number;
  qwen3NonStreamingMode?: boolean;
  qwen3SubtalkerDoSample?: boolean;
  qwen3SubtalkerTopK?: number;
  qwen3SubtalkerTopP?: number;
  qwen3SubtalkerTemperature?: number;
  /**
   * When true, voice runtime splits long Qwen3 utterances into chunks (sentences) and
   * synthesizes each via separate /tts calls so the first audio can start sooner.
   */
  qwen3Streaming?: boolean;
  /** Miso TTS generate() knobs. */
  misoMaxAudioLengthMs?: number;
  misoTemperature?: number;
  misoTopK?: number;
  magpieTemperature?: number;
  magpieCfgScale?: number;
  magpieTopK?: number;
  magpieUseCfg?: boolean;
  magpieApplyTn?: boolean;
  meloSdpRatio?: number;
  meloNoiseScale?: number;
  meloNoiseScaleW?: number;
  /** Coqui XTTS decoding (optional; forwarded to your XTTS HTTP API). */
  coquiTemperature?: number;
  coquiLengthPenalty?: number;
  coquiRepetitionPenalty?: number;
  coquiTopK?: number;
  coquiTopP?: number;
  /** Explicit XTTS speed; if unset, `rate` (speaking speed slider) is used for synthesis. */
  coquiSpeed?: number;
  coquiSplitSentences?: boolean;
  /** Must match the Chatterbox server CHATTERBOX_VARIANT. */
  chatterboxVariant?: ChatterboxVariant;
  clonedVoice?: ClonedVoiceConfig;        // Cloned voice profile
  defaultVoiceMode?: VoiceMode;           // Default voice mode at call start
}

// small helper so bad env values don’t wreck things
function parseNumberEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}

/** Strip control chars and cap length so corrupt DB / API data cannot balloon JSON or crash downstream. */
const TTS_CTRL_CHARS = /[\x00-\x08\x0B\x0C\x0E-\x1F]/g;

function truncateTtsField(s: string | undefined, maxLen: number): string {
  const t = (s ?? "").replace(TTS_CTRL_CHARS, "").trim();
  return t.length > maxLen ? t.slice(0, maxLen) : t;
}

function clampOptNum(n: number | undefined, min: number, max: number): number | undefined {
  if (n === undefined) return undefined;
  if (!Number.isFinite(n)) return undefined;
  return clamp(n, min, max);
}

function clampOptInt(n: number | undefined, min: number, max: number): number | undefined {
  if (n === undefined) return undefined;
  if (!Number.isFinite(n)) return undefined;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/** On update, ignore non-finite `next` and keep `current`. */
function mergeBoundedNum(
  next: number | undefined,
  current: number | undefined,
  min: number,
  max: number
): number | undefined {
  if (next === undefined) return current;
  if (!Number.isFinite(next)) return current;
  return clamp(next, min, max);
}

function mergeBoundedInt(
  next: number | undefined,
  current: number | undefined,
  min: number,
  max: number
): number | undefined {
  if (next === undefined) return current;
  if (!Number.isFinite(next)) return current;
  return Math.min(max, Math.max(min, Math.round(next)));
}

function sanitizeUrl(value: string | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : undefined;
}

const KOKORO_VOICE_RE = /^(a[fm]_|b[fm]_)[a-z]+$/i;

function defaultKokoroVoice(): string {
  const envV = (process.env.KOKORO_VOICE_ID || "").trim();
  return KOKORO_VOICE_RE.test(envV) ? envV : "af_bella";
}

export function coerceKokoroVoiceId(voice?: string): string {
  const v = (voice || "").trim();
  return KOKORO_VOICE_RE.test(v) ? v : defaultKokoroVoice();
}

function coerceKokoroLanguage(lang?: string, voice?: string): string {
  const l = (lang || "").trim();
  if (/^en-GB$/i.test(l) || /^(bf_|bm_)/i.test(voice || "")) return "en-GB";
  return "en-US";
}

function getEnvWhisperUrl(): string | undefined {
  return sanitizeUrl(process.env.WHISPER_URL);
}

function getEnvTtsUrl(): string | undefined {
  return sanitizeUrl(process.env.KOKORO_URL);
}

function getEnvChatterboxUrl(): string | undefined {
  return sanitizeUrl(process.env.CHATTERBOX_URL);
}

function getEnvQwen3TtsUrl(): string | undefined {
  return sanitizeUrl(process.env.QWEN3_TTS_URL);
}

function getEnvMisoTtsUrl(): string | undefined {
  return sanitizeUrl(process.env.MISO_TTS_URL);
}

function getEnvMagpieTtsUrl(): string | undefined {
  return sanitizeUrl(process.env.MAGPIE_TTS_URL) || "http://veralux-magpie-tts:7012";
}

function getEnvMeloTtsUrl(): string | undefined {
  return sanitizeUrl(process.env.MELO_TTS_URL) || "http://veralux-melo-tts:7013";
}

/** Host is loopback — not reachable from the control-plane container in Docker. */
function isLoopbackHttpUrl(urlStr: string): boolean {
  try {
    const u = new URL(urlStr);
    const h = u.hostname.toLowerCase();
    return h === "localhost" || h === "127.0.0.1" || h === "::1" || h === "[::1]";
  } catch {
    return false;
  }
}

/** Prefer CHATTERBOX_URL when the DB still has a dev-only loopback URL. */
function resolveChatterboxUrl(
  saved: string | undefined,
  envUrl: string | undefined
): string | undefined {
  const s = sanitizeUrl(saved);
  const e = envUrl;
  if (e && s && isLoopbackHttpUrl(s)) return e;
  return s || e;
}

/** Old docs / UI used hostname `qwen3-tts`; compose uses `veralux-qwen3-tts` + env default. */
function isLegacyQwen3DockerHostname(urlStr: string): boolean {
  try {
    return new URL(urlStr).hostname.toLowerCase() === "qwen3-tts";
  } catch {
    return false;
  }
}

function isNonQwen3TtsHost(urlStr: string): boolean {
  try {
    const host = new URL(urlStr).hostname.toLowerCase();
    return (
      host === "chatterbox" ||
      host.includes("chatterbox") ||
      host === "kokoro" ||
      host.includes("kokoro") ||
      host === "xtts" ||
      host.includes("miso")
    );
  } catch {
    return false;
  }
}

/** Prefer QWEN3_TTS_URL when the saved URL is loopback, legacy, or another engine. */
function resolveQwen3TtsUrl(
  saved: string | undefined,
  envUrl: string | undefined
): string | undefined {
  const s = sanitizeUrl(saved);
  const e = envUrl;
  if (e && s && isLoopbackHttpUrl(s)) return e;
  if (e && s && isLegacyQwen3DockerHostname(s)) return e;
  if (e && s && isNonQwen3TtsHost(s)) return e;
  return s || e;
}

function isLegacyMisoDockerHostname(urlStr: string): boolean {
  try {
    return new URL(urlStr).hostname.toLowerCase() === "miso-tts";
  } catch {
    return false;
  }
}

function resolveMisoTtsUrl(
  saved: string | undefined,
  envUrl: string | undefined
): string | undefined {
  const s = sanitizeUrl(saved);
  const e = envUrl;
  if (e && s && isLoopbackHttpUrl(s)) return e;
  if (e && s && isLegacyMisoDockerHostname(s)) return e;
  return s || e;
}

function resolveEngineTtsUrl(
  saved: string | undefined,
  envUrl: string | undefined
): string | undefined {
  const s = sanitizeUrl(saved);
  const e = envUrl;
  if (e && s && isLoopbackHttpUrl(s)) return e;
  return s || e;
}

// TTS tuning defaults from env (optional); prefer XTTS_* then KOKORO_*
const DEFAULT_TTS_RATE = clamp(
  parseNumberEnv("XTTS_RATE", parseNumberEnv("KOKORO_RATE", 0.95)),
  0.8,
  1.2
);

// XTTS default: ISO 639-1 (e.g. en, es, fr). Kokoro often uses "a" / "b".
const DEFAULT_TTS_LANG = process.env.KOKORO_LANG || "en-US";

const DEFAULT_TTS_PRESET: VoicePreset =
  ((process.env.XTTS_PRESET || process.env.KOKORO_PRESET) as VoicePreset) ||
  "neutral";

// Presets control rate only (since energy/variation are removed)
const VOICE_PRESETS: Record<VoicePreset, Pick<TTSConfig, "rate">> = {
  neutral: { rate: 0.95 },
  warm: { rate: 0.92 },
  energetic: { rate: 1.02 },
  calm: { rate: 0.88 },
};

// ───────────────────────────────────────────────
// Prompts
// ───────────────────────────────────────────────

export interface PromptConfig {
  systemPreamble: string;
  schemaHint: string;
  policyPrompt: string;
  voicePrompt: string;
  /** Custom greeting text for the welcome message when a caller dials in */
  greetingText: string;
}

export type SttMode = "whisper_http" | "disabled" | "http_wav_json" | "openai_whisper" | "deepgram";

export interface STTConfig {
  whisperUrl: string;
  mode?: SttMode;
  model?: string;
}

/** Portal-safe STT flags (no whisperUrl). */
export interface SafeSttPublicConfig {
  whisperEndpointConfigured: boolean;
}

const DEFAULT_SYSTEM_PREAMBLE = [
  "You're a friendly virtual receptionist answering phone calls for a local service business.",
  "Your job is to greet callers warmly, find out what they need, collect their contact info if helpful, and either schedule an appointment or connect them with the right person.",
].join(" ");

const DEFAULT_SCHEMA_HINT = `
You must respond ONLY with a single JSON object and no extra text.
Use this shape:

{
  "replyText": "string - what you say back to the caller",
  "actions": ["optional", "string", "flags"],
  "stage": "optional stage string: greeting|qualifying|scheduling|handoff|closed",
  "leadUpdates": {
    "optional": "fields to merge into the lead record"
  }
}

Keep replyText short and focused, like a real receptionist speaking on the phone.
`.trim();

const DEFAULT_POLICY_PROMPT = [
  "Never promise specific prices, discounts, or guarantees—offer to have someone follow up instead.",
  "Never ask for payment info or passwords.",
  "Don't give legal, medical, or safety advice.",
  "If you're unsure or the service isn't available, offer to take a message or transfer the call.",
].join(" ");

const DEFAULT_VOICE_PROMPT = [
  "Be friendly, confident, and calm.",
  "Keep your responses short and natural, like you're actually on the phone.",
  "Use the caller's name when you know it.",
].join(" ");

export interface SerializedLLMConfig {
  config: LLMRuntimeConfig;
  prompts: PromptConfig;
  stt: STTConfig;
  tts: TTSConfig;
}

export class LLMConfigStore {
  private config: LLMRuntimeConfig;
  private prompts: PromptConfig;
  private stt: STTConfig;
  private tts: TTSConfig;

  constructor(initial?: Partial<SerializedLLMConfig>) {
    const provider = defaultLlmProvider();

    this.config = initial?.config || {
      provider,
      localUrl: process.env.LOCAL_LLM_URL || DEFAULT_LOCAL_URL,
      openaiModel:
        process.env.OPENAI_MODEL ||
        (provider === "local" ? DEFAULT_ONPREM_MODEL : DEFAULT_OPENAI_MODEL),
      openaiApiKey: process.env.OPENAI_API_KEY,
    };

    this.prompts = {
      systemPreamble: DEFAULT_SYSTEM_PREAMBLE,
      schemaHint: DEFAULT_SCHEMA_HINT,
      policyPrompt: DEFAULT_POLICY_PROMPT,
      voicePrompt: DEFAULT_VOICE_PROMPT,
      greetingText: "",
      ...(initial?.prompts || {}),
    };
    // Ensure greetingText exists for configs loaded before this field was added
    if (this.prompts.greetingText === undefined) this.prompts.greetingText = "";

    this.stt = initial?.stt || {
      whisperUrl: DEFAULT_WHISPER_URL,
      mode: "whisper_http",
    };

    // TTS – XTTS/Kokoro config
    this.tts = initial?.tts || {
      xttsUrl: DEFAULT_TTS_URL,
      voiceId: DEFAULT_TTS_VOICE,
      language: DEFAULT_TTS_LANG,
      rate: DEFAULT_TTS_RATE,
      preset: DEFAULT_TTS_PRESET,
    };
  }

  // ── LLM runtime ──────────────────────────────

  get(): LLMRuntimeConfig {
    return this.config;
  }

  set(next: Partial<LLMRuntimeConfig>): LLMRuntimeConfig {
    const provider =
      next.provider ??
      this.config.provider ??
      defaultLlmProvider();

    const localUrl =
      next.localUrl ??
      this.config.localUrl ??
      process.env.LOCAL_LLM_URL ??
      DEFAULT_LOCAL_URL;

    const openaiModel =
      next.openaiModel ??
      this.config.openaiModel ??
      process.env.OPENAI_MODEL ??
      DEFAULT_OPENAI_MODEL;

    const openaiApiKey =
      typeof next.openaiApiKey === "string" && next.openaiApiKey.trim()
        ? next.openaiApiKey.trim()
        : this.config.openaiApiKey || process.env.OPENAI_API_KEY;

    if (typeof next.openaiApiKey === "string" && next.openaiApiKey.trim()) {
      process.env.OPENAI_API_KEY = next.openaiApiKey
        .trim()
        .replace(/[\r\n]/g, "");
    }
    if (typeof next.openaiModel === "string" && next.openaiModel.trim()) {
      process.env.OPENAI_MODEL = next.openaiModel
        .trim()
        .replace(/[\r\n]/g, "");
    }

    this.config = { provider, localUrl, openaiModel, openaiApiKey };
    return this.config;
  }

  // ── Prompts ──────────────────────────────────

  getPrompts(): PromptConfig {
    return this.prompts;
  }

  setPrompts(next: Partial<PromptConfig>): PromptConfig {
    this.prompts = {
      systemPreamble:
        next.systemPreamble?.trim() || this.prompts.systemPreamble,
      schemaHint: next.schemaHint?.trim() || this.prompts.schemaHint,
      policyPrompt: next.policyPrompt?.trim() || this.prompts.policyPrompt,
      voicePrompt: next.voicePrompt?.trim() || this.prompts.voicePrompt,
      greetingText: next.greetingText !== undefined
        ? next.greetingText.trim()
        : this.prompts.greetingText,
    };
    return this.prompts;
  }

  getSafeConfig(): Omit<LLMRuntimeConfig, "openaiApiKey" | "localUrl"> & {
    hasOpenAIApiKey: boolean;
    localLlmEndpointConfigured: boolean;
  } {
    return {
      provider: this.config.provider,
      openaiModel: this.config.openaiModel,
      hasOpenAIApiKey:
        hasUsableApiKey(this.config.openaiApiKey) || hasUsableApiKey(process.env.OPENAI_API_KEY),
      localLlmEndpointConfigured: Boolean(
        (this.config.localUrl || process.env.LOCAL_LLM_URL || "").trim().length
      ),
    };
  }

  // ── STT / TTS ─────────────────────────────────

  getSttConfig(): STTConfig {
    const envWhisperUrl = getEnvWhisperUrl();
    return {
      whisperUrl: envWhisperUrl || this.stt.whisperUrl || DEFAULT_WHISPER_URL,
      mode: this.stt.mode || "whisper_http",
      model: this.stt.model,
    };
  }

  setSttConfig(next: Partial<STTConfig>): STTConfig {
    this.stt = {
      ...this.getSttConfig(),
      ...next,
    };
    return this.getSttConfig();
  }

  getSafeSttPublic(): SafeSttPublicConfig {
    const w = this.getSttConfig().whisperUrl?.trim() || "";
    return { whisperEndpointConfigured: w.length > 0 };
  }

  getTtsConfig(): TTSConfig {
    const base = this.tts || ({} as TTSConfig);
    const preset = base.preset || DEFAULT_TTS_PRESET;
    const tuned = VOICE_PRESETS[preset] || VOICE_PRESETS.neutral;
    const envTtsUrl = getEnvTtsUrl();

    const rateSource =
      typeof base.rate === "number" && Number.isFinite(base.rate) ? base.rate : tuned.rate;
    const vi = truncateTtsField(base.voiceId || DEFAULT_TTS_VOICE, 100) || DEFAULT_TTS_VOICE;
    const lang = truncateTtsField(base.language || DEFAULT_TTS_LANG, 32) || DEFAULT_TTS_LANG;
    const qInstr = base.qwen3Instruct
      ? truncateTtsField(String(base.qwen3Instruct), 500) || undefined
      : undefined;

    const config: TTSConfig = {
      xttsUrl: envTtsUrl || base.xttsUrl || DEFAULT_TTS_URL,
      voiceId: coerceKokoroVoiceId(vi),
      language: coerceKokoroLanguage(lang, vi),
      // If a preset exists, it can provide a default rate — but explicit rate wins.
      rate: clamp(rateSource, 0.8, 1.2),
      preset,
      ttsMode: "kokoro_http",
      coquiXttsUrl: base.coquiXttsUrl,
      kokoroUrl:
        (base.kokoroUrl && /kokoro/i.test(base.kokoroUrl) ? base.kokoroUrl : "") ||
        sanitizeUrl(process.env.KOKORO_URL) ||
        DEFAULT_TTS_URL,
      chatterboxUrl: resolveChatterboxUrl(base.chatterboxUrl, getEnvChatterboxUrl()),
      qwen3TtsUrl: resolveQwen3TtsUrl(base.qwen3TtsUrl, getEnvQwen3TtsUrl()),
      misoTtsUrl: resolveMisoTtsUrl(base.misoTtsUrl, getEnvMisoTtsUrl()),
      magpieTtsUrl: resolveEngineTtsUrl(base.magpieTtsUrl, getEnvMagpieTtsUrl()),
      meloTtsUrl: resolveEngineTtsUrl(base.meloTtsUrl, getEnvMeloTtsUrl()),
      qwen3Instruct: qInstr,
      qwen3DoSample: base.qwen3DoSample,
      qwen3Temperature: clampOptNum(base.qwen3Temperature, 0, 2),
      qwen3TopP: clampOptNum(base.qwen3TopP, 0, 1),
      qwen3TopK: clampOptInt(base.qwen3TopK, 0, 1_000_000),
      qwen3RepetitionPenalty: clampOptNum(base.qwen3RepetitionPenalty, 0.5, 2),
      qwen3MaxNewTokens: clampOptInt(base.qwen3MaxNewTokens, 1, 32768),
      qwen3NonStreamingMode: base.qwen3NonStreamingMode,
      qwen3SubtalkerDoSample: base.qwen3SubtalkerDoSample,
      qwen3SubtalkerTopK: clampOptInt(base.qwen3SubtalkerTopK, 0, 1_000_000),
      qwen3SubtalkerTopP: clampOptNum(base.qwen3SubtalkerTopP, 0, 1),
      qwen3SubtalkerTemperature: clampOptNum(base.qwen3SubtalkerTemperature, 0, 2),
      qwen3Streaming: base.qwen3Streaming === true,
      misoMaxAudioLengthMs: clampOptInt(base.misoMaxAudioLengthMs, 500, 90_000),
      misoTemperature: clampOptNum(base.misoTemperature, 0, 2),
      misoTopK: clampOptInt(base.misoTopK, 1, 1000),
      magpieTemperature: clampOptNum(base.magpieTemperature, 0.05, 1.5),
      magpieCfgScale: clampOptNum(base.magpieCfgScale, 0.5, 5),
      magpieTopK: clampOptInt(base.magpieTopK, 1, 200),
      magpieUseCfg: base.magpieUseCfg,
      magpieApplyTn: base.magpieApplyTn,
      meloSdpRatio: clampOptNum(base.meloSdpRatio, 0, 1),
      meloNoiseScale: clampOptNum(base.meloNoiseScale, 0, 2),
      meloNoiseScaleW: clampOptNum(base.meloNoiseScaleW, 0, 2),
      coquiTemperature: clampOptNum(base.coquiTemperature, 0, 2),
      coquiLengthPenalty: clampOptNum(base.coquiLengthPenalty, -10, 10),
      coquiRepetitionPenalty: clampOptNum(base.coquiRepetitionPenalty, 0.5, 2),
      coquiTopK: clampOptInt(base.coquiTopK, 0, 1_000_000),
      coquiTopP: clampOptNum(base.coquiTopP, 0, 1),
      coquiSpeed: clampOptNum(base.coquiSpeed, 0.25, 4),
      coquiSplitSentences: base.coquiSplitSentences,
      chatterboxVariant: base.chatterboxVariant ?? "turbo",
      clonedVoice: base.clonedVoice,
      defaultVoiceMode: base.defaultVoiceMode || "preset",
      cloudTtsModel: base.cloudTtsModel,
    };

    return config;
  }

  setTtsConfig(next: Partial<TTSConfig>): TTSConfig {
    const current = this.getTtsConfig();

    const merged: TTSConfig = {
      ...current,
      ...next,
      preset: (next.preset as VoicePreset) ?? current.preset,
      rate: clamp(
        typeof next.rate === "number" && Number.isFinite(next.rate) ? next.rate : current.rate,
        0.8,
        1.2
      ),
      // Ensure language never becomes empty
      language:
        typeof next.language === "string" && next.language.trim().length
          ? truncateTtsField(next.language, 32)
          : current.language,
      voiceId: coerceKokoroVoiceId(
        typeof next.voiceId === "string" && next.voiceId.trim().length
          ? truncateTtsField(next.voiceId, 100)
          : current.voiceId
      ),
      xttsUrl:
        typeof next.xttsUrl === "string" && next.xttsUrl.trim().length
          ? next.xttsUrl.trim()
          : current.xttsUrl,
      // Extended fields for voice cloning
      ttsMode: "kokoro_http",
      coquiXttsUrl:
        typeof next.coquiXttsUrl === "string" && next.coquiXttsUrl.trim().length
          ? next.coquiXttsUrl.trim()
          : next.coquiXttsUrl === undefined
          ? current.coquiXttsUrl
          : undefined,
      kokoroUrl:
        typeof next.kokoroUrl === "string" && next.kokoroUrl.trim().length
          ? next.kokoroUrl.trim()
          : next.kokoroUrl === undefined
          ? current.kokoroUrl
          : undefined,
      chatterboxUrl:
        typeof next.chatterboxUrl === "string" && next.chatterboxUrl.trim().length
          ? next.chatterboxUrl.trim()
          : next.chatterboxUrl === undefined
          ? current.chatterboxUrl
          : undefined,
      qwen3TtsUrl:
        typeof next.qwen3TtsUrl === "string" && next.qwen3TtsUrl.trim().length
          ? next.qwen3TtsUrl.trim()
          : next.qwen3TtsUrl === undefined
          ? current.qwen3TtsUrl
          : undefined,
      misoTtsUrl:
        typeof next.misoTtsUrl === "string" && next.misoTtsUrl.trim().length
          ? next.misoTtsUrl.trim()
          : next.misoTtsUrl === undefined
          ? current.misoTtsUrl
          : undefined,
      magpieTtsUrl:
        typeof next.magpieTtsUrl === "string" && next.magpieTtsUrl.trim().length
          ? next.magpieTtsUrl.trim()
          : next.magpieTtsUrl === undefined
          ? current.magpieTtsUrl
          : undefined,
      meloTtsUrl:
        typeof next.meloTtsUrl === "string" && next.meloTtsUrl.trim().length
          ? next.meloTtsUrl.trim()
          : next.meloTtsUrl === undefined
          ? current.meloTtsUrl
          : undefined,
      qwen3Instruct:
        next.qwen3Instruct !== undefined
          ? next.qwen3Instruct
            ? truncateTtsField(String(next.qwen3Instruct), 500) || undefined
            : undefined
          : current.qwen3Instruct,
      qwen3DoSample: next.qwen3DoSample !== undefined ? next.qwen3DoSample : current.qwen3DoSample,
      qwen3Temperature: mergeBoundedNum(next.qwen3Temperature, current.qwen3Temperature, 0, 2),
      qwen3TopP: mergeBoundedNum(next.qwen3TopP, current.qwen3TopP, 0, 1),
      qwen3TopK: mergeBoundedInt(next.qwen3TopK, current.qwen3TopK, 0, 1_000_000),
      qwen3RepetitionPenalty: mergeBoundedNum(
        next.qwen3RepetitionPenalty,
        current.qwen3RepetitionPenalty,
        0.5,
        2
      ),
      qwen3MaxNewTokens: mergeBoundedInt(next.qwen3MaxNewTokens, current.qwen3MaxNewTokens, 1, 32768),
      qwen3NonStreamingMode:
        next.qwen3NonStreamingMode !== undefined ? next.qwen3NonStreamingMode : current.qwen3NonStreamingMode,
      qwen3SubtalkerDoSample:
        next.qwen3SubtalkerDoSample !== undefined ? next.qwen3SubtalkerDoSample : current.qwen3SubtalkerDoSample,
      qwen3SubtalkerTopK: mergeBoundedInt(next.qwen3SubtalkerTopK, current.qwen3SubtalkerTopK, 0, 1_000_000),
      qwen3SubtalkerTopP: mergeBoundedNum(next.qwen3SubtalkerTopP, current.qwen3SubtalkerTopP, 0, 1),
      qwen3SubtalkerTemperature: mergeBoundedNum(
        next.qwen3SubtalkerTemperature,
        current.qwen3SubtalkerTemperature,
        0,
        2
      ),
      qwen3Streaming: next.qwen3Streaming !== undefined ? next.qwen3Streaming : current.qwen3Streaming,
      misoMaxAudioLengthMs: mergeBoundedInt(next.misoMaxAudioLengthMs, current.misoMaxAudioLengthMs, 500, 90_000),
      misoTemperature: mergeBoundedNum(next.misoTemperature, current.misoTemperature, 0, 2),
      misoTopK: mergeBoundedInt(next.misoTopK, current.misoTopK, 1, 1000),
      magpieTemperature: mergeBoundedNum(next.magpieTemperature, current.magpieTemperature, 0.05, 1.5),
      magpieCfgScale: mergeBoundedNum(next.magpieCfgScale, current.magpieCfgScale, 0.5, 5),
      magpieTopK: mergeBoundedInt(next.magpieTopK, current.magpieTopK, 1, 200),
      magpieUseCfg: next.magpieUseCfg !== undefined ? next.magpieUseCfg : current.magpieUseCfg,
      magpieApplyTn: next.magpieApplyTn !== undefined ? next.magpieApplyTn : current.magpieApplyTn,
      meloSdpRatio: mergeBoundedNum(next.meloSdpRatio, current.meloSdpRatio, 0, 1),
      meloNoiseScale: mergeBoundedNum(next.meloNoiseScale, current.meloNoiseScale, 0, 2),
      meloNoiseScaleW: mergeBoundedNum(next.meloNoiseScaleW, current.meloNoiseScaleW, 0, 2),
      coquiTemperature: mergeBoundedNum(next.coquiTemperature, current.coquiTemperature, 0, 2),
      coquiLengthPenalty: mergeBoundedNum(next.coquiLengthPenalty, current.coquiLengthPenalty, -10, 10),
      coquiRepetitionPenalty: mergeBoundedNum(
        next.coquiRepetitionPenalty,
        current.coquiRepetitionPenalty,
        0.5,
        2
      ),
      coquiTopK: mergeBoundedInt(next.coquiTopK, current.coquiTopK, 0, 1_000_000),
      coquiTopP: mergeBoundedNum(next.coquiTopP, current.coquiTopP, 0, 1),
      coquiSpeed: mergeBoundedNum(next.coquiSpeed, current.coquiSpeed, 0.25, 4),
      coquiSplitSentences:
        next.coquiSplitSentences !== undefined ? next.coquiSplitSentences : current.coquiSplitSentences,
      chatterboxVariant: next.chatterboxVariant ?? current.chatterboxVariant,
      defaultVoiceMode: next.defaultVoiceMode ?? current.defaultVoiceMode,
      clonedVoice: next.clonedVoice !== undefined
        ? next.clonedVoice
        : current.clonedVoice,
      cloudTtsModel:
        typeof next.cloudTtsModel === "string" && next.cloudTtsModel.trim()
          ? next.cloudTtsModel.trim()
          : next.cloudTtsModel === undefined
            ? current.cloudTtsModel
            : undefined,
    };

    this.tts = merged;
    return this.getTtsConfig();
  }

  setTtsVoice(voiceId: string): TTSConfig {
    if (voiceId && voiceId.trim()) {
      this.tts = { ...this.getTtsConfig(), voiceId: voiceId.trim() };
    }
    return this.getTtsConfig();
  }

  setTtsPreset(preset: VoicePreset): TTSConfig {
    if (!VOICE_PRESETS[preset]) return this.getTtsConfig();
    const base = this.getTtsConfig();
    const tuned = VOICE_PRESETS[preset];

    // Apply preset rate (but keep voice/lang/url)
    this.tts = { ...base, ...tuned, preset };
    return this.getTtsConfig();
  }

  getSafeTtsConfig(): SafeTtsPublicConfig {
    const t = this.getTtsConfig();
    return {
      ttsMode: "kokoro_http",
      voiceId: coerceKokoroVoiceId(t.voiceId),
      language: t.language,
      rate: t.rate,
      preset: t.preset,
      chatterboxVariant: t.chatterboxVariant,
      defaultVoiceMode: t.defaultVoiceMode,
      xttsEndpointConfigured: Boolean((t.xttsUrl || "").trim()),
      kokoroEndpointConfigured: Boolean((t.kokoroUrl || "").trim()),
      coquiXttsEndpointConfigured: Boolean((t.coquiXttsUrl || "").trim()),
      chatterboxEndpointConfigured: Boolean((t.chatterboxUrl || "").trim()),
      qwen3EndpointConfigured: Boolean((t.qwen3TtsUrl || "").trim()),
      misoEndpointConfigured: Boolean((t.misoTtsUrl || "").trim()),
      magpieEndpointConfigured: Boolean((t.magpieTtsUrl || "").trim()),
      meloEndpointConfigured: Boolean((t.meloTtsUrl || "").trim()),
      openaiTtsConfigured: hasUsableApiKey(process.env.OPENAI_API_KEY),
      elevenlabsConfigured: hasUsableApiKey(process.env.ELEVENLABS_API_KEY),
      cloudTtsModel: t.cloudTtsModel,
      clonedVoiceReferenceConfigured: Boolean(t.clonedVoice?.speakerWavUrl?.trim()),
      clonedVoiceLabel: t.clonedVoice?.label,
      clonedVoice:
        t.clonedVoice?.label || t.clonedVoice?.speakerWavUrl
          ? {
              label: t.clonedVoice?.label,
              speakerWavConfigured: Boolean(t.clonedVoice?.speakerWavUrl?.trim()),
            }
          : undefined,
      qwen3Instruct: t.qwen3Instruct,
      qwen3DoSample: t.qwen3DoSample,
      qwen3Temperature: t.qwen3Temperature,
      qwen3TopP: t.qwen3TopP,
      qwen3TopK: t.qwen3TopK,
      qwen3RepetitionPenalty: t.qwen3RepetitionPenalty,
      qwen3MaxNewTokens: t.qwen3MaxNewTokens,
      qwen3NonStreamingMode: t.qwen3NonStreamingMode,
      qwen3SubtalkerDoSample: t.qwen3SubtalkerDoSample,
      qwen3SubtalkerTopK: t.qwen3SubtalkerTopK,
      qwen3SubtalkerTopP: t.qwen3SubtalkerTopP,
      qwen3SubtalkerTemperature: t.qwen3SubtalkerTemperature,
      qwen3Streaming: t.qwen3Streaming === true,
      misoMaxAudioLengthMs: t.misoMaxAudioLengthMs,
      misoTemperature: t.misoTemperature,
      misoTopK: t.misoTopK,
      magpieTemperature: t.magpieTemperature,
      magpieCfgScale: t.magpieCfgScale,
      magpieTopK: t.magpieTopK,
      magpieUseCfg: t.magpieUseCfg,
      magpieApplyTn: t.magpieApplyTn,
      meloSdpRatio: t.meloSdpRatio,
      meloNoiseScale: t.meloNoiseScale,
      meloNoiseScaleW: t.meloNoiseScaleW,
      coquiTemperature: t.coquiTemperature,
      coquiLengthPenalty: t.coquiLengthPenalty,
      coquiRepetitionPenalty: t.coquiRepetitionPenalty,
      coquiTopK: t.coquiTopK,
      coquiTopP: t.coquiTopP,
      coquiSpeed: t.coquiSpeed,
      coquiSplitSentences: t.coquiSplitSentences,
    };
  }

  serialize(): SerializedLLMConfig {
    return {
      config: { ...this.config, openaiApiKey: undefined },
      prompts: { ...this.prompts },
      stt: { ...this.stt },
      tts: { ...this.tts },
    };
  }

  hydrate(data: Partial<SerializedLLMConfig>): void {
    if (data.config) this.config = { ...this.config, ...data.config };
    if (data.prompts) this.prompts = { ...this.prompts, ...data.prompts };
    if (data.stt) this.stt = { ...this.stt, ...data.stt };
    if (data.tts) this.tts = { ...this.tts, ...data.tts };
  }
}
