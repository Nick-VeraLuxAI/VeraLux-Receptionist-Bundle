import type { RateCardPrice } from "@veralux/shared";
import { quoteHostMonthlyCents } from "../hosts/quotes";

export type FeedQuote = RateCardPrice & { feedKey?: string };

export type FeedResult = {
  source: string;
  ok: boolean;
  stale: boolean;
  error?: string;
  prices: FeedQuote[];
  unmapped: string[];
};

const LITELLM_URL =
  process.env.LITELLM_PRICE_URL ||
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";

/** Explicit SKU → LiteLLM model-id mapping. Unknown feed keys stay unmapped. */
const LITELLM_SKU_MAP: Record<string, string> = {
  "openai:gpt-4o-mini": "gpt-4o-mini",
  "openai:gpt-4o": "gpt-4o",
  "openai:gpt-4.1-nano": "gpt-4.1-nano",
  "openai:gpt-4.1-mini": "gpt-4.1-mini",
  "openai:gpt-4.1": "gpt-4.1",
  "openai:gpt-5-nano": "gpt-5-nano",
  "openai:gpt-5-mini": "gpt-5-mini",
  "openai:gpt-5": "gpt-5",
  "openai:o4-mini": "o4-mini",
  "anthropic:claude-haiku-4-5": "claude-haiku-4-5",
  "anthropic:claude-sonnet-4-5": "claude-sonnet-4-5",
  "anthropic:claude-opus-4-6": "claude-opus-4-6",
  "google:gemini-2.5-flash-lite": "gemini-2.5-flash-lite",
  "google:gemini-2.5-flash": "gemini-2.5-flash",
  "google:gemini-2.5-pro": "gemini-2.5-pro",
  "groq:gpt-oss-20b": "groq/openai/gpt-oss-20b",
  "groq:gpt-oss-120b": "groq/openai/gpt-oss-120b",
  "xai:grok-3-mini": "xai/grok-3-mini",
  "xai:grok-3": "xai/grok-3",
  "xai:grok-4": "xai/grok-4",
  "openai:whisper-1": "whisper-1",
  "openai:tts-1": "tts-1",
};

function dollarsPerMillionToMillicents(d: number): number {
  return Math.round(d * 100 * 1000);
}

function dollarsToMillicentsPerUnit(d: number): number {
  return Math.round(d * 100 * 1000);
}

async function fetchJson(url: string, headers?: Record<string, string>, timeoutMs = 12_000): Promise<unknown> {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers, signal: controller.signal });
    if (!res.ok) throw new Error(`http_${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

export async function fetchLiteLlmFeed(): Promise<FeedResult> {
  const asOf = new Date().toISOString();
  try {
    const raw = (await fetchJson(LITELLM_URL)) as Record<string, Record<string, unknown>>;
    const prices: FeedQuote[] = [];
    const seen = new Set<string>();
    for (const [sku, modelId] of Object.entries(LITELLM_SKU_MAP)) {
      const row = raw[modelId];
      if (!row || typeof row !== "object") continue;
      seen.add(modelId);
      const inCost = Number(row.input_cost_per_token);
      const outCost = Number(row.output_cost_per_token);
      const outChar = Number(row.output_cost_per_character);
      if (sku === "openai:whisper-1") {
        const perSec = Number(row.output_cost_per_second);
        if (Number.isFinite(perSec) && perSec > 0) {
          prices.push({
            sku,
            unit: "per_minute",
            millicents: dollarsToMillicentsPerUnit(perSec * 60),
            currency: "USD",
            source: "litellm",
            asOf,
            feedKey: modelId,
          });
        }
        continue;
      }
      if (sku === "openai:tts-1" && Number.isFinite(outChar) && outChar > 0) {
        prices.push({
          sku,
          unit: "per_1k_chars",
          millicents: dollarsToMillicentsPerUnit(outChar * 1000),
          currency: "USD",
          source: "litellm",
          asOf,
          feedKey: modelId,
        });
        continue;
      }
      if (Number.isFinite(inCost) && inCost > 0) {
        prices.push({
          sku,
          unit: "per_1m_input_tokens",
          millicents: dollarsPerMillionToMillicents(inCost * 1_000_000),
          currency: "USD",
          source: "litellm",
          asOf,
          feedKey: modelId,
        });
      }
      if (Number.isFinite(outCost) && outCost > 0) {
        prices.push({
          sku,
          unit: "per_1m_output_tokens",
          millicents: dollarsPerMillionToMillicents(outCost * 1_000_000),
          currency: "USD",
          source: "litellm",
          asOf,
          feedKey: modelId,
        });
      }
    }
    const unmapped = Object.keys(raw)
      .filter((k) => !k.startsWith("sample_") && !seen.has(k) && Object.values(LITELLM_SKU_MAP).includes(k) === false)
      .slice(0, 40);
    return { source: "litellm", ok: prices.length > 0, stale: false, prices, unmapped };
  } catch (e) {
    return { source: "litellm", ok: false, stale: true, error: e instanceof Error ? e.message : String(e), prices: [], unmapped: [] };
  }
}

export async function fetchOpenRouterFeed(): Promise<FeedResult> {
  const key = (process.env.OPENROUTER_API_KEY || "").trim();
  if (!key) {
    return { source: "openrouter", ok: true, stale: false, prices: [], unmapped: [], error: "skipped_no_key" };
  }
  const asOf = new Date().toISOString();
  try {
    const raw = (await fetchJson("https://openrouter.ai/api/v1/models", { Authorization: `Bearer ${key}` })) as {
      data?: Array<{ id: string; pricing?: { prompt?: string; completion?: string } }>;
    };
    const alias: Record<string, string> = {
      "openai/gpt-4o-mini": "openai:gpt-4o-mini",
      "openai/gpt-4o": "openai:gpt-4o",
      "openai/gpt-4.1": "openai:gpt-4.1",
      "openai/gpt-5": "openai:gpt-5",
      "openai/gpt-5-mini": "openai:gpt-5-mini",
      "anthropic/claude-sonnet-4.5": "anthropic:claude-sonnet-4-5",
      "google/gemini-2.5-flash": "google:gemini-2.5-flash",
      "google/gemini-2.5-pro": "google:gemini-2.5-pro",
      "x-ai/grok-3-mini": "xai:grok-3-mini",
      "x-ai/grok-4": "xai:grok-4",
      "groq/openai/gpt-oss-20b": "groq:gpt-oss-20b",
      "groq/openai/gpt-oss-120b": "groq:gpt-oss-120b",
    };
    const prices: FeedQuote[] = [];
    for (const m of raw.data || []) {
      const sku = alias[m.id];
      if (!sku || !m.pricing) continue;
      const prompt = Number(m.pricing.prompt);
      const completion = Number(m.pricing.completion);
      if (Number.isFinite(prompt)) {
        prices.push({
          sku,
          unit: "per_1m_input_tokens",
          millicents: dollarsPerMillionToMillicents(prompt * 1_000_000),
          currency: "USD",
          source: "openrouter",
          asOf,
          feedKey: m.id,
        });
      }
      if (Number.isFinite(completion)) {
        prices.push({
          sku,
          unit: "per_1m_output_tokens",
          millicents: dollarsPerMillionToMillicents(completion * 1_000_000),
          currency: "USD",
          source: "openrouter",
          asOf,
          feedKey: m.id,
        });
      }
    }
    return { source: "openrouter", ok: true, stale: false, prices, unmapped: [] };
  } catch (e) {
    return { source: "openrouter", ok: false, stale: true, error: e instanceof Error ? e.message : String(e), prices: [], unmapped: [] };
  }
}

export async function fetchTelnyxListed(): Promise<FeedResult> {
  const asOf = new Date().toISOString();
  const listed = Number(process.env.TELNYX_INBOUND_PER_MIN_USD || "0.007");
  return {
    source: "telnyx",
    ok: true,
    stale: false,
    prices: [
      {
        sku: "telnyx:inbound",
        unit: "per_minute",
        millicents: dollarsToMillicentsPerUnit(listed),
        currency: "USD",
        source: "telnyx_listed",
        asOf,
      },
    ],
    unmapped: [],
  };
}

export async function fetchDeepgramListed(): Promise<FeedResult> {
  const asOf = new Date().toISOString();
  const listed = Number(process.env.DEEPGRAM_NOVA2_PER_MIN_USD || "0.0043");
  return {
    source: "deepgram",
    ok: true,
    stale: false,
    prices: [
      {
        sku: "deepgram:nova-2",
        unit: "per_minute",
        millicents: dollarsToMillicentsPerUnit(listed),
        currency: "USD",
        source: "deepgram_listed",
        asOf,
      },
    ],
    unmapped: [],
  };
}

export async function fetchElevenLabsListed(): Promise<FeedResult> {
  const asOf = new Date().toISOString();
  const listed = Number(process.env.ELEVENLABS_FLASH_PER_1K_USD || "0.05");
  return {
    source: "elevenlabs",
    ok: true,
    stale: false,
    prices: [
      {
        sku: "elevenlabs:flash",
        unit: "per_1k_chars",
        millicents: dollarsToMillicentsPerUnit(listed),
        currency: "USD",
        source: "elevenlabs_listed",
        asOf,
      },
    ],
    unmapped: [],
  };
}

export async function fetchHostListed(): Promise<FeedResult> {
  const asOf = new Date().toISOString();
  const skus = [
    ["render", "starter", "render:starter"],
    ["render", "standard", "render:standard"],
    ["render", "pro", "render:pro"],
    ["railway", "hobby", "railway:hobby"],
    ["railway", "pro", "railway:pro"],
    ["aws", "fargate_small", "aws:fargate_small"],
    ["aws", "fargate_medium", "aws:fargate_medium"],
  ] as const;
  const prices: FeedQuote[] = [];
  for (const [host, size, sku] of skus) {
    const cents = quoteHostMonthlyCents(host, size);
    prices.push({
      sku,
      unit: "per_month",
      millicents: Math.round(cents * 1000),
      currency: "USD",
      source: `${host}_listed`,
      asOf,
    });
  }
  return { source: "hosts", ok: true, stale: false, prices, unmapped: [] };
}

export async function fetchAwsPriceList(): Promise<FeedResult> {
  const asOf = new Date().toISOString();
  try {
    const raw = (await fetchJson("https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonECS/current/index.json")) as {
      publicationDate?: string;
    };
    return {
      source: "aws_pricelist",
      ok: true,
      stale: false,
      prices: [],
      unmapped: raw.publicationDate ? [`ecs_index:${raw.publicationDate}`] : [],
    };
  } catch (e) {
    return {
      source: "aws_pricelist",
      ok: false,
      stale: true,
      error: e instanceof Error ? e.message : String(e),
      prices: [],
      unmapped: [],
    };
  }
}

export async function runAllFeeds(): Promise<FeedResult[]> {
  return Promise.all([
    fetchLiteLlmFeed(),
    fetchOpenRouterFeed(),
    fetchTelnyxListed(),
    fetchDeepgramListed(),
    fetchElevenLabsListed(),
    fetchHostListed(),
    fetchAwsPriceList(),
  ]);
}
