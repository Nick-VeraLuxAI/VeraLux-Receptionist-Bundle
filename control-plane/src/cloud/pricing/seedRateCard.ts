import type { RateCardPrice } from "@veralux/shared";

const AS_OF = "2026-01-01T00:00:00.000Z";

function p(sku: string, unit: RateCardPrice["unit"], millicents: number, source = "seed"): RateCardPrice {
  return { sku, unit, millicents, currency: "USD", source, asOf: AS_OF };
}

/** Bootstrap list prices. Live feeds overwrite mapped SKUs after first refresh. */
export const SEED_RATE_CARD: RateCardPrice[] = [
  p("telnyx:inbound", "per_minute", 700, "telnyx_listed"),

  p("stt:whisper_http", "per_minute", 0, "onprem"),
  p("openai:whisper-1", "per_minute", 600, "litellm"),
  p("deepgram:nova-2", "per_minute", 430, "deepgram_listed"),

  p("platform:nemotron", "per_1m_input_tokens", 0, "onprem"),
  p("platform:nemotron", "per_1m_output_tokens", 0, "onprem"),
  p("openai:gpt-4o-mini", "per_1m_input_tokens", 15_000, "litellm"),
  p("openai:gpt-4o-mini", "per_1m_output_tokens", 60_000, "litellm"),
  p("openai:gpt-4o", "per_1m_input_tokens", 250_000, "litellm"),
  p("openai:gpt-4o", "per_1m_output_tokens", 1_000_000, "litellm"),
  p("openai:gpt-4.1-nano", "per_1m_input_tokens", 10_000, "litellm"),
  p("openai:gpt-4.1-nano", "per_1m_output_tokens", 40_000, "litellm"),
  p("openai:gpt-4.1-mini", "per_1m_input_tokens", 40_000, "litellm"),
  p("openai:gpt-4.1-mini", "per_1m_output_tokens", 160_000, "litellm"),
  p("openai:gpt-4.1", "per_1m_input_tokens", 200_000, "litellm"),
  p("openai:gpt-4.1", "per_1m_output_tokens", 800_000, "litellm"),
  p("openai:gpt-5-nano", "per_1m_input_tokens", 5_000, "litellm"),
  p("openai:gpt-5-nano", "per_1m_output_tokens", 40_000, "litellm"),
  p("openai:gpt-5-mini", "per_1m_input_tokens", 25_000, "litellm"),
  p("openai:gpt-5-mini", "per_1m_output_tokens", 200_000, "litellm"),
  p("openai:gpt-5", "per_1m_input_tokens", 125_000, "litellm"),
  p("openai:gpt-5", "per_1m_output_tokens", 1_000_000, "litellm"),
  p("openai:o4-mini", "per_1m_input_tokens", 110_000, "litellm"),
  p("openai:o4-mini", "per_1m_output_tokens", 440_000, "litellm"),
  p("anthropic:claude-haiku-4-5", "per_1m_input_tokens", 100_000, "litellm"),
  p("anthropic:claude-haiku-4-5", "per_1m_output_tokens", 500_000, "litellm"),
  p("anthropic:claude-sonnet-4-5", "per_1m_input_tokens", 300_000, "litellm"),
  p("anthropic:claude-sonnet-4-5", "per_1m_output_tokens", 1_500_000, "litellm"),
  p("anthropic:claude-opus-4-6", "per_1m_input_tokens", 500_000, "litellm"),
  p("anthropic:claude-opus-4-6", "per_1m_output_tokens", 2_500_000, "litellm"),
  p("google:gemini-2.5-flash-lite", "per_1m_input_tokens", 10_000, "litellm"),
  p("google:gemini-2.5-flash-lite", "per_1m_output_tokens", 40_000, "litellm"),
  p("google:gemini-2.5-flash", "per_1m_input_tokens", 30_000, "litellm"),
  p("google:gemini-2.5-flash", "per_1m_output_tokens", 250_000, "litellm"),
  p("google:gemini-2.5-pro", "per_1m_input_tokens", 125_000, "litellm"),
  p("google:gemini-2.5-pro", "per_1m_output_tokens", 1_000_000, "litellm"),
  p("groq:gpt-oss-20b", "per_1m_input_tokens", 7_500, "groq_listed"),
  p("groq:gpt-oss-20b", "per_1m_output_tokens", 30_000, "groq_listed"),
  p("groq:gpt-oss-120b", "per_1m_input_tokens", 15_000, "groq_listed"),
  p("groq:gpt-oss-120b", "per_1m_output_tokens", 60_000, "groq_listed"),
  p("xai:grok-3-mini", "per_1m_input_tokens", 125_000, "litellm"),
  p("xai:grok-3-mini", "per_1m_output_tokens", 250_000, "litellm"),
  p("xai:grok-3", "per_1m_input_tokens", 125_000, "litellm"),
  p("xai:grok-3", "per_1m_output_tokens", 250_000, "litellm"),
  p("xai:grok-4", "per_1m_input_tokens", 125_000, "litellm"),
  p("xai:grok-4", "per_1m_output_tokens", 250_000, "litellm"),

  p("tts:kokoro_http", "per_1k_chars", 0, "onprem"),
  p("tts:coqui_xtts", "per_1k_chars", 0, "onprem"),
  p("tts:chatterbox_http", "per_1k_chars", 0, "onprem"),
  p("tts:qwen3_tts_http", "per_1k_chars", 0, "onprem"),
  p("tts:miso_tts_http", "per_1k_chars", 0, "onprem"),
  p("tts:magpie_tts_http", "per_1k_chars", 0, "onprem"),
  p("tts:melo_tts_http", "per_1k_chars", 0, "onprem"),
  p("openai:tts-1", "per_1k_chars", 1_500, "litellm"),
  p("elevenlabs:flash", "per_1k_chars", 5_000, "elevenlabs_listed"),

  p("onprem:hub", "per_month", 0, "onprem"),
  // monthly host bundle in millicents of a cent ($28 = 2_800_000)
  p("render:starter", "per_month", 2_800_000, "render_listed"),
  p("render:standard", "per_month", 13_000_000, "render_listed"),
  p("render:pro", "per_month", 40_000_000, "render_listed"),
  p("railway:hobby", "per_month", 2_000_000, "railway_listed"),
  p("railway:pro", "per_month", 5_000_000, "railway_listed"),
  p("aws:fargate_small", "per_month", 3_000_000, "aws_listed"),
  p("aws:fargate_medium", "per_month", 8_000_000, "aws_listed"),
];
