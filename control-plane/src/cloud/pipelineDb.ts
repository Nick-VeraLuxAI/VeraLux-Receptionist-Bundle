import { PIPELINE_COMPONENTS, type PipelineEstimate, type RateCardPrice } from "@veralux/shared";
import { pool } from "../db";
import { SEED_RATE_CARD } from "./pricing/seedRateCard";

export type TenantPipelineRow = {
  tenantId: string;
  status: string;
  hostSku: string | null;
  telcoSku: string;
  sttSku: string | null;
  llmSku: string | null;
  ttsSku: string | null;
  assumptions: Record<string, unknown>;
  lastEstimate: PipelineEstimate | null;
  updatedAt: string;
};

export type TenantDeploymentRow = {
  id: string;
  tenantId: string;
  host: string;
  region: string | null;
  size: string | null;
  status: string;
  controlUrl: string | null;
  runtimeUrl: string | null;
  handles: Record<string, unknown>;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ProvisionJobRow = {
  id: string;
  tenantId: string;
  deploymentId: string | null;
  status: string;
  step: string | null;
  steps: unknown[];
  errorRedacted: string | null;
  createdAt: string;
  updatedAt: string;
};

export async function seedPipelineCatalog(): Promise<void> {
  for (const c of PIPELINE_COMPONENTS) {
    await pool.query(
      `INSERT INTO pipeline_components (sku, slot, provider, label, host_ok, onprem_ok, meta)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)
       ON CONFLICT (sku) DO UPDATE SET
         slot = EXCLUDED.slot,
         provider = EXCLUDED.provider,
         label = EXCLUDED.label,
         host_ok = EXCLUDED.host_ok,
         onprem_ok = EXCLUDED.onprem_ok,
         meta = EXCLUDED.meta`,
      [c.sku, c.slot, c.provider, c.label, c.hostOk, c.onpremOk, JSON.stringify({
        paidHostRequired: c.paidHostRequired || false,
        sttMode: c.sttMode,
        ttsMode: c.ttsMode,
        llmProvider: c.llmProvider,
        llmModel: c.llmModel,
        shortLabel: c.shortLabel,
        hostProvider: c.hostProvider,
        hostSize: c.hostSize,
      })],
    );
  }
}

export async function ensureSeedRateCard(): Promise<string> {
  const existing = await getLatestRateCard();
  if (!existing) {
    const inserted = await pool.query(
      `INSERT INTO rate_card_versions (prices, sources)
       VALUES ($1::jsonb, $2::jsonb) RETURNING id`,
      [JSON.stringify(SEED_RATE_CARD), JSON.stringify({ seed: { ok: true } })],
    );
    return inserted.rows[0].id as string;
  }
  const have = new Set(existing.prices.map((p) => `${p.sku}::${p.unit}`));
  const missing = SEED_RATE_CARD.filter((p) => !have.has(`${p.sku}::${p.unit}`));
  if (!missing.length) return existing.id;
  return commitRateCard(
    [...existing.prices, ...missing],
    { ...(existing.sources || {}), seed: { ok: true, added: missing.length } },
  );
}

export async function getLatestRateCard(): Promise<{ id: string; asOf: string; prices: RateCardPrice[]; sources: Record<string, unknown> } | null> {
  const res = await pool.query(
    "SELECT id, as_of, prices, sources FROM rate_card_versions ORDER BY as_of DESC LIMIT 1",
  );
  const row = res.rows[0];
  if (!row) return null;
  return {
    id: row.id,
    asOf: new Date(row.as_of).toISOString(),
    prices: row.prices as RateCardPrice[],
    sources: (row.sources || {}) as Record<string, unknown>,
  };
}

export async function commitRateCard(
  prices: RateCardPrice[],
  sources: Record<string, unknown>,
): Promise<string> {
  const inserted = await pool.query(
    `INSERT INTO rate_card_versions (prices, sources) VALUES ($1::jsonb, $2::jsonb) RETURNING id`,
    [JSON.stringify(prices), JSON.stringify(sources)],
  );
  return inserted.rows[0].id as string;
}

export async function listPriceOverrides(): Promise<Array<{ sku: string; unit: string; millicents: number; reason: string | null; setBy: string | null }>> {
  const res = await pool.query("SELECT sku, unit, millicents, reason, set_by FROM price_overrides");
  return res.rows.map((r) => ({
    sku: r.sku,
    unit: r.unit,
    millicents: Number(r.millicents),
    reason: r.reason,
    setBy: r.set_by,
  }));
}

export async function upsertPriceOverride(sku: string, unit: string, millicents: number | null, reason: string | null, setBy: string | null): Promise<void> {
  if (millicents === null) {
    await pool.query("DELETE FROM price_overrides WHERE sku = $1 AND unit = $2", [sku, unit]);
    return;
  }
  await pool.query(
    `INSERT INTO price_overrides (sku, unit, millicents, reason, set_by)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (sku, unit) DO UPDATE SET millicents = EXCLUDED.millicents, reason = EXCLUDED.reason, set_by = EXCLUDED.set_by, created_at = now()`,
    [sku, unit, millicents, reason, setBy],
  );
}

export async function insertPriceFeedRun(): Promise<string> {
  const res = await pool.query(
    `INSERT INTO price_feed_runs (status) VALUES ('running') RETURNING id`,
  );
  return res.rows[0].id as string;
}

export async function finishPriceFeedRun(
  id: string,
  status: "ok" | "partial" | "failed",
  sources: Record<string, unknown>,
  unmapped: unknown[],
  errorSummary: string | null,
  rateCardId: string | null,
): Promise<void> {
  await pool.query(
    `UPDATE price_feed_runs
     SET finished_at = now(), status = $2, sources = $3::jsonb, unmapped_keys = $4::jsonb,
         error_summary = $5, rate_card_id = $6
     WHERE id = $1`,
    [id, status, JSON.stringify(sources), JSON.stringify(unmapped), errorSummary, rateCardId],
  );
}

export async function getLatestPriceFeedRun(): Promise<Record<string, unknown> | null> {
  const res = await pool.query(
    `SELECT id, started_at, finished_at, status, sources, unmapped_keys, error_summary, rate_card_id
     FROM price_feed_runs ORDER BY started_at DESC LIMIT 1`,
  );
  const r = res.rows[0];
  if (!r) return null;
  return {
    id: r.id,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    status: r.status,
    sources: r.sources,
    unmappedKeys: r.unmapped_keys,
    errorSummary: r.error_summary,
    rateCardId: r.rate_card_id,
  };
}

export async function getTenantPipeline(tenantId: string): Promise<TenantPipelineRow | null> {
  const res = await pool.query(
    `SELECT tenant_id, status, host_sku, telco_sku, stt_sku, llm_sku, tts_sku, assumptions, last_estimate, updated_at
     FROM tenant_pipelines WHERE tenant_id = $1`,
    [tenantId],
  );
  const r = res.rows[0];
  if (!r) return null;
  return {
    tenantId: r.tenant_id,
    status: r.status,
    hostSku: r.host_sku,
    telcoSku: r.telco_sku,
    sttSku: r.stt_sku,
    llmSku: r.llm_sku,
    ttsSku: r.tts_sku,
    assumptions: r.assumptions || {},
    lastEstimate: r.last_estimate,
    updatedAt: new Date(r.updated_at).toISOString(),
  };
}

export async function upsertTenantPipeline(
  tenantId: string,
  patch: Partial<TenantPipelineRow> & { lastEstimate?: PipelineEstimate | null },
): Promise<TenantPipelineRow> {
  const current = await getTenantPipeline(tenantId);
  const next = {
    status: patch.status ?? current?.status ?? "draft",
    hostSku: patch.hostSku !== undefined ? patch.hostSku : current?.hostSku ?? null,
    telcoSku: patch.telcoSku ?? current?.telcoSku ?? "telnyx:inbound",
    sttSku: patch.sttSku !== undefined ? patch.sttSku : current?.sttSku ?? null,
    llmSku: patch.llmSku !== undefined ? patch.llmSku : current?.llmSku ?? null,
    ttsSku: patch.ttsSku !== undefined ? patch.ttsSku : current?.ttsSku ?? null,
    assumptions: patch.assumptions ?? current?.assumptions ?? {},
    lastEstimate: patch.lastEstimate !== undefined ? patch.lastEstimate : current?.lastEstimate ?? null,
  };
  await pool.query(
    `INSERT INTO tenant_pipelines (tenant_id, status, host_sku, telco_sku, stt_sku, llm_sku, tts_sku, assumptions, last_estimate, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb, now())
     ON CONFLICT (tenant_id) DO UPDATE SET
       status = EXCLUDED.status,
       host_sku = EXCLUDED.host_sku,
       telco_sku = EXCLUDED.telco_sku,
       stt_sku = EXCLUDED.stt_sku,
       llm_sku = EXCLUDED.llm_sku,
       tts_sku = EXCLUDED.tts_sku,
       assumptions = EXCLUDED.assumptions,
       last_estimate = EXCLUDED.last_estimate,
       updated_at = now()`,
    [
      tenantId,
      next.status,
      next.hostSku,
      next.telcoSku,
      next.sttSku,
      next.llmSku,
      next.ttsSku,
      JSON.stringify(next.assumptions),
      next.lastEstimate ? JSON.stringify(next.lastEstimate) : null,
    ],
  );
  const saved = await getTenantPipeline(tenantId);
  if (!saved) throw new Error("pipeline_upsert_failed");
  return saved;
}

function mapDeployment(r: Record<string, unknown>): TenantDeploymentRow {
  return {
    id: String(r.id),
    tenantId: String(r.tenant_id),
    host: String(r.host),
    region: r.region ? String(r.region) : null,
    size: r.size ? String(r.size) : null,
    status: String(r.status),
    controlUrl: r.control_url ? String(r.control_url) : null,
    runtimeUrl: r.runtime_url ? String(r.runtime_url) : null,
    handles: (r.handles || {}) as Record<string, unknown>,
    lastError: r.last_error ? String(r.last_error) : null,
    createdAt: new Date(String(r.created_at)).toISOString(),
    updatedAt: new Date(String(r.updated_at)).toISOString(),
  };
}

export async function getActiveDeployment(tenantId: string): Promise<TenantDeploymentRow | null> {
  const res = await pool.query(
    `SELECT * FROM tenant_deployments
     WHERE tenant_id = $1 AND status IN ('pending','provisioning','ready')
     ORDER BY created_at DESC LIMIT 1`,
    [tenantId],
  );
  return res.rows[0] ? mapDeployment(res.rows[0]) : null;
}

export async function getDeployment(tenantId: string, id: string): Promise<TenantDeploymentRow | null> {
  const res = await pool.query(
    `SELECT * FROM tenant_deployments WHERE tenant_id = $1 AND id = $2`,
    [tenantId, id],
  );
  return res.rows[0] ? mapDeployment(res.rows[0]) : null;
}

export async function insertDeployment(row: {
  tenantId: string;
  host: string;
  region?: string | null;
  size?: string | null;
}): Promise<TenantDeploymentRow> {
  const res = await pool.query(
    `INSERT INTO tenant_deployments (tenant_id, host, region, size, status)
     VALUES ($1,$2,$3,$4,'pending') RETURNING *`,
    [row.tenantId, row.host, row.region ?? null, row.size ?? null],
  );
  return mapDeployment(res.rows[0]);
}

export async function updateDeployment(
  id: string,
  patch: Partial<Pick<TenantDeploymentRow, "status" | "controlUrl" | "runtimeUrl" | "lastError">> & { handles?: Record<string, unknown> },
): Promise<void> {
  await pool.query(
    `UPDATE tenant_deployments SET
       status = COALESCE($2, status),
       control_url = COALESCE($3, control_url),
       runtime_url = COALESCE($4, runtime_url),
       handles = COALESCE($5::jsonb, handles),
       last_error = $6,
       updated_at = now()
     WHERE id = $1`,
    [id, patch.status ?? null, patch.controlUrl ?? null, patch.runtimeUrl ?? null, patch.handles ? JSON.stringify(patch.handles) : null, patch.lastError ?? null],
  );
}

export async function insertProvisionJob(tenantId: string, deploymentId: string): Promise<ProvisionJobRow> {
  const res = await pool.query(
    `INSERT INTO provision_jobs (tenant_id, deployment_id, status, step, steps)
     VALUES ($1,$2,'queued','queued','[]'::jsonb) RETURNING *`,
    [tenantId, deploymentId],
  );
  const r = res.rows[0];
  return {
    id: r.id,
    tenantId: r.tenant_id,
    deploymentId: r.deployment_id,
    status: r.status,
    step: r.step,
    steps: r.steps || [],
    errorRedacted: r.error_redacted,
    createdAt: new Date(r.created_at).toISOString(),
    updatedAt: new Date(r.updated_at).toISOString(),
  };
}

export async function updateProvisionJob(
  id: string,
  patch: { status?: string; step?: string; steps?: unknown[]; errorRedacted?: string | null },
): Promise<void> {
  await pool.query(
    `UPDATE provision_jobs SET
       status = COALESCE($2, status),
       step = COALESCE($3, step),
       steps = COALESCE($4::jsonb, steps),
       error_redacted = $5,
       updated_at = now()
     WHERE id = $1`,
    [id, patch.status ?? null, patch.step ?? null, patch.steps ? JSON.stringify(patch.steps) : null, patch.errorRedacted ?? null],
  );
}

export async function getLatestProvisionJobForDeployment(deploymentId: string): Promise<ProvisionJobRow | null> {
  const res = await pool.query(
    `SELECT * FROM provision_jobs WHERE deployment_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [deploymentId],
  );
  const r = res.rows[0];
  if (!r) return null;
  return {
    id: r.id,
    tenantId: r.tenant_id,
    deploymentId: r.deployment_id,
    status: r.status,
    step: r.step,
    steps: r.steps || [],
    errorRedacted: r.error_redacted,
    createdAt: new Date(r.created_at).toISOString(),
    updatedAt: new Date(r.updated_at).toISOString(),
  };
}

export async function getProvisionJob(id: string): Promise<ProvisionJobRow | null> {
  const res = await pool.query(`SELECT * FROM provision_jobs WHERE id = $1`, [id]);
  const r = res.rows[0];
  if (!r) return null;
  return {
    id: r.id,
    tenantId: r.tenant_id,
    deploymentId: r.deployment_id,
    status: r.status,
    step: r.step,
    steps: r.steps || [],
    errorRedacted: r.error_redacted,
    createdAt: new Date(r.created_at).toISOString(),
    updatedAt: new Date(r.updated_at).toISOString(),
  };
}
