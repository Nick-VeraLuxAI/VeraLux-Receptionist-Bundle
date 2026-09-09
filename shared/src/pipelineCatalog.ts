/** Pipeline component catalog — slots, SKUs, and default talk-model assumptions. */

export const PIPELINE_SLOTS = ["host", "telco", "stt", "llm", "tts"] as const;
export type PipelineSlot = (typeof PIPELINE_SLOTS)[number];

export const PIPELINE_PRICE_UNITS = [
  "per_minute",
  "per_1m_input_tokens",
  "per_1m_output_tokens",
  "per_1k_chars",
  "per_month",
] as const;
export type PipelinePriceUnit = (typeof PIPELINE_PRICE_UNITS)[number];

export type PipelineComponent = {
  sku: string;
  slot: PipelineSlot;
  provider: string;
  label: string;
  hostOk: boolean;
  onpremOk: boolean;
  /** Paid host SKUs only — free tiers are forbidden for voice. */
  paidHostRequired?: boolean;
  defaultLlmInputTokensPerMin?: number;
  defaultLlmOutputTokensPerMin?: number;
  defaultTtsCharsPerMin?: number;
  sttMode?: string;
  ttsMode?: string;
  llmProvider?: string;
  llmModel?: string;
  /** Short chip label on provider cards. */
  shortLabel?: string;
  hostProvider?: "render" | "railway" | "aws";
  hostSize?: string;
};

export const ONPREM_HUB_SKU = "onprem:hub";

export function isPaidCloudHost(c: PipelineComponent | undefined): boolean {
  return Boolean(c?.slot === "host" && c.paidHostRequired && c.hostProvider && c.hostSize);
}

export const DEFAULT_ESTIMATE_ASSUMPTIONS = {
  assumedMonthlyMinutes: 500,
  callerTalkRatio: 0.55,
  assistantTalkRatio: 0.45,
  llmInputTokensPerMin: 1200,
  llmOutputTokensPerMin: 400,
  ttsCharsPerMin: 750,
  retailMarginBps: 4000,
  /** Typical receptionist reply length used for latency, not cost. */
  replyTokensPerTurn: 80,
} as const;

export const PIPELINE_COMPONENTS: PipelineComponent[] = [
  { sku: ONPREM_HUB_SKU, slot: "host", provider: "onprem", label: "On-prem hub", hostOk: false, onpremOk: true, shortLabel: "This hub" },
  { sku: "render:starter", slot: "host", provider: "render", label: "Render Starter", hostOk: true, onpremOk: false, paidHostRequired: true, hostProvider: "render", hostSize: "starter" },
  { sku: "render:standard", slot: "host", provider: "render", label: "Render Standard", hostOk: true, onpremOk: false, paidHostRequired: true, hostProvider: "render", hostSize: "standard" },
  { sku: "render:pro", slot: "host", provider: "render", label: "Render Pro", hostOk: true, onpremOk: false, paidHostRequired: true, hostProvider: "render", hostSize: "pro" },
  { sku: "railway:hobby", slot: "host", provider: "railway", label: "Railway Hobby", hostOk: true, onpremOk: false, paidHostRequired: true, hostProvider: "railway", hostSize: "hobby" },
  { sku: "railway:pro", slot: "host", provider: "railway", label: "Railway Pro", hostOk: true, onpremOk: false, paidHostRequired: true, hostProvider: "railway", hostSize: "pro" },
  { sku: "aws:fargate_small", slot: "host", provider: "aws", label: "AWS Fargate small", hostOk: true, onpremOk: false, paidHostRequired: true, hostProvider: "aws", hostSize: "fargate_small" },
  { sku: "aws:fargate_medium", slot: "host", provider: "aws", label: "AWS Fargate medium", hostOk: true, onpremOk: false, paidHostRequired: true, hostProvider: "aws", hostSize: "fargate_medium" },

  { sku: "telnyx:inbound", slot: "telco", provider: "telnyx", label: "Telnyx inbound PSTN", hostOk: true, onpremOk: true },

  { sku: "stt:whisper_http", slot: "stt", provider: "whisper", label: "Whisper HTTP (on-prem)", hostOk: false, onpremOk: true, sttMode: "whisper_http" },
  { sku: "openai:whisper-1", slot: "stt", provider: "openai", label: "OpenAI Whisper", hostOk: true, onpremOk: true, sttMode: "openai_whisper" },
  { sku: "deepgram:nova-2", slot: "stt", provider: "deepgram", label: "Deepgram Nova-2", hostOk: true, onpremOk: true, sttMode: "deepgram" },

  { sku: "platform:nemotron", slot: "llm", provider: "platform", label: "On-prem Qwen 3.5 27B", hostOk: false, onpremOk: true, llmProvider: "platform", llmModel: "Qwen3.5-27B-GPTQ-Int4", shortLabel: "3.5 27B" },

  { sku: "openai:gpt-4o-mini", slot: "llm", provider: "openai", label: "OpenAI GPT-4o mini", hostOk: true, onpremOk: true, llmProvider: "openai", llmModel: "gpt-4o-mini", shortLabel: "4o mini" },
  { sku: "openai:gpt-4o", slot: "llm", provider: "openai", label: "OpenAI GPT-4o", hostOk: true, onpremOk: true, llmProvider: "openai", llmModel: "gpt-4o", shortLabel: "4o" },
  { sku: "openai:gpt-4.1-nano", slot: "llm", provider: "openai", label: "OpenAI GPT-4.1 nano", hostOk: true, onpremOk: true, llmProvider: "openai", llmModel: "gpt-4.1-nano", shortLabel: "4.1 nano" },
  { sku: "openai:gpt-4.1-mini", slot: "llm", provider: "openai", label: "OpenAI GPT-4.1 mini", hostOk: true, onpremOk: true, llmProvider: "openai", llmModel: "gpt-4.1-mini", shortLabel: "4.1 mini" },
  { sku: "openai:gpt-4.1", slot: "llm", provider: "openai", label: "OpenAI GPT-4.1", hostOk: true, onpremOk: true, llmProvider: "openai", llmModel: "gpt-4.1", shortLabel: "4.1" },
  { sku: "openai:gpt-5-nano", slot: "llm", provider: "openai", label: "OpenAI GPT-5 nano", hostOk: true, onpremOk: true, llmProvider: "openai", llmModel: "gpt-5-nano", shortLabel: "5 nano" },
  { sku: "openai:gpt-5-mini", slot: "llm", provider: "openai", label: "OpenAI GPT-5 mini", hostOk: true, onpremOk: true, llmProvider: "openai", llmModel: "gpt-5-mini", shortLabel: "5 mini" },
  { sku: "openai:gpt-5", slot: "llm", provider: "openai", label: "OpenAI GPT-5", hostOk: true, onpremOk: true, llmProvider: "openai", llmModel: "gpt-5", shortLabel: "5" },
  { sku: "openai:o4-mini", slot: "llm", provider: "openai", label: "OpenAI o4-mini", hostOk: true, onpremOk: true, llmProvider: "openai", llmModel: "o4-mini", shortLabel: "o4-mini" },

  { sku: "anthropic:claude-haiku-4-5", slot: "llm", provider: "anthropic", label: "Anthropic Claude Haiku 4.5", hostOk: true, onpremOk: true, llmProvider: "anthropic", llmModel: "claude-haiku-4-5", shortLabel: "Haiku 4.5" },
  { sku: "anthropic:claude-sonnet-4-5", slot: "llm", provider: "anthropic", label: "Anthropic Claude Sonnet 4.5", hostOk: true, onpremOk: true, llmProvider: "anthropic", llmModel: "claude-sonnet-4-5", shortLabel: "Sonnet 4.5" },
  { sku: "anthropic:claude-opus-4-6", slot: "llm", provider: "anthropic", label: "Anthropic Claude Opus 4.6", hostOk: true, onpremOk: true, llmProvider: "anthropic", llmModel: "claude-opus-4-6", shortLabel: "Opus 4.6" },

  { sku: "google:gemini-2.5-flash-lite", slot: "llm", provider: "google", label: "Google Gemini 2.5 Flash Lite", hostOk: true, onpremOk: true, llmProvider: "google", llmModel: "gemini-2.5-flash-lite", shortLabel: "2.5 Flash Lite" },
  { sku: "google:gemini-2.5-flash", slot: "llm", provider: "google", label: "Google Gemini 2.5 Flash", hostOk: true, onpremOk: true, llmProvider: "google", llmModel: "gemini-2.5-flash", shortLabel: "2.5 Flash" },
  { sku: "google:gemini-2.5-pro", slot: "llm", provider: "google", label: "Google Gemini 2.5 Pro", hostOk: true, onpremOk: true, llmProvider: "google", llmModel: "gemini-2.5-pro", shortLabel: "2.5 Pro" },

  { sku: "groq:gpt-oss-20b", slot: "llm", provider: "groq", label: "Groq GPT-OSS 20B", hostOk: true, onpremOk: true, llmProvider: "groq", llmModel: "openai/gpt-oss-20b", shortLabel: "GPT-OSS 20B" },
  { sku: "groq:gpt-oss-120b", slot: "llm", provider: "groq", label: "Groq GPT-OSS 120B", hostOk: true, onpremOk: true, llmProvider: "groq", llmModel: "openai/gpt-oss-120b", shortLabel: "GPT-OSS 120B" },

  { sku: "xai:grok-3-mini", slot: "llm", provider: "xai", label: "xAI Grok 3 mini", hostOk: true, onpremOk: true, llmProvider: "xai", llmModel: "grok-3-mini", shortLabel: "Grok 3 mini" },
  { sku: "xai:grok-3", slot: "llm", provider: "xai", label: "xAI Grok 3", hostOk: true, onpremOk: true, llmProvider: "xai", llmModel: "grok-3", shortLabel: "Grok 3" },
  { sku: "xai:grok-4", slot: "llm", provider: "xai", label: "xAI Grok 4", hostOk: true, onpremOk: true, llmProvider: "xai", llmModel: "grok-4", shortLabel: "Grok 4" },

  { sku: "tts:kokoro_http", slot: "tts", provider: "kokoro", label: "Kokoro (on-prem)", hostOk: false, onpremOk: true, ttsMode: "kokoro_http", defaultTtsCharsPerMin: 750 },
  { sku: "tts:coqui_xtts", slot: "tts", provider: "coqui", label: "Coqui XTTS (on-prem)", hostOk: false, onpremOk: true, ttsMode: "coqui_xtts", defaultTtsCharsPerMin: 750 },
  { sku: "tts:chatterbox_http", slot: "tts", provider: "chatterbox", label: "Chatterbox (on-prem)", hostOk: false, onpremOk: true, ttsMode: "chatterbox_http", defaultTtsCharsPerMin: 750 },
  { sku: "tts:qwen3_tts_http", slot: "tts", provider: "qwen3", label: "Qwen3 TTS (on-prem)", hostOk: false, onpremOk: true, ttsMode: "qwen3_tts_http", defaultTtsCharsPerMin: 750 },
  { sku: "tts:miso_tts_http", slot: "tts", provider: "miso", label: "Miso TTS (on-prem)", hostOk: false, onpremOk: true, ttsMode: "miso_tts_http", defaultTtsCharsPerMin: 750 },
  { sku: "tts:magpie_tts_http", slot: "tts", provider: "magpie", label: "NVIDIA Magpie (on-prem)", hostOk: false, onpremOk: true, ttsMode: "magpie_tts_http", defaultTtsCharsPerMin: 750 },
  { sku: "tts:melo_tts_http", slot: "tts", provider: "melo", label: "MeloTTS (on-prem)", hostOk: false, onpremOk: true, ttsMode: "melo_tts_http", defaultTtsCharsPerMin: 750 },
  { sku: "openai:tts-1", slot: "tts", provider: "openai", label: "OpenAI TTS", hostOk: true, onpremOk: true, ttsMode: "openai_tts", defaultTtsCharsPerMin: 750 },
  { sku: "elevenlabs:flash", slot: "tts", provider: "elevenlabs", label: "ElevenLabs Flash", hostOk: true, onpremOk: true, ttsMode: "elevenlabs", defaultTtsCharsPerMin: 750 },
];

export const KOKORO_TTS_SKU = "tts:kokoro_http";

/** Kokoro is the only on-prem TTS SKU operators may pick. Cloud TTS SKUs stay selectable. */
export function isSelectablePipelineComponent(c: PipelineComponent): boolean {
  if (c.slot !== "tts") return true;
  if (c.hostOk) return true;
  return c.sku === KOKORO_TTS_SKU;
}

export const PIPELINE_COMPONENTS_SELECTABLE = PIPELINE_COMPONENTS.filter(isSelectablePipelineComponent);

export const PIPELINE_SKU_BY_ID = Object.fromEntries(PIPELINE_COMPONENTS.map((c) => [c.sku, c])) as Record<
  string,
  PipelineComponent
>;

export function componentBySku(sku: string): PipelineComponent | undefined {
  return PIPELINE_SKU_BY_ID[sku];
}

export function componentsForSlot(slot: PipelineSlot): PipelineComponent[] {
  return PIPELINE_COMPONENTS.filter((c) => c.slot === slot);
}
