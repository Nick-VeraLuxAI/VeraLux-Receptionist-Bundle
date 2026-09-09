import { env } from "../env";
import { fetchWithTimeoutRetry } from "../httpClient";
import { log } from "../log";

type TenantCredential = {
  apiKey?: string;
  connectionId?: string;
  phoneNumber?: string;
  expiresAt: number;
};

const tenantCache = new Map<string, TenantCredential>();
const callApiKeys = new Map<string, string>();

async function loadTenantCredential(
  tenantId: string,
): Promise<TenantCredential> {
  const cached = tenantCache.get(tenantId);
  if (cached && cached.expiresAt > Date.now()) return cached;
  if (!env.CONTROL_PLANE_URL || !env.CONTROL_PLANE_API_KEY) {
    return { expiresAt: Date.now() + 60_000 };
  }
  try {
    const url = `${env.CONTROL_PLANE_URL}/api/runtime/tenant-telnyx-credentials?tenantId=${encodeURIComponent(
      tenantId,
    )}`;
    const response = await fetchWithTimeoutRetry(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${env.CONTROL_PLANE_API_KEY}`,
      },
      timeoutMs: 4_000,
      retries: 0,
    });
    if (!response.ok) {
      throw new Error(`tenant_telnyx_credentials_http_${response.status}`);
    }
    const body = (await response.json()) as {
      configured?: boolean;
      apiKey?: string | null;
      connectionId?: string | null;
      phoneNumber?: string | null;
    };
    const value: TenantCredential = {
      apiKey: body.configured && body.apiKey ? body.apiKey : undefined,
      connectionId: body.connectionId || undefined,
      phoneNumber: body.phoneNumber || undefined,
      expiresAt: Date.now() + 5 * 60_000,
    };
    tenantCache.set(tenantId, value);
    return value;
  } catch (error) {
    log.warn(
      {
        event: "tenant_telnyx_credentials_failed",
        tenant_id: tenantId,
        err: error instanceof Error ? error.message : String(error),
      },
      "falling back to platform Telnyx credential",
    );
    return { expiresAt: Date.now() + 30_000 };
  }
}

export async function bindTenantTelnyxCredential(
  callControlId: string,
  tenantId: string,
): Promise<void> {
  const credential = await loadTenantCredential(tenantId);
  if (credential.apiKey) {
    callApiKeys.set(callControlId, credential.apiKey);
  }
}

export function telnyxApiKeyForCall(callControlId?: unknown): string {
  return (
    (typeof callControlId === "string"
      ? callApiKeys.get(callControlId)
      : undefined) || env.TELNYX_API_KEY
  );
}

export function releaseTenantTelnyxCredential(
  callControlId: string,
): void {
  callApiKeys.delete(callControlId);
}
