import { componentBySku, isTenantLlmProvider, type PipelineEstimate } from "@veralux/shared";
import { tenants } from "../tenants";
import { applyTenantLlmPortalPatch } from "../tenantLlmHandlers";
import { upsertTenantLimits } from "../db";
import { autoPublishTenantRuntimeAfterSave } from "../tenantRuntimePublish";
import type { SttMode } from "../config";
import { getActiveDeployment, type TenantDeploymentRow } from "./pipelineDb";
import { loadDeploymentAdminKey } from "./provisioner";
import { applyPipelineToRemote, type RemoteApplyResult } from "./applyRemote";

export type ApplyPipelineResult = {
  published: boolean;
  publishError?: string;
  remoteApplied?: boolean;
  remoteApplyError?: string;
};

export type ApplyPipelineOptions = {
  copyRetailToOverage?: boolean;
  estimate?: PipelineEstimate | null;
  actor?: string;
  hostSku?: string | null;
  fetchImpl?: typeof fetch;
  getReadyDeployment?: (tenantId: string) => Promise<TenantDeploymentRow | null>;
  loadAdminKey?: (deploymentId: string) => Promise<string | undefined>;
  applyRemote?: typeof applyPipelineToRemote;
  publish?: (tenantId: string, ctx: { settingArea: string; actorRole: string }) => Promise<{ published: boolean; publishError?: string }>;
};

export async function applyReadyDeploymentRemote(
  tenantId: string,
  skus: { sttSku?: string | null; llmSku?: string | null; ttsSku?: string | null; hostSku?: string | null },
  options?: ApplyPipelineOptions,
): Promise<{ remoteApplied?: boolean; remoteApplyError?: string }> {
  const dep = options?.getReadyDeployment
    ? await options.getReadyDeployment(tenantId)
    : await getActiveDeployment(tenantId);
  if (!dep || dep.status !== "ready" || !dep.controlUrl) return {};
  const loadKey = options?.loadAdminKey || loadDeploymentAdminKey;
  const adminApiKey = await loadKey(dep.id);
  if (!adminApiKey) return { remoteApplied: false, remoteApplyError: "remote_admin_key_missing" };
  let tenantName = tenantId;
  let numbers: string[] = [];
  try {
    const ctx = tenants.getOrCreate(tenantId);
    tenantName = ctx.meta.name || tenantId;
    numbers = ctx.meta.numbers || [];
  } catch {
    /* unit tests and pre-init Apply still push SKUs */
  }
  const applyRemote = options?.applyRemote || applyPipelineToRemote;
  const result: RemoteApplyResult = await applyRemote({
    controlUrl: dep.controlUrl,
    adminApiKey,
    tenantId,
    tenantName,
    numbers,
    skus: { ...skus, hostSku: skus.hostSku || options?.hostSku },
    fetchImpl: options?.fetchImpl,
  });
  if (!result.ok) return { remoteApplied: false, remoteApplyError: result.error || "remote_apply_failed" };
  return { remoteApplied: true };
}

export async function applyPipelineToTenant(
  tenantId: string,
  skus: { sttSku?: string | null; llmSku?: string | null; ttsSku?: string | null; hostSku?: string | null },
  options?: ApplyPipelineOptions,
): Promise<ApplyPipelineResult> {
  const ctx = tenants.getOrCreate(tenantId);

  if (skus.sttSku) {
    const stt = componentBySku(skus.sttSku);
    if (stt?.sttMode) {
      ctx.config.setSttConfig({
        mode: stt.sttMode as SttMode,
        model: stt.sku.includes("whisper-1") ? "whisper-1" : stt.sku.includes("nova-2") ? "nova-2" : undefined,
      });
    }
  }

  if (skus.ttsSku) {
    const tts = componentBySku(skus.ttsSku);
    if (tts?.ttsMode) {
      ctx.config.setTtsConfig({ ttsMode: "kokoro_http" });
    }
  }

  if (skus.llmSku) {
    const llm = componentBySku(skus.llmSku);
    if (llm?.llmProvider === "platform" || !llm?.llmProvider) {
      const { portal } = await applyTenantLlmPortalPatch(ctx, { mode: "platform_default" });
      tenants.mergeOperatorState(tenantId, { llmPortal: portal });
    } else if (llm.llmProvider && isTenantLlmProvider(llm.llmProvider)) {
      const { portal } = await applyTenantLlmPortalPatch(ctx, {
        mode: "tenant_api_key",
        tenantProvider: llm.llmProvider,
        tenantModel: llm.llmModel,
      });
      tenants.mergeOperatorState(tenantId, { llmPortal: portal });
    }
  }

  tenants.persistConfig(tenantId);

  if (options?.copyRetailToOverage && options.estimate) {
    const cents = Math.max(0, Math.round(options.estimate.retailPerMinuteCents));
    await upsertTenantLimits(tenantId, { monthlyMinuteOverageRateCents: cents }, options.actor || "pipeline");
  }

  const pub = options?.publish
    ? await options.publish(tenantId, { settingArea: "pipeline", actorRole: "admin" })
    : await autoPublishTenantRuntimeAfterSave(tenantId, { settingArea: "pipeline", actorRole: "admin" });
  const remote = await applyReadyDeploymentRemote(tenantId, skus, options);
  return { published: pub.published, publishError: pub.publishError, ...remote };
}
