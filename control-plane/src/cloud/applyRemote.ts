export type RemoteApplyResult = {
  ok: boolean;
  error?: string;
};

export async function applyPipelineToRemote(input: {
  controlUrl: string;
  adminApiKey: string;
  tenantId: string;
  tenantName?: string;
  numbers?: string[];
  skus: { sttSku?: string | null; llmSku?: string | null; ttsSku?: string | null; hostSku?: string | null };
  fetchImpl?: typeof fetch;
}): Promise<RemoteApplyResult> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const base = input.controlUrl.replace(/\/$/, "");
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-admin-key": input.adminApiKey,
    Authorization: `Bearer ${input.adminApiKey}`,
  };
  try {
    const createRes = await fetchImpl(`${base}/api/admin/tenants`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        id: input.tenantId,
        name: input.tenantName || input.tenantId,
        numbers: input.numbers || [],
      }),
    });
    if (!createRes.ok && createRes.status !== 409) {
      return { ok: false, error: `remote_tenant_upsert_${createRes.status}` };
    }
    const saveRes = await fetchImpl(`${base}/api/admin/tenants/${encodeURIComponent(input.tenantId)}/pipeline`, {
      method: "PUT",
      headers,
      body: JSON.stringify({
        hostSku: input.skus.hostSku || undefined,
        sttSku: input.skus.sttSku || undefined,
        llmSku: input.skus.llmSku || undefined,
        ttsSku: input.skus.ttsSku || undefined,
      }),
    });
    if (!saveRes.ok) return { ok: false, error: `remote_pipeline_save_${saveRes.status}` };
    const applyRes = await fetchImpl(`${base}/api/admin/tenants/${encodeURIComponent(input.tenantId)}/pipeline/apply`, {
      method: "POST",
      headers,
      body: JSON.stringify({}),
    });
    if (!applyRes.ok) return { ok: false, error: `remote_pipeline_apply_${applyRes.status}` };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message.slice(0, 240) : "remote_apply_failed" };
  }
}
