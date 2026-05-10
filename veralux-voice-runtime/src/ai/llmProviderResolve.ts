import type { RuntimeTenantConfig } from '@veralux/shared';
import { env } from '../env';
import { log } from '../log';
import { fetchTenantOpenAiApiKey } from '../controlPlaneTenantSecrets';

export type PlatformLlmKind = 'brain_local' | 'brain_http' | 'openai';

export type LlmExecutionPlan =
  | { route: 'brain_local'; resolutionSource: string }
  | { route: 'brain_http'; resolutionSource: string; baseUrl: string }
  | { route: 'openai_direct'; resolutionSource: string; apiKey: string; model: string; baseUrl: string }
  | { route: 'fallback_error'; resolutionSource: string; reason: string };

export function isDisallowedPlaceholderApiKey(key: string | undefined): boolean {
  if (!key?.trim()) return true;
  const t = key.trim();
  if (/^CHANGE_ME/i.test(t)) return true;
  if (/^PASTE_/i.test(t)) return true;
  if (/^sk-test/i.test(t)) return true;
  if (t === 'EMPTY' || t === 'your-api-key-here') return true;
  return false;
}

export function normalizePlatformLlmKind(raw: string | undefined): PlatformLlmKind {
  const p = (raw || '').trim().toLowerCase();
  if (!p || p === 'brain' || p === 'local' || p === 'brain_local') return 'brain_local';
  if (p === 'brain_http' || p === 'http_brain' || p === 'remote_brain') return 'brain_http';
  if (p === 'openai' || p === 'gpt' || p === 'chatgpt') return 'openai';
  return 'brain_local';
}

/** Exported for strict health checks (platform OpenAI key validity). */
export function effectiveVoicePlatformLlmRaw(): string {
  const explicit = env.PLATFORM_LLM_PROVIDER?.trim();
  if (explicit) return explicit;
  const legacy = env.LLM_PROVIDER?.trim();
  return legacy || 'brain_local';
}

async function resolvePlatformPlan(): Promise<LlmExecutionPlan> {
  const kind = normalizePlatformLlmKind(effectiveVoicePlatformLlmRaw());
  if (kind === 'brain_local') {
    return { route: 'brain_local', resolutionSource: 'platform:brain_local' };
  }
  if (kind === 'brain_http') {
    const base = env.BRAIN_URL?.trim();
    if (!base) {
      log.warn(
        { event: 'provider_resolution_failed', reason: 'brain_http_missing_brain_url' },
        'platform brain_http selected but BRAIN_URL missing — falling back to local brain',
      );
      return { route: 'brain_local', resolutionSource: 'platform:fallback_no_brain_url' };
    }
    return { route: 'brain_http', resolutionSource: 'platform:brain_http', baseUrl: base };
  }
  const key = env.OPENAI_API_KEY?.trim();
  if (isDisallowedPlaceholderApiKey(key)) {
    log.warn(
      { event: 'provider_resolution_failed', reason: 'openai_invalid_platform_key' },
      'platform openai selected but OPENAI_API_KEY missing/placeholder — falling back to local brain',
    );
    return { route: 'brain_local', resolutionSource: 'platform:fallback_invalid_openai_key' };
  }
  const model = env.OPENAI_MODEL?.trim() || 'gpt-4o-mini';
  const baseUrl = (env.OPENAI_BASE_URL?.trim().replace(/\/$/, '') || 'https://api.openai.com/v1') + '';
  return {
    route: 'openai_direct',
    resolutionSource: 'platform:openai',
    apiKey: key!,
    model,
    baseUrl,
  };
}

/**
 * Resolve which LLM path a call should use. Tenant API key overrides platform when configured.
 */
export async function resolveLlmExecutionPlan(args: {
  tenantId?: string;
  tenantConfig?: RuntimeTenantConfig | null;
}): Promise<LlmExecutionPlan> {
  const { tenantId, tenantConfig } = args;
  const routing = tenantConfig?.llmRouting;

  if (routing?.mode === 'tenant_api_key' && routing.tenantProvider === 'openai') {
    if (!tenantId) {
      log.warn({ event: 'provider_resolution_failed', reason: 'tenant_api_key_missing_tenant_id' }, 'tenant LLM mode without tenant id');
      return resolvePlatformPlan();
    }
    if (!routing.tenantApiKeyConfigured) {
      log.warn(
        { event: 'provider_resolution_failed', tenant_id: tenantId, reason: 'tenant_api_key_not_configured' },
        'tenant LLM mode but no API key configured',
      );
      if (routing.tenantKeyErrorPolicy === 'fail') {
        return { route: 'fallback_error', resolutionSource: 'tenant:missing_key', reason: 'tenant_api_key_not_configured' };
      }
      return resolvePlatformPlan();
    }
    const secret = await fetchTenantOpenAiApiKey(tenantId);
    if (!secret || isDisallowedPlaceholderApiKey(secret)) {
      log.warn(
        { event: 'provider_resolution_failed', tenant_id: tenantId, reason: 'tenant_api_key_unavailable' },
        'tenant OpenAI secret unavailable or invalid',
      );
      if (routing.tenantKeyErrorPolicy === 'fail') {
        return { route: 'fallback_error', resolutionSource: 'tenant:bad_secret', reason: 'tenant_api_key_unavailable' };
      }
      return resolvePlatformPlan();
    }
    const model = routing.tenantModel?.trim() || env.OPENAI_MODEL?.trim() || 'gpt-4o-mini';
    const baseUrl = (env.OPENAI_BASE_URL?.trim().replace(/\/$/, '') || 'https://api.openai.com/v1') + '';
    return {
      route: 'openai_direct',
      resolutionSource: 'tenant:openai',
      apiKey: secret,
      model,
      baseUrl,
    };
  }

  return resolvePlatformPlan();
}
