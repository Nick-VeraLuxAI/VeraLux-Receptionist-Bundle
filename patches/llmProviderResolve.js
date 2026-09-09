"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isDisallowedPlaceholderApiKey = isDisallowedPlaceholderApiKey;
exports.normalizePlatformLlmKind = normalizePlatformLlmKind;
exports.effectiveVoicePlatformLlmRaw = effectiveVoicePlatformLlmRaw;
exports.resolveLlmExecutionPlan = resolveLlmExecutionPlan;
const env_1 = require("../env");
const log_1 = require("../log");
const controlPlaneTenantSecrets_1 = require("../controlPlaneTenantSecrets");

const ONPREM_MODEL = "Qwen3.5-27B-GPTQ-Int4";
const ONPREM_BASE = "http://host.docker.internal:8082/v1";
const TENANT_LLM_PROVIDER_META = {
    openai: { defaultModel: "gpt-4o-mini", baseUrl: "https://api.openai.com/v1", api: "openai" },
    anthropic: { defaultModel: "claude-sonnet-4-5", baseUrl: "https://api.anthropic.com", api: "anthropic" },
    google: { defaultModel: "gemini-2.5-flash", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", api: "openai" },
    groq: { defaultModel: "openai/gpt-oss-120b", baseUrl: "https://api.groq.com/openai/v1", api: "openai" },
    xai: { defaultModel: "grok-3-mini", baseUrl: "https://api.x.ai/v1", api: "openai" },
};

function isDisallowedPlaceholderApiKey(key) {
    if (!key?.trim())
        return true;
    const t = key.trim();
    if (/^CHANGE_ME/i.test(t))
        return true;
    if (/^PASTE_/i.test(t))
        return true;
    if (/^sk-test/i.test(t))
        return true;
    if (t === "EMPTY" || t === "your-api-key-here")
        return true;
    return false;
}
function isTenantLlmProvider(value) {
    return typeof value === "string" && Object.prototype.hasOwnProperty.call(TENANT_LLM_PROVIDER_META, value);
}
function normalizePlatformLlmKind(raw) {
    const p = (raw || "").trim().toLowerCase();
    if (p === "nemotron" || p === "openai_compatible" || p === "onprem" || p === "on_prem")
        return "nemotron";
    if (!p || p === "brain" || p === "local" || p === "brain_local")
        return "brain_local";
    if (p === "brain_http" || p === "http_brain" || p === "remote_brain")
        return "brain_http";
    if (p === "openai" || p === "gpt" || p === "chatgpt")
        return "openai";
    return "brain_local";
}
function effectiveVoicePlatformLlmRaw() {
    const explicit = env_1.env.PLATFORM_LLM_PROVIDER?.trim();
    if (explicit)
        return explicit;
    const legacy = env_1.env.LLM_PROVIDER?.trim();
    return legacy || "brain_local";
}
function onPremNemotronPlan(resolutionSource, modelOverride) {
    const baseUrl = (env_1.env.OPENAI_BASE_URL?.trim().replace(/\/$/, "") || ONPREM_BASE);
    const model = (modelOverride?.trim() || env_1.env.OPENAI_MODEL?.trim() || ONPREM_MODEL);
    const key = isDisallowedPlaceholderApiKey(env_1.env.OPENAI_API_KEY)
        ? "local-onprem"
        : env_1.env.OPENAI_API_KEY;
    return {
        route: "openai_direct",
        resolutionSource,
        apiKey: key,
        model,
        baseUrl,
    };
}
async function resolvePlatformPlan() {
    const kind = normalizePlatformLlmKind(effectiveVoicePlatformLlmRaw());
    if (kind === "nemotron") {
        return onPremNemotronPlan("platform:nemotron");
    }
    if (kind === "brain_local") {
        return { route: "brain_local", resolutionSource: "platform:brain_local" };
    }
    if (kind === "brain_http") {
        const base = env_1.env.BRAIN_URL?.trim();
        if (!base) {
            log_1.log.warn({ event: "provider_resolution_failed", reason: "brain_http_missing_brain_url" }, "platform brain_http selected but BRAIN_URL missing — falling back to on-prem Nemotron");
            return onPremNemotronPlan("platform:fallback_no_brain_url");
        }
        return { route: "brain_http", resolutionSource: "platform:brain_http", baseUrl: base };
    }
    const key = env_1.env.OPENAI_API_KEY?.trim();
    if (isDisallowedPlaceholderApiKey(key)) {
        log_1.log.warn({ event: "provider_resolution_failed", reason: "openai_invalid_platform_key" }, "platform openai selected but OPENAI_API_KEY missing/placeholder — falling back to on-prem Nemotron");
        return onPremNemotronPlan("platform:fallback_invalid_openai_key");
    }
    const model = env_1.env.OPENAI_MODEL?.trim() || "gpt-4o-mini";
    const baseUrl = (env_1.env.OPENAI_BASE_URL?.trim().replace(/\/$/, "") || "https://api.openai.com/v1");
    return {
        route: "openai_direct",
        resolutionSource: "platform:openai",
        apiKey: key,
        model,
        baseUrl,
    };
}
async function resolveLlmExecutionPlan(args) {
    const { tenantId, tenantConfig } = args;
    const routing = tenantConfig?.llmRouting;
    if (routing?.mode === "tenant_api_key" && isTenantLlmProvider(routing.tenantProvider)) {
        if (!tenantId) {
            log_1.log.warn({ event: "provider_resolution_failed", reason: "tenant_api_key_missing_tenant_id" }, "tenant LLM mode without tenant id");
            return resolvePlatformPlan();
        }
        if (!routing.tenantApiKeyConfigured) {
            log_1.log.warn({ event: "provider_resolution_failed", tenant_id: tenantId, reason: "tenant_api_key_not_configured" }, "tenant LLM mode but no API key configured");
            if (routing.tenantKeyErrorPolicy === "fail") {
                return { route: "fallback_error", resolutionSource: "tenant:missing_key", reason: "tenant_api_key_not_configured" };
            }
            return resolvePlatformPlan();
        }
        const secret = await (0, controlPlaneTenantSecrets_1.fetchTenantOpenAiApiKey)(tenantId);
        if (!secret || isDisallowedPlaceholderApiKey(secret)) {
            log_1.log.warn({ event: "provider_resolution_failed", tenant_id: tenantId, reason: "tenant_api_key_unavailable" }, "tenant LLM secret unavailable or invalid");
            if (routing.tenantKeyErrorPolicy === "fail") {
                return { route: "fallback_error", resolutionSource: "tenant:bad_secret", reason: "tenant_api_key_unavailable" };
            }
            return resolvePlatformPlan();
        }
        const meta = TENANT_LLM_PROVIDER_META[routing.tenantProvider];
        const model = routing.tenantModel?.trim() || meta.defaultModel;
        if (meta.api === "anthropic") {
            return {
                route: "anthropic_direct",
                resolutionSource: `tenant:${routing.tenantProvider}`,
                apiKey: secret,
                model,
            };
        }
        return {
            route: "openai_direct",
            resolutionSource: `tenant:${routing.tenantProvider}`,
            apiKey: secret,
            model,
            baseUrl: meta.baseUrl,
        };
    }
    if (tenantId === "demo-shop") {
        const baseUrl = (env_1.env.OPENAI_BASE_URL?.trim().replace(/\/$/, "") || "http://nemotron-nano-faithful-8082:8082/v1");
        const model = (tenantConfig?.llmRouting?.tenantModel?.trim() || ONPREM_MODEL);
        return {
            route: "openai_direct",
            resolutionSource: "tenant:demo-shop-nemotron",
            apiKey: "local-nemotron-demo-shop-key",
            model,
            baseUrl,
        };
    }
    return resolvePlatformPlan();
}
