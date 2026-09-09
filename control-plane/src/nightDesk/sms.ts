import { fetchWithTimeoutRetry } from "../httpClient";
import { secretStore } from "../secretStore";

export const TENANT_TELNYX_API_KEY = "tenant_telnyx_api_key";
export const TENANT_TELNYX_CONNECTION_ID = "tenant_telnyx_connection_id";
export const TENANT_TELNYX_PHONE_NUMBER = "tenant_telnyx_phone_number";
export const TENANT_TELNYX_PUBLIC_KEY = "tenant_telnyx_public_key";

export async function sendNightDeskSms(
  to: string,
  text: string,
  tenantId?: string,
): Promise<boolean> {
  const [tenantKey, tenantFrom] = tenantId
    ? await Promise.all([
        secretStore.getSecret(tenantId, TENANT_TELNYX_API_KEY),
        secretStore.getSecret(tenantId, TENANT_TELNYX_PHONE_NUMBER),
      ])
    : [undefined, undefined];
  const from = tenantFrom || process.env.TELNYX_PHONE_NUMBER;
  const apiKey = tenantKey || process.env.TELNYX_API_KEY;
  if (!from || !apiKey || !to) return false;
  try {
    const resp = await fetchWithTimeoutRetry("https://api.telnyx.com/v2/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ from, to, text }),
      timeoutMs: 10_000,
      retries: 1,
    });
    return resp.ok;
  } catch {
    return false;
  }
}
