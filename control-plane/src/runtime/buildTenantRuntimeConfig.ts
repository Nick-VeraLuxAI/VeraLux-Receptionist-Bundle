import type { TTSConfig } from "../config";
import type { TenantContext } from "../tenants";
import type { TenantLimits } from "../planLimits";
import {
  businessHoursSchema,
  ensureOnCallTransferProfile,
  forwardingProfilesToTransferProfiles,
  mergeTransferProfiles,
  normalizeIntakeProfile,
  normalizeShopPlaybook,
  pricingToAssistantContext,
  stormModeActive,
} from "@veralux/shared";
import {
  normalizeE164,
  parseRuntimeTenantConfig,
  type RuntimeCallQuality,
  type RuntimeTenantConfig,
} from "./runtimeContract";
import { runtimeTenantLlmRoutingSchema } from "@veralux/shared";

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

function extractLlmRoutingForPublish(tenant: TenantContext): RuntimeTenantConfig["llmRouting"] {
  const raw = tenant.operatorState?.llmPortal;
  if (!raw || typeof raw !== "object") return undefined;
  const parsed = runtimeTenantLlmRoutingSchema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}

function buildLlmContext(tenant: TenantContext): NonNullable<RuntimeTenantConfig["llmContext"]> {
  const prompts = tenant.config.getPrompts();
  const base: NonNullable<RuntimeTenantConfig["llmContext"]> = {
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
      // Per-tenant opening greeting; published so the voice runtime can use it
      // instead of the global env.GREETING_TEXT (Sprint 0 cohesion fix).
      ...(prompts.greetingText && prompts.greetingText.trim()
        ? { greetingText: prompts.greetingText }
        : {}),
    },
  };
  const bhParsed = businessHoursSchema.safeParse(tenant.businessHours);
  if (bhParsed.success) {
    (base as { businessHours?: unknown }).businessHours = bhParsed.data;
  }
  return base;
}

function buildRuntimeTts(cfg: TTSConfig): RuntimeTenantConfig["tts"] {
  const voice = cfg.voiceId;
  const language = cfg.language;
  const fmt = "wav";
  const sampleRate = 24000;
  const kokoroUrl = (
    (cfg.kokoroUrl && /kokoro/i.test(cfg.kokoroUrl) ? cfg.kokoroUrl : "") ||
    process.env.KOKORO_URL ||
    (cfg.xttsUrl && /kokoro/i.test(cfg.xttsUrl) ? cfg.xttsUrl : "") ||
    ""
  ).trim();
  if (!kokoroUrl) {
    throw new BuildRuntimeConfigError(
      "missing_tts_url",
      "Kokoro TTS URL is not set. Configure it in Voice settings, or set KOKORO_URL on the control plane."
    );
  }
  const looksKokoro = /^(a[fm]_|b[fm]_)[a-z]+$/i.test(voice || "");
  const mapped = /en-gb/i.test(language || "")
    ? /^(am_|bm_)/i.test(voice || "")
      ? "bm_george"
      : /^(bf_|bm_)/i.test(voice || "")
        ? voice
        : "bf_emma"
    : /^(bf_|bm_)/i.test(voice || "")
      ? /^(bm_)/i.test(voice || "")
        ? "am_adam"
        : "af_heart"
      : voice;
  const kokoroVoice = looksKokoro
    ? mapped || voice
    : process.env.KOKORO_VOICE_ID || "af_bella";
  const presetMul =
    cfg.preset === "calm" ? 0.88 : cfg.preset === "energetic" ? 1.08 : cfg.preset === "warm" ? 0.96 : 1;
  const slider = Number.isFinite(cfg.rate) ? Math.min(1.2, Math.max(0.8, cfg.rate)) : 1;
  return {
    mode: "kokoro_http",
    kokoroUrl,
    voice: kokoroVoice || "af_bella",
    format: fmt,
    sampleRate,
    rate: Math.min(1.5, Math.max(0.5, Math.round(slider * presetMul * 100) / 100)),
  };
}

/**
 * Builds a full {@link RuntimeTenantConfig} from Postgres-backed tenant state,
 * merging in non-portal fields from an existing Redis config when present
 * (webhook secret, quick replies, assistant context, transfer profiles, caps defaults).
 */
export function buildTenantRuntimeConfig(
  tenant: TenantContext,
  existing: RuntimeTenantConfig | null,
  tenantLimits?: TenantLimits | null,
  callQuality?: RuntimeCallQuality | null,
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
  const sttMode = sttCfg.mode || "whisper_http";
  const whisperUrl = (sttCfg.whisperUrl || "").trim();
  const cloudStt = sttMode === "openai_whisper" || sttMode === "deepgram";
  if (!cloudStt && !whisperUrl) {
    throw new BuildRuntimeConfigError(
      "missing_whisper_url",
      "Whisper STT URL is not set. Configure STT in the dashboard or set WHISPER_URL on the control plane."
    );
  }

  const chunkMs = parsePositiveIntEnv("STT_CHUNK_MS", 500);
  const ttsCfg = tenant.config.getTtsConfig();
  const tts = buildRuntimeTts(ttsCfg);
  const publishedPlaybook = normalizeShopPlaybook(
    (tenant as { shopPlaybook?: unknown }).shopPlaybook as never,
  );
  const configuredTenantCap = tenantLimits
    ? Math.max(1, tenantLimits.maxConcurrentCalls)
    : existing?.caps?.maxConcurrentCallsTenant ??
      defaultCaps().maxConcurrentCallsTenant;
  const tenantCallCap =
    stormModeActive(publishedPlaybook) &&
    publishedPlaybook.stormMode.parallelAnswerCap
      ? Math.min(
          configuredTenantCap,
          publishedPlaybook.stormMode.parallelAnswerCap,
        )
      : configuredTenantCap;

  const base: RuntimeTenantConfig = {
    contractVersion: "v1",
    tenantId: tenant.id,
    dids,
    caps: tenantLimits
      ? {
          maxConcurrentCallsTenant: tenantCallCap,
          maxCallsPerMinuteTenant: Math.max(1, Math.min(tenantLimits.maxDailyCalls || 1, existing?.caps?.maxCallsPerMinuteTenant ?? defaultCaps().maxCallsPerMinuteTenant)),
          maxConcurrentCallsGlobal: existing?.caps?.maxConcurrentCallsGlobal ?? defaultCaps().maxConcurrentCallsGlobal,
        }
      : {
          ...(existing?.caps ?? defaultCaps()),
          maxConcurrentCallsTenant: tenantCallCap,
        },
    stt: {
      mode: sttMode,
      ...(whisperUrl ? { whisperUrl } : {}),
      chunkMs,
      language: "en",
      ...(sttCfg.model ? { model: sttCfg.model } : {}),
    },
    tts,
    audio: defaultAudio(existing?.audio),
    llmContext: buildLlmContext(tenant),
    ...(existing?.webhookSecret ? { webhookSecret: existing.webhookSecret } : {}),
    ...(existing?.webhookSecretRef ? { webhookSecretRef: existing.webhookSecretRef } : {}),
    ...(tenant.telnyxPublicKey || existing?.telnyxPublicKey
      ? { telnyxPublicKey: tenant.telnyxPublicKey || existing?.telnyxPublicKey }
      : {}),
    ...(existing?.quickReplies !== undefined ? { quickReplies: existing.quickReplies } : {}),
    ...((): { assistantContext?: Record<string, string> } => {
      const fromPricing = pricingToAssistantContext(tenant.pricing);
      const existingCtx = existing?.assistantContext && typeof existing.assistantContext === "object" ? existing.assistantContext : {};
      const playbookNames = normalizeShopPlaybook((tenant as { shopPlaybook?: unknown }).shopPlaybook as never).membershipNames;
      const membership: Record<string, string> = {};
      if (playbookNames.length) membership["Membership plans"] = playbookNames.join(", ");
      const shopLaw = {
        "Shop law": [
          publishedPlaybook.serviceArea.zips.length
            ? `Service zips: ${publishedPlaybook.serviceArea.zips.join(", ")}`
            : "",
          publishedPlaybook.serviceArea.cities.length
            ? `Service cities: ${publishedPlaybook.serviceArea.cities.join(", ")}`
            : "",
          publishedPlaybook.refuseServices.length
            ? `Do not book: ${publishedPlaybook.refuseServices.join(", ")}`
            : "",
          publishedPlaybook.afterHoursFeeCents > 0
            ? `Configured after-hours fee: $${(
                publishedPlaybook.afterHoursFeeCents / 100
              ).toFixed(2)}`
            : "",
          publishedPlaybook.quoteHoldCents > 0
            ? `Owner approval required at $${(
                publishedPlaybook.quoteHoldCents / 100
              ).toFixed(2)} or more`
            : "",
        ]
          .filter(Boolean)
          .join("\n"),
      };
      const merged = {
        ...existingCtx,
        ...fromPricing,
        ...membership,
        ...(shopLaw["Shop law"] ? shopLaw : {}),
      };
      return Object.keys(merged).length ? { assistantContext: merged } : {};
    })(),
    ...((): { transferProfiles?: RuntimeTenantConfig["transferProfiles"] } => {
      const playbookForXfer = normalizeShopPlaybook((tenant as { shopPlaybook?: unknown }).shopPlaybook as never);
      const mapped = forwardingProfilesToTransferProfiles(tenant.forwardingProfiles || [], {
        onCallTimeoutSecs: playbookForXfer.onCallTimeoutSecs,
      });
      const merged = ensureOnCallTransferProfile(
        mergeTransferProfiles(mapped, existing?.transferProfiles),
        playbookForXfer,
      );
      return merged.length ? { transferProfiles: merged } : {};
    })(),
    ...(existing?.callForwarding ? { callForwarding: existing.callForwarding } : {}),
    ...(tenantLimits
      ? {
          usageLimits: {
            planName: tenantLimits.planName,
            planTier: tenantLimits.planTier,
            billingStatus: tenantLimits.billingStatus,
            overageMode: tenantLimits.overageMode,
            monthlyMinuteOverageRateCents: tenantLimits.monthlyMinuteOverageRateCents,
            effectiveFrom: tenantLimits.effectiveFrom ?? undefined,
            effectiveUntil: tenantLimits.effectiveUntil ?? undefined,
            maxConcurrentCalls: tenantLimits.maxConcurrentCalls,
            includedMonthlyMinutes: tenantLimits.includedMonthlyMinutes,
            maxMonthlyMinutesHardCap: tenantLimits.maxMonthlyMinutesHardCap,
            maxDailyCalls: tenantLimits.maxDailyCalls,
            maxMonthlyCalls: tenantLimits.maxMonthlyCalls,
            maxKnowledgeBaseSizeMb: tenantLimits.maxKnowledgeBaseSizeMb,
            maxIntegrations: tenantLimits.maxIntegrations,
            maxLocations: tenantLimits.maxLocations,
            maxPhoneNumbers: tenantLimits.maxPhoneNumbers,
            maxAdminUsers: tenantLimits.maxAdminUsers,
            maxEscalationContacts: tenantLimits.maxEscalationContacts,
            features: {
              afterHoursMode: tenantLimits.afterHoursMode,
              smsFollowup: tenantLimits.smsFollowup,
              calendarIntegration: tenantLimits.calendarIntegration,
              crmIntegration: tenantLimits.crmIntegration,
              advancedAnalytics: tenantLimits.advancedAnalytics,
              callRecording: tenantLimits.callRecording,
              transcriptRetention: tenantLimits.transcriptRetention,
              multiLocation: tenantLimits.multiLocation,
              customWorkflows: tenantLimits.customWorkflows,
              prioritySupport: tenantLimits.prioritySupport,
            },
          },
        }
      : existing?.usageLimits
      ? { usageLimits: existing.usageLimits }
      : {}),
  };

  const mergedCallQuality: RuntimeCallQuality | undefined =
    callQuality !== undefined && callQuality !== null
      ? callQuality
      : existing?.callQuality;
  if (mergedCallQuality) {
    (base as { callQuality?: RuntimeCallQuality }).callQuality = mergedCallQuality;
  }

  const llmRouting = extractLlmRoutingForPublish(tenant);
  if (llmRouting) {
    (base as { llmRouting?: typeof llmRouting }).llmRouting = llmRouting;
  }

  (base as { shopPlaybook?: unknown }).shopPlaybook = publishedPlaybook;
  (base as { intakeProfile?: unknown }).intakeProfile = normalizeIntakeProfile(
    (existing as { intakeProfile?: unknown } | undefined)?.intakeProfile as never,
    tenant.id,
  );

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
