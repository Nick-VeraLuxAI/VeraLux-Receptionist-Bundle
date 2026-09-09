import type { Express, NextFunction, Request, Response } from "express";
import { z } from "zod";
import {
  PIPELINE_COMPONENTS_SELECTABLE,
  KOKORO_TTS_SKU,
  componentBySku,
  estimatePipeline,
  isSelectablePipelineComponent,
  normalizeAssumptions,
} from "@veralux/shared";
type AuthedRequest = Request & { ctx?: { isSuperAdmin?: boolean; email?: string } };
import {
  ensureSeedRateCard,
  getActiveDeployment,
  getLatestPriceFeedRun,
  getLatestProvisionJobForDeployment,
  getLatestRateCard,
  getTenantPipeline,
  seedPipelineCatalog,
  upsertPriceOverride,
  upsertTenantPipeline,
} from "./pipelineDb";
import { applyOverridesToLatestCard, freshnessFromRun, isPriceRefreshEnabled, refreshPrices } from "./pricing/refresh";
import { applyPipelineToTenant } from "./applyPipeline";
import { pollDeployment, startProvision, teardownDeployment } from "./provisioner";
import { hostCredentialStatus, setHostCredential } from "./hosts/credentials";

type Guard = (req: Request, res: Response, next: NextFunction) => unknown;

function coerceSelectableTtsSku(sku: string | undefined): string | undefined {
  if (!sku) return sku;
  const c = componentBySku(sku);
  if (c && isSelectablePipelineComponent(c)) return sku;
  return KOKORO_TTS_SKU;
}

const estimateBody = z.object({
  hostSku: z.string().min(1),
  telcoSku: z.string().optional(),
  sttSku: z.string().min(1),
  llmSku: z.string().min(1),
  ttsSku: z.string().min(1),
  assumedMonthlyMinutes: z.number().optional(),
  callerTalkRatio: z.number().optional(),
  assistantTalkRatio: z.number().optional(),
  llmInputTokensPerMin: z.number().optional(),
  llmOutputTokensPerMin: z.number().optional(),
  ttsCharsPerMin: z.number().optional(),
  retailMarginBps: z.number().optional(),
  replyTokensPerTurn: z.number().optional(),
});

async function currentCardAndFreshness() {
  await seedPipelineCatalog();
  await ensureSeedRateCard();
  const card = await getLatestRateCard();
  const run = await getLatestPriceFeedRun();
  return { card, freshness: freshnessFromRun(run), run };
}

export function registerPipelineRoutes(
  app: Express,
  deps: {
    adminGuard: (role: "admin" | "viewer") => Guard;
    requireSuperAdmin: (req: AuthedRequest, res: Response) => boolean;
    ensureTenantAccess: (req: Request, res: Response, tenantId: string) => boolean;
  },
): void {
  const { adminGuard, requireSuperAdmin, ensureTenantAccess } = deps;

  app.get("/api/admin/pipeline/catalog", adminGuard("admin"), async (_req, res) => {
    const { card, freshness, run } = await currentCardAndFreshness();
    res.json({
      components: PIPELINE_COMPONENTS_SELECTABLE,
      rateCard: card,
      freshness,
      refreshEnabled: isPriceRefreshEnabled(),
      hostCredentials: await hostCredentialStatus(),
      unmappedKeys: (run?.unmappedKeys as unknown[]) || [],
    });
  });

  app.post("/api/admin/pipeline/estimate", adminGuard("admin"), async (req, res) => {
    const parsed = estimateBody.safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({ error: "invalid_body", details: parsed.error.issues });
    const { card, freshness } = await currentCardAndFreshness();
    const selection = { ...parsed.data, ttsSku: coerceSelectableTtsSku(parsed.data.ttsSku) || parsed.data.ttsSku };
    const estimate = estimatePipeline(selection, card?.prices || [], normalizeAssumptions(selection));
    res.json({ estimate, freshness, rateCardAsOf: card?.asOf || null });
  });

  app.get("/api/admin/pipeline/pricing", adminGuard("admin"), async (_req, res) => {
    const { card, freshness, run } = await currentCardAndFreshness();
    res.json({ rateCard: card, lastRun: run, freshness, refreshEnabled: isPriceRefreshEnabled() });
  });

  app.post("/api/admin/pipeline/pricing/refresh", adminGuard("admin"), async (req: AuthedRequest, res) => {
    if (!requireSuperAdmin(req, res)) return;
    const result = await refreshPrices("manual");
    res.json(result);
  });

  app.put("/api/admin/pipeline/pricing/overrides", adminGuard("admin"), async (req: AuthedRequest, res) => {
    if (!requireSuperAdmin(req, res)) return;
    const body = z.object({
      sku: z.string().min(1),
      unit: z.enum(["per_minute", "per_1m_input_tokens", "per_1m_output_tokens", "per_1k_chars", "per_month"]),
      millicents: z.number().int().nullable(),
      reason: z.string().max(400).optional(),
    }).safeParse(req.body || {});
    if (!body.success) return res.status(400).json({ error: "invalid_body" });
    await upsertPriceOverride(body.data.sku, body.data.unit, body.data.millicents, body.data.reason || null, req.ctx?.email || "admin");
    await applyOverridesToLatestCard();
    res.json({ ok: true });
  });

  app.get("/api/admin/pipeline/host-credentials", adminGuard("admin"), async (req: AuthedRequest, res) => {
    if (!requireSuperAdmin(req, res)) return;
    res.json(await hostCredentialStatus());
  });

  app.put("/api/admin/pipeline/host-credentials", adminGuard("admin"), async (req: AuthedRequest, res) => {
    if (!requireSuperAdmin(req, res)) return;
    const body = z.object({
      renderApiKey: z.string().max(512).optional().nullable(),
      railwayToken: z.string().max(512).optional().nullable(),
      awsAccessKeyId: z.string().max(128).optional().nullable(),
      awsSecretAccessKey: z.string().max(256).optional().nullable(),
      awsRegion: z.string().max(64).optional().nullable(),
    }).safeParse(req.body || {});
    if (!body.success) return res.status(400).json({ error: "invalid_body" });
    const b = body.data;
    if (b.renderApiKey !== undefined) await setHostCredential("render_api_key", b.renderApiKey);
    if (b.railwayToken !== undefined) await setHostCredential("railway_token", b.railwayToken);
    if (b.awsAccessKeyId !== undefined) await setHostCredential("aws_access_key_id", b.awsAccessKeyId);
    if (b.awsSecretAccessKey !== undefined) await setHostCredential("aws_secret_access_key", b.awsSecretAccessKey);
    if (b.awsRegion !== undefined) await setHostCredential("aws_region", b.awsRegion);
    res.json(await hostCredentialStatus());
  });

  app.get("/api/admin/tenants/:tenantId/pipeline", adminGuard("admin"), async (req, res) => {
    const tenantId = String(req.params.tenantId || "");
    if (!ensureTenantAccess(req, res, tenantId)) return;
    const pipeline = await getTenantPipeline(tenantId);
    const deployment = await getActiveDeployment(tenantId);
    const job = deployment ? await getLatestProvisionJobForDeployment(deployment.id) : null;
    res.json({ pipeline, deployment, job });
  });

  app.put("/api/admin/tenants/:tenantId/pipeline", adminGuard("admin"), async (req, res) => {
    const tenantId = String(req.params.tenantId || "");
    if (!ensureTenantAccess(req, res, tenantId)) return;
    const parsed = estimateBody.partial().extend({
      hostSku: z.string().optional(),
      sttSku: z.string().optional(),
      llmSku: z.string().optional(),
      ttsSku: z.string().optional(),
    }).safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({ error: "invalid_body" });
    const ttsSku = coerceSelectableTtsSku(parsed.data.ttsSku) || parsed.data.ttsSku;
    const { card } = await currentCardAndFreshness();
    const assumptions = normalizeAssumptions(parsed.data);
    let lastEstimate = null;
    if (parsed.data.hostSku && parsed.data.sttSku && parsed.data.llmSku && ttsSku) {
      lastEstimate = estimatePipeline(
        {
          hostSku: parsed.data.hostSku,
          telcoSku: parsed.data.telcoSku,
          sttSku: parsed.data.sttSku,
          llmSku: parsed.data.llmSku,
          ttsSku,
        },
        card?.prices || [],
        assumptions,
      );
    }
    const pipeline = await upsertTenantPipeline(tenantId, {
      hostSku: parsed.data.hostSku,
      telcoSku: parsed.data.telcoSku,
      sttSku: parsed.data.sttSku,
      llmSku: parsed.data.llmSku,
      ttsSku,
      assumptions,
      lastEstimate,
      status: lastEstimate ? "estimated" : "draft",
    });
    res.json({ pipeline });
  });

  app.post("/api/admin/tenants/:tenantId/pipeline/apply", adminGuard("admin"), async (req: AuthedRequest, res) => {
    const tenantId = String(req.params.tenantId || "");
    if (!ensureTenantAccess(req, res, tenantId)) return;
    const pipeline = await getTenantPipeline(tenantId);
    if (!pipeline) return res.status(400).json({ error: "pipeline_not_saved" });
    const copyRetail = Boolean((req.body || {}).copyRetailToOverage);
    const result = await applyPipelineToTenant(
      tenantId,
      { sttSku: pipeline.sttSku, llmSku: pipeline.llmSku, ttsSku: pipeline.ttsSku, hostSku: pipeline.hostSku },
      { copyRetailToOverage: copyRetail, estimate: pipeline.lastEstimate, actor: req.ctx?.email || "admin", hostSku: pipeline.hostSku },
    );
    res.json({ ok: true, ...result });
  });

  app.post("/api/admin/tenants/:tenantId/deployments", adminGuard("admin"), async (req: AuthedRequest, res) => {
    if (!requireSuperAdmin(req, res)) return;
    const tenantId = String(req.params.tenantId || "");
    if (!ensureTenantAccess(req, res, tenantId)) return;
    const pipeline = await getTenantPipeline(tenantId);
    const hostSku = String((req.body || {}).hostSku || pipeline?.hostSku || "");
    const host = componentBySku(hostSku);
    if (!host || host.slot !== "host") return res.status(400).json({ error: "host_sku_required" });
    if (!host.paidHostRequired || !host.hostProvider) {
      return res.status(400).json({ error: "onprem_host_not_provisionable" });
    }
    if (host.hostSize === "free") return res.status(400).json({ error: "free_tier_forbidden" });
    try {
      const started = await startProvision({ tenantId, hostSku, region: (req.body || {}).region });
      await upsertTenantPipeline(tenantId, { status: "provisioning", hostSku });
      res.status(202).json(started);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg === "deployment_already_active") return res.status(409).json({ error: msg });
      if (
        msg === "onprem_host_not_provisionable" ||
        msg === "invalid_host_sku" ||
        msg === "free_tier_forbidden"
      ) {
        return res.status(400).json({ error: msg });
      }
      if (msg.includes("credentials") || msg.includes("missing")) return res.status(400).json({ error: msg });
      return res.status(500).json({ error: "provision_failed", message: msg });
    }
  });

  app.get("/api/admin/tenants/:tenantId/deployments/:id", adminGuard("admin"), async (req, res) => {
    const tenantId = String(req.params.tenantId || "");
    if (!ensureTenantAccess(req, res, tenantId)) return;
    const row = await pollDeployment(tenantId, String(req.params.id));
    if (!row) return res.status(404).json({ error: "not_found" });
    res.json({ deployment: row });
  });

  app.delete("/api/admin/tenants/:tenantId/deployments/:id", adminGuard("admin"), async (req: AuthedRequest, res) => {
    if (!requireSuperAdmin(req, res)) return;
    const tenantId = String(req.params.tenantId || "");
    if (!ensureTenantAccess(req, res, tenantId)) return;
    await teardownDeployment(tenantId, String(req.params.id));
    await upsertTenantPipeline(tenantId, { status: "draft" });
    res.json({ ok: true });
  });
}
