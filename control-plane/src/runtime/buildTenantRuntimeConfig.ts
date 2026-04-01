import type { TTSConfig } from "../config";
import type { TenantContext } from "../tenants";
import {
  normalizeE164,
  parseRuntimeTenantConfig,
  type RuntimeTenantConfig,
} from "./runtimeContract";

export type BuildRuntimeConfigErrorCode =
  | "no_dids"
  | "missing_webhook_secret"
  | "missing_tts_url"
  | "missing_whisper_url";

export class BuildRuntimeConfigError extends Error {
  readonly code: BuildRuntimeConfigErrorCode;

  constructor(code: BuildRuntimeConfigErrorCode, message: string) {
    super(message);
    this.name = "BuildRuntimeConfigError";
    this.code = code;
  }
}

function parsePositiveIntEnv(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
}

function defaultCaps(): RuntimeTenantConfig["caps"] {
  return {
    maxConcurrentCallsTenant: parsePositiveIntEnv("TENANT_CONCURRENCY_CAP_DEFAULT", 10),
    maxCallsPerMinuteTenant: parsePositiveIntEnv("TENANT_CALLS_PER_MIN_CAP_DEFAULT", 60),
    maxConcurrentCallsGlobal: parsePositiveIntEnv("GLOBAL_CONCURRENCY_CAP", 16),
  };
}

function defaultAudio(
  existing?: RuntimeTenantConfig["audio"]
): RuntimeTenantConfig["audio"] {
  const pub = (process.env.AUDIO_PUBLIC_BASE_URL || "").trim();
  const dir = (process.env.AUDIO_STORAGE_DIR || "").trim();
  return {
    ...(pub ? { publicBaseUrl: pub } : {}),
    ...(dir ? { storageDir: dir } : {}),
    runtimeManaged: true,
    ...existing,
  };
}

function buildLlmContext(tenant: TenantContext): NonNullable<RuntimeTenantConfig["llmContext"]> {
  const prompts = tenant.config.getPrompts();
  return {
    forwardingProfiles: tenant.forwardingProfiles.map((p) => ({
      id: p.id,
      name: p.name,
      number: p.number,
      role: p.role,
    })),
    pricing: {
      items: tenant.pricing.items.map((item) => ({
        id: item.id,
        name: item.name,
        price: item.price,
        description: item.description,
      })),
      notes: tenant.pricing.notes,
    },
    prompts: {
      systemPreamble: prompts.systemPreamble,
      schemaHint: prompts.schemaHint,
      policyPrompt: prompts.policyPrompt,
      voicePrompt: prompts.voicePrompt,
    },
  };
}

function buildRuntimeTts(cfg: TTSConfig): RuntimeTenantConfig["tts"] {
  const mode = cfg.ttsMode || "coqui_xtts";
  const voice = cfg.voiceId;
  const language = cfg.language;
  const fmt = "wav";
  const sampleRate = 24000;

  if (mode === "kokoro_http") {
    const kokoroUrl = (cfg.kokoroUrl || cfg.xttsUrl || "").trim();
    if (!kokoroUrl) {
      throw new BuildRuntimeConfigError(
        "missing_tts_url",
        "Kokoro TTS URL is not set. Configure it in Voice settings, or set KOKORO_URL / XTTS_URL on the control plane."
      );
    }
    return {
      mode: "kokoro_http",
      kokoroUrl,
      voice,
      format: fmt,
      sampleRate,
      rate: Math.min(1.5, Math.max(0.5, cfg.rate)),
    };
  }

  if (mode === "chatterbox_http") {
    const chatterboxUrl = (cfg.chatterboxUrl || cfg.xttsUrl || "").trim();
    if (!chatterboxUrl) {
      throw new BuildRuntimeConfigError(
        "missing_tts_url",
        "Chatterbox TTS URL is not set. Configure it in Voice settings, or set CHATTERBOX_URL / XTTS_URL on the control plane."
      );
    }
    const cloned =
      cfg.clonedVoice?.speakerWavUrl?.trim()
        ? {
            speakerWavUrl: cfg.clonedVoice.speakerWavUrl.trim(),
            ...(cfg.clonedVoice.label?.trim() ? { label: cfg.clonedVoice.label.trim() } : {}),
          }
        : undefined;
    const spk = cfg.clonedVoice?.speakerWavUrl?.trim();
    return {
      mode: "chatterbox_http",
      chatterboxUrl,
      chatterboxVariant: cfg.chatterboxVariant,
      voice,
      language,
      format: fmt,
      sampleRate,
      clonedVoice: cloned,
      defaultVoiceMode: cfg.defaultVoiceMode,
      ...(spk ? { speakerWavUrl: spk } : {}),
    };
  }

  if (mode === "qwen3_tts_http") {
    const qwen3TtsUrl = (cfg.qwen3TtsUrl || cfg.xttsUrl || "").trim();
    if (!qwen3TtsUrl) {
      throw new BuildRuntimeConfigError(
        "missing_tts_url",
        "Qwen3 TTS URL is not set. Configure it in Voice settings, or set QWEN3_TTS_URL / XTTS_URL on the control plane."
      );
    }
    const instruct = cfg.qwen3Instruct?.trim() || undefined;
    return {
      mode: "qwen3_tts_http",
      qwen3TtsUrl,
      speaker: voice,
      language,
      instruct,
      format: fmt,
      sampleRate,
      qwen3DoSample: cfg.qwen3DoSample,
      qwen3Temperature: cfg.qwen3Temperature,
      qwen3TopP: cfg.qwen3TopP,
      qwen3TopK: cfg.qwen3TopK,
      qwen3RepetitionPenalty: cfg.qwen3RepetitionPenalty,
      qwen3MaxNewTokens: cfg.qwen3MaxNewTokens,
      qwen3NonStreamingMode: cfg.qwen3NonStreamingMode,
      qwen3SubtalkerDoSample: cfg.qwen3SubtalkerDoSample,
      qwen3SubtalkerTopK: cfg.qwen3SubtalkerTopK,
      qwen3SubtalkerTopP: cfg.qwen3SubtalkerTopP,
      qwen3SubtalkerTemperature: cfg.qwen3SubtalkerTemperature,
      ...(cfg.qwen3Streaming === true ? { qwen3Streaming: true as const } : {}),
    };
  }

  // coqui_xtts
  const coquiXttsUrl = (cfg.coquiXttsUrl || cfg.xttsUrl || "").trim();
  if (!coquiXttsUrl) {
    throw new BuildRuntimeConfigError(
      "missing_tts_url",
      "Coqui XTTS URL is not set. Configure it in Voice settings, or set XTTS_URL on the control plane."
    );
  }
  const cloned =
    cfg.clonedVoice?.speakerWavUrl?.trim()
      ? {
          speakerWavUrl: cfg.clonedVoice.speakerWavUrl.trim(),
          ...(cfg.clonedVoice.label?.trim() ? { label: cfg.clonedVoice.label.trim() } : {}),
        }
      : undefined;
  const coquiSpk = cfg.clonedVoice?.speakerWavUrl?.trim();
  return {
    mode: "coqui_xtts",
    coquiXttsUrl,
    voice,
    language,
    format: fmt,
    sampleRate,
    clonedVoice: cloned,
    defaultVoiceMode: cfg.defaultVoiceMode,
    ...(coquiSpk ? { speakerWavUrl: coquiSpk } : {}),
    coquiTemperature: cfg.coquiTemperature,
    coquiLengthPenalty: cfg.coquiLengthPenalty,
    coquiRepetitionPenalty: cfg.coquiRepetitionPenalty,
    coquiTopK: cfg.coquiTopK,
    coquiTopP: cfg.coquiTopP,
    coquiSpeed: cfg.coquiSpeed,
    coquiSplitSentences: cfg.coquiSplitSentences,
    rate: cfg.rate,
  };
}

/**
 * Builds a full {@link RuntimeTenantConfig} from Postgres-backed tenant state,
 * merging in non-portal fields from an existing Redis config when present
 * (webhook secret, quick replies, assistant context, transfer profiles, caps defaults).
 */
export function buildTenantRuntimeConfig(
  tenant: TenantContext,
  existing: RuntimeTenantConfig | null
): RuntimeTenantConfig {
  const numbers = tenant.meta.numbers || [];
  const dids: string[] = [];
  for (const raw of numbers) {
    try {
      dids.push(normalizeE164(String(raw || "").trim()));
    } catch {
      /* skip invalid entries */
    }
  }
  if (dids.length === 0) {
    throw new BuildRuntimeConfigError(
      "no_dids",
      "This business has no valid E.164 phone numbers. Add at least one reception line in tenant settings before publishing to the voice runtime."
    );
  }

  const sttCfg = tenant.config.getSttConfig();
  const whisperUrl = (sttCfg.whisperUrl || "").trim();
  if (!whisperUrl) {
    throw new BuildRuntimeConfigError(
      "missing_whisper_url",
      "Whisper STT URL is not set. Configure STT in the dashboard or set WHISPER_URL on the control plane."
    );
  }

  const chunkMs = parsePositiveIntEnv("STT_CHUNK_MS", 500);
  const ttsCfg = tenant.config.getTtsConfig();
  const tts = buildRuntimeTts(ttsCfg);

  const base: RuntimeTenantConfig = {
    contractVersion: "v1",
    tenantId: tenant.id,
    dids,
    caps: existing?.caps ?? defaultCaps(),
    stt: {
      mode: "whisper_http",
      whisperUrl,
      chunkMs,
      language: "en",
    },
    tts,
    audio: defaultAudio(existing?.audio),
    llmContext: buildLlmContext(tenant),
    ...(existing?.webhookSecret ? { webhookSecret: existing.webhookSecret } : {}),
    ...(existing?.webhookSecretRef ? { webhookSecretRef: existing.webhookSecretRef } : {}),
    ...(existing?.quickReplies !== undefined ? { quickReplies: existing.quickReplies } : {}),
    ...(existing?.assistantContext && Object.keys(existing.assistantContext).length
      ? { assistantContext: existing.assistantContext }
      : {}),
    ...(existing?.transferProfiles?.length ? { transferProfiles: existing.transferProfiles } : {}),
    ...(existing?.callForwarding ? { callForwarding: existing.callForwarding } : {}),
  };

  if (!base.webhookSecret && !base.webhookSecretRef) {
    const w = (process.env.TELNYX_WEBHOOK_SECRET || "").trim();
    if (!w) {
      throw new BuildRuntimeConfigError(
        "missing_webhook_secret",
        "No webhook secret in Redis yet and TELNYX_WEBHOOK_SECRET is not set on the control plane. Set the env var or publish a config once with POST .../runtime/tenants/:id/config including webhookSecret / webhookSecretRef."
      );
    }
    base.webhookSecret = w;
  }

  return parseRuntimeTenantConfig(base);
}
