import {
  DEFAULT_ESTIMATE_ASSUMPTIONS,
  PIPELINE_SKU_BY_ID,
  type PipelinePriceUnit,
  type PipelineSlot,
} from "./pipelineCatalog";

/** 1 millicent = 1/1000 of a US cent. */
export type RateCardPrice = {
  sku: string;
  unit: PipelinePriceUnit;
  millicents: number;
  currency: "USD";
  source: string;
  asOf: string;
  stale?: boolean;
  overridden?: boolean;
};

export type PipelineSelection = {
  hostSku: string;
  telcoSku?: string;
  sttSku: string;
  llmSku: string;
  ttsSku: string;
};

export type PipelineEstimateAssumptions = {
  assumedMonthlyMinutes: number;
  callerTalkRatio: number;
  assistantTalkRatio: number;
  llmInputTokensPerMin: number;
  llmOutputTokensPerMin: number;
  ttsCharsPerMin: number;
  retailMarginBps: number;
  replyTokensPerTurn: number;
};

export type EstimateLineItem = {
  slot: PipelineSlot;
  sku: string;
  label: string;
  centsPerMinute: number;
  source: string;
  asOf: string;
  stale: boolean;
  overridden: boolean;
};

export type PipelineLatency = {
  disclaimer: "estimate_not_sla";
  /** End of caller speech → first assistant audio. */
  firstAudioMs: number;
  /** STT + LLM generation of a full reply (not including speaking it). */
  fullReplyMs: number;
  sttMs: number;
  llmMs: number;
  ttsMs: number;
  overheadMs: number;
  replyTokens: number;
};

export type PipelineEstimate = {
  disclaimer: "estimate_not_invoice";
  rateCardAsOf: string | null;
  assumptions: PipelineEstimateAssumptions;
  lineItems: EstimateLineItem[];
  cogsPerMinuteCents: number;
  retailPerMinuteCents: number;
  monthlyCogsCents: number;
  monthlyRetailCents: number;
  retailMarginBps: number;
  latency: PipelineLatency;
};

export function normalizeAssumptions(
  raw?: Partial<PipelineEstimateAssumptions> | null,
): PipelineEstimateAssumptions {
  const clamp = (n: unknown, min: number, max: number, fallback: number) => {
    const v = typeof n === "number" && Number.isFinite(n) ? n : fallback;
    return Math.min(max, Math.max(min, v));
  };
  return {
    assumedMonthlyMinutes: clamp(raw?.assumedMonthlyMinutes, 1, 1_000_000, DEFAULT_ESTIMATE_ASSUMPTIONS.assumedMonthlyMinutes),
    callerTalkRatio: clamp(raw?.callerTalkRatio, 0, 1, DEFAULT_ESTIMATE_ASSUMPTIONS.callerTalkRatio),
    assistantTalkRatio: clamp(raw?.assistantTalkRatio, 0, 1, DEFAULT_ESTIMATE_ASSUMPTIONS.assistantTalkRatio),
    llmInputTokensPerMin: clamp(raw?.llmInputTokensPerMin, 0, 1_000_000, DEFAULT_ESTIMATE_ASSUMPTIONS.llmInputTokensPerMin),
    llmOutputTokensPerMin: clamp(raw?.llmOutputTokensPerMin, 0, 1_000_000, DEFAULT_ESTIMATE_ASSUMPTIONS.llmOutputTokensPerMin),
    ttsCharsPerMin: clamp(raw?.ttsCharsPerMin, 0, 1_000_000, DEFAULT_ESTIMATE_ASSUMPTIONS.ttsCharsPerMin),
    retailMarginBps: Math.round(clamp(raw?.retailMarginBps, 0, 100_000, DEFAULT_ESTIMATE_ASSUMPTIONS.retailMarginBps)),
    replyTokensPerTurn: Math.round(clamp(raw?.replyTokensPerTurn, 10, 2_000, DEFAULT_ESTIMATE_ASSUMPTIONS.replyTokensPerTurn)),
  };
}

export function millicentsToCents(millicents: number): number {
  return millicents / 1000;
}

type LatencyBits = {
  sttMs?: number;
  ttftMs?: number;
  tokensPerSec?: number;
  ttsFirstByteMs?: number;
};

/** Typical published/list speeds. Not a guarantee. */
const LATENCY_BY_SKU: Record<string, LatencyBits> = {
  "stt:whisper_http": { sttMs: 350 },
  "openai:whisper-1": { sttMs: 900 },
  "deepgram:nova-2": { sttMs: 280 },
  "platform:nemotron": { ttftMs: 200, tokensPerSec: 40 },
  "openai:gpt-4o-mini": { ttftMs: 280, tokensPerSec: 90 },
  "openai:gpt-4o": { ttftMs: 380, tokensPerSec: 70 },
  "openai:gpt-4.1-nano": { ttftMs: 250, tokensPerSec: 110 },
  "openai:gpt-4.1-mini": { ttftMs: 300, tokensPerSec: 90 },
  "openai:gpt-4.1": { ttftMs: 380, tokensPerSec: 70 },
  "openai:gpt-5-nano": { ttftMs: 300, tokensPerSec: 100 },
  "openai:gpt-5-mini": { ttftMs: 350, tokensPerSec: 80 },
  "openai:gpt-5": { ttftMs: 450, tokensPerSec: 60 },
  "openai:o4-mini": { ttftMs: 900, tokensPerSec: 50 },
  "anthropic:claude-haiku-4-5": { ttftMs: 250, tokensPerSec: 110 },
  "anthropic:claude-sonnet-4-5": { ttftMs: 400, tokensPerSec: 65 },
  "anthropic:claude-opus-4-6": { ttftMs: 700, tokensPerSec: 40 },
  "google:gemini-2.5-flash-lite": { ttftMs: 220, tokensPerSec: 130 },
  "google:gemini-2.5-flash": { ttftMs: 280, tokensPerSec: 100 },
  "google:gemini-2.5-pro": { ttftMs: 450, tokensPerSec: 55 },
  "groq:gpt-oss-20b": { ttftMs: 120, tokensPerSec: 1000 },
  "groq:gpt-oss-120b": { ttftMs: 160, tokensPerSec: 500 },
  "xai:grok-3-mini": { ttftMs: 280, tokensPerSec: 90 },
  "xai:grok-3": { ttftMs: 350, tokensPerSec: 70 },
  "xai:grok-4": { ttftMs: 420, tokensPerSec: 55 },
  "tts:kokoro_http": { ttsFirstByteMs: 180 },
  "tts:coqui_xtts": { ttsFirstByteMs: 550 },
  "tts:chatterbox_http": { ttsFirstByteMs: 400 },
  "tts:qwen3_tts_http": { ttsFirstByteMs: 350 },
  "tts:miso_tts_http": { ttsFirstByteMs: 280 },
  "openai:tts-1": { ttsFirstByteMs: 400 },
  "elevenlabs:flash": { ttsFirstByteMs: 180 },
};

const FIRST_SENTENCE_TOKENS = 24;

function isLocalSku(sku: string): boolean {
  return PIPELINE_SKU_BY_ID[sku]?.hostOk === false;
}

function generateMs(ttftMs: number, tokensPerSec: number, tokens: number): number {
  const tps = Math.max(1, tokensPerSec);
  return Math.round(ttftMs + (tokens / tps) * 1000);
}

export function estimateLatency(
  selection: PipelineSelection,
  assumptionsInput?: Partial<PipelineEstimateAssumptions> | null,
): PipelineLatency {
  const assumptions = normalizeAssumptions(assumptionsInput);
  const stt = LATENCY_BY_SKU[selection.sttSku] || {};
  const llm = LATENCY_BY_SKU[selection.llmSku] || {};
  const tts = LATENCY_BY_SKU[selection.ttsSku] || {};
  const sttMs = stt.sttMs ?? 700;
  const ttftMs = llm.ttftMs ?? 400;
  const tokensPerSec = llm.tokensPerSec ?? 60;
  const ttsMs = tts.ttsFirstByteMs ?? 350;
  const localVoice =
    isLocalSku(selection.sttSku) && isLocalSku(selection.llmSku) && isLocalSku(selection.ttsSku);
  const overheadMs = 25 + (localVoice ? 15 : 40);
  const llmMs = generateMs(ttftMs, tokensPerSec, FIRST_SENTENCE_TOKENS);
  const fullLlmMs = generateMs(ttftMs, tokensPerSec, assumptions.replyTokensPerTurn);
  return {
    disclaimer: "estimate_not_sla",
    firstAudioMs: sttMs + llmMs + ttsMs + overheadMs,
    fullReplyMs: sttMs + fullLlmMs + ttsMs + overheadMs,
    sttMs,
    llmMs,
    ttsMs,
    overheadMs,
    replyTokens: assumptions.replyTokensPerTurn,
  };
}

function pricesForSku(card: RateCardPrice[], sku: string): RateCardPrice[] {
  return card.filter((p) => p.sku === sku);
}

function pickUnit(prices: RateCardPrice[], unit: PipelinePriceUnit): RateCardPrice | undefined {
  return prices.find((p) => p.unit === unit);
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

function line(
  slot: PipelineSlot,
  sku: string,
  centsPerMinute: number,
  meta?: RateCardPrice,
): EstimateLineItem {
  const label = PIPELINE_SKU_BY_ID[sku]?.label || sku;
  return {
    slot,
    sku,
    label,
    centsPerMinute: round4(centsPerMinute),
    source: meta?.source || "unpriced",
    asOf: meta?.asOf || "",
    stale: Boolean(meta?.stale),
    overridden: Boolean(meta?.overridden),
  };
}

export function estimatePipeline(
  selection: PipelineSelection,
  card: RateCardPrice[],
  assumptionsInput?: Partial<PipelineEstimateAssumptions> | null,
): PipelineEstimate {
  const assumptions = normalizeAssumptions(assumptionsInput);
  const telcoSku = selection.telcoSku || "telnyx:inbound";

  const hostPrices = pricesForSku(card, selection.hostSku);
  const telcoPrices = pricesForSku(card, telcoSku);
  const sttPrices = pricesForSku(card, selection.sttSku);
  const llmPrices = pricesForSku(card, selection.llmSku);
  const ttsPrices = pricesForSku(card, selection.ttsSku);

  const telcoMeta = pickUnit(telcoPrices, "per_minute");
  const telcoCents = telcoMeta ? millicentsToCents(telcoMeta.millicents) : 0;

  const sttMeta = pickUnit(sttPrices, "per_minute");
  const sttCents = sttMeta ? millicentsToCents(sttMeta.millicents) * assumptions.callerTalkRatio : 0;

  const ttsMeta = pickUnit(ttsPrices, "per_1k_chars");
  const ttsCents = ttsMeta
    ? millicentsToCents(ttsMeta.millicents) * (assumptions.ttsCharsPerMin / 1000)
    : 0;

  const llmIn = pickUnit(llmPrices, "per_1m_input_tokens");
  const llmOut = pickUnit(llmPrices, "per_1m_output_tokens");
  const llmCents =
    (llmIn ? millicentsToCents(llmIn.millicents) * (assumptions.llmInputTokensPerMin / 1_000_000) : 0) +
    (llmOut ? millicentsToCents(llmOut.millicents) * (assumptions.llmOutputTokensPerMin / 1_000_000) : 0);

  const hostMeta = pickUnit(hostPrices, "per_month");
  const hostMonthlyCents = hostMeta ? millicentsToCents(hostMeta.millicents) : 0;
  const hostCents = hostMonthlyCents / assumptions.assumedMonthlyMinutes;

  const lineItems = [
    line("telco", telcoSku, telcoCents, telcoMeta),
    line("stt", selection.sttSku, sttCents, sttMeta),
    line("llm", selection.llmSku, llmCents, llmIn || llmOut),
    line("tts", selection.ttsSku, ttsCents, ttsMeta),
    line("host", selection.hostSku, hostCents, hostMeta),
  ];

  const cogsPerMinuteCents = round4(lineItems.reduce((s, i) => s + i.centsPerMinute, 0));
  const retailPerMinuteCents = round4(cogsPerMinuteCents * (1 + assumptions.retailMarginBps / 10_000));
  const monthlyCogsCents = round4(cogsPerMinuteCents * assumptions.assumedMonthlyMinutes);
  const monthlyRetailCents = round4(retailPerMinuteCents * assumptions.assumedMonthlyMinutes);

  const asOfTimes = card.map((p) => Date.parse(p.asOf)).filter((n) => Number.isFinite(n));
  const rateCardAsOf = asOfTimes.length
    ? new Date(Math.max(...asOfTimes)).toISOString()
    : null;

  return {
    disclaimer: "estimate_not_invoice",
    rateCardAsOf,
    assumptions,
    lineItems,
    cogsPerMinuteCents,
    retailPerMinuteCents,
    monthlyCogsCents,
    monthlyRetailCents,
    retailMarginBps: assumptions.retailMarginBps,
    latency: estimateLatency(selection, assumptions),
  };
}
