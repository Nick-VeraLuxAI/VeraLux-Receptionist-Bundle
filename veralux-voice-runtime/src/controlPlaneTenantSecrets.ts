import { TENANT_LLM_OPENAI_SECRET_KEY } from '@veralux/shared';
import { env } from './env';
import { log } from './log';

const cache = new Map<string, { at: number; value: string | null }>();
const TTL_MS = 45_000;

export async function fetchTenantOpenAiApiKey(tenantId: string): Promise<string | null> {
  const base = env.CONTROL_PLANE_URL?.trim();
  const apiKey = env.CONTROL_PLANE_API_KEY?.trim();
  if (!base || !apiKey) {
    log.warn({ event: 'tenant_llm_secret_skip', reason: 'control_plane_not_configured', tenant_id: tenantId });
    return null;
  }
  const now = Date.now();
  const hit = cache.get(tenantId);
  if (hit && now - hit.at < TTL_MS) {
    return hit.value;
  }
  const url = `${base.replace(/\/$/, '')}/api/runtime/tenants/${encodeURIComponent(tenantId)}/secrets/llm_openai_api_key`;
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      log.warn(
        { event: 'tenant_llm_secret_fetch_failed', tenant_id: tenantId, status: res.status },
        'control plane tenant llm secret fetch failed',
      );
      cache.set(tenantId, { at: now, value: null });
      return null;
    }
    const body = (await res.json()) as { apiKey?: unknown };
    const v = typeof body.apiKey === 'string' && body.apiKey.trim() ? body.apiKey.trim() : null;
    cache.set(tenantId, { at: now, value: v });
    return v;
  } catch (e) {
    log.warn(
      { err: e, event: 'tenant_llm_secret_fetch_error', tenant_id: tenantId },
      'control plane tenant llm secret fetch error',
    );
    cache.set(tenantId, { at: now, value: null });
    return null;
  }
}

export function invalidateTenantOpenAiApiKeyCache(tenantId: string): void {
  cache.delete(tenantId);
}

export { TENANT_LLM_OPENAI_SECRET_KEY };
