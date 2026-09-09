/** Tenant BYOK + on-prem defaults. Raw keys never belong in this module. */

export const ONPREM_NEMOTRON_MODEL = "Qwen3.5-27B-GPTQ-Int4";
export const ONPREM_NEMOTRON_BASE_URL = "http://host.docker.internal:8082/v1";
export const ONPREM_NEMOTRON_CHAT_URL = `${ONPREM_NEMOTRON_BASE_URL}/chat/completions`;

export const TENANT_LLM_PROVIDERS = ["openai", "anthropic", "google", "groq", "xai"] as const;
export type TenantLlmProvider = (typeof TENANT_LLM_PROVIDERS)[number];

export type TenantLlmApi = "openai" | "anthropic";

export type TenantLlmProviderMeta = {
  label: string;
  defaultModel: string;
  /** OpenAI-compatible /v1 base, or Anthropic API origin (no /v1). */
  baseUrl: string;
  api: TenantLlmApi;
};

export const TENANT_LLM_PROVIDER_META: Record<TenantLlmProvider, TenantLlmProviderMeta> = {
  openai: {
    label: "OpenAI",
    defaultModel: "gpt-4o-mini",
    baseUrl: "https://api.openai.com/v1",
    api: "openai",
  },
  anthropic: {
    label: "Anthropic",
    defaultModel: "claude-sonnet-4-5",
    baseUrl: "https://api.anthropic.com",
    api: "anthropic",
  },
  google: {
    label: "Google Gemini",
    defaultModel: "gemini-2.5-flash",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    api: "openai",
  },
  groq: {
    label: "Groq",
    defaultModel: "openai/gpt-oss-120b",
    baseUrl: "https://api.groq.com/openai/v1",
    api: "openai",
  },
  xai: {
    label: "xAI Grok",
    defaultModel: "grok-3-mini",
    baseUrl: "https://api.x.ai/v1",
    api: "openai",
  },
};

export function isTenantLlmProvider(value: unknown): value is TenantLlmProvider {
  return typeof value === "string" && (TENANT_LLM_PROVIDERS as readonly string[]).includes(value);
}

export function tenantLlmMeta(provider: TenantLlmProvider): TenantLlmProviderMeta {
  return TENANT_LLM_PROVIDER_META[provider];
}

/** True when a string is empty or a known install-time placeholder — not a usable cloud key. */
export function isPlaceholderApiKey(key: string | undefined | null): boolean {
  if (!key?.trim()) return true;
  const t = key.trim();
  if (/^CHANGE_ME/i.test(t)) return true;
  if (/^PASTE_/i.test(t)) return true;
  if (/^sk-test/i.test(t)) return true;
  if (t === "EMPTY" || t === "your-api-key-here") return true;
  return false;
}

export function hasUsableApiKey(key: string | undefined | null): boolean {
  return !isPlaceholderApiKey(key);
}
