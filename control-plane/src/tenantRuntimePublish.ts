/**
 * Full tenant runtime config rebuild + Redis publish (same contract as
 * POST /api/admin/runtime/tenants/:id/publish-from-tenant).
 *
 * Used after settings mutations so operators get one-click save → live
 * without a separate manual sync (when ENABLE_RUNTIME_ADMIN is on).
 */
import type { RuntimeCallQuality } from "@veralux/shared";
import { tenants } from "./tenants";
import { getTenantConfig, publishTenantConfig } from "./runtime/runtimePublisher";
import { buildTenantRuntimeConfig, BuildRuntimeConfigError } from "./runtime/buildTenantRuntimeConfig";
import {
  getTenantLimits,
  getTenantCallQualitySettings,
  expireStaleRawAudioDiagnostics,
} from "./db";
import { tenantCallQualityRowToRuntime } from "./callQualityMaps";
import { logger } from "./middleware";

function parseRuntimeAdminEnabled(): boolean {
  const v = process.env.ENABLE_RUNTIME_ADMIN;
  if (typeof v !== "string" || !v.trim()) return true;
  const normalized = v.trim().toLowerCase();
  if (["1", "true", "yes", "on", "required"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return true;
}

const ENABLE_RUNTIME_ADMIN = parseRuntimeAdminEnabled();

/** Rebuild from Postgres + publish to Redis (throws on failure). */
export async function syncTenantRuntimeConfigForLimits(tenantId: string): Promise<void> {
  if (!ENABLE_RUNTIME_ADMIN) return;
  const tenant = tenants.getOrCreate(tenantId);
  let existing: Awaited<ReturnType<typeof getTenantConfig>> = null;
  try {
    existing = await getTenantConfig(tenantId);
  } catch {
    existing = null;
  }
  const limits = await getTenantLimits(tenantId);
  let cq: RuntimeCallQuality | null = null;
  try {
    await expireStaleRawAudioDiagnostics();
    cq = tenantCallQualityRowToRuntime(await getTenantCallQualitySettings(tenantId));
  } catch (e) {
    logger.warn("call_quality_settings_unavailable", {
      tenantId,
      err: e instanceof Error ? e.message : String(e),
    });
  }
  const parsed = buildTenantRuntimeConfig(tenant, existing, limits, cq);
  await publishTenantConfig(tenantId, parsed);
}

export async function trySyncTenantRuntimeConfigForLimits(tenantId: string): Promise<boolean> {
  try {
    await syncTenantRuntimeConfigForLimits(tenantId);
    return true;
  } catch (error) {
    logger.warn("limits runtime sync failed", { tenantId, err: error });
    return false;
  }
}

export type AutoPublishResult = {
  published: boolean;
  lastRuntimePublishedAt: string | null;
  publishError?: string;
  publishErrorCode?: string;
  publishSkippedReason?: "runtime_admin_disabled";
};

/**
 * After a successful DB/settings mutation, push the latest tenant state to Redis.
 * Does not roll back the mutation if publish fails.
 */
export async function autoPublishTenantRuntimeAfterSave(
  tenantId: string,
  meta: { settingArea: string; actorRole?: string },
): Promise<AutoPublishResult> {
  if (!ENABLE_RUNTIME_ADMIN) {
    logger.info("tenant_settings_auto_publish_skipped", {
      event: "tenant_settings_auto_publish_skipped",
      tenantId,
      settingArea: meta.settingArea,
      reason: "runtime_admin_disabled",
      actorRole: meta.actorRole ?? "unknown",
    });
    return {
      published: false,
      lastRuntimePublishedAt: null,
      publishSkippedReason: "runtime_admin_disabled",
    };
  }

  logger.info("tenant_settings_auto_publish_attempt", {
    event: "tenant_settings_auto_publish_attempt",
    tenantId,
    settingArea: meta.settingArea,
    actorRole: meta.actorRole ?? "unknown",
  });

  try {
    await syncTenantRuntimeConfigForLimits(tenantId);
    const cfg = await getTenantConfig(tenantId);
    const lastRuntimePublishedAt = cfg?.lastRuntimePublishedAt ?? null;
    logger.info("tenant_settings_auto_publish_success", {
      event: "tenant_settings_auto_publish_success",
      tenantId,
      settingArea: meta.settingArea,
      actorRole: meta.actorRole ?? "unknown",
    });
    return { published: true, lastRuntimePublishedAt };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    const code = err instanceof BuildRuntimeConfigError ? err.code : "runtime_publish_failed";
    logger.warn("tenant_settings_auto_publish_failed", {
      event: "tenant_settings_auto_publish_failed",
      tenantId,
      settingArea: meta.settingArea,
      actorRole: meta.actorRole ?? "unknown",
      publishErrorCode: code,
      message: message.slice(0, 240),
    });
    return {
      published: false,
      lastRuntimePublishedAt: null,
      publishError: message,
      publishErrorCode: code,
    };
  }
}

export function isRuntimeAdminPublishEnabled(): boolean {
  return ENABLE_RUNTIME_ADMIN;
}
