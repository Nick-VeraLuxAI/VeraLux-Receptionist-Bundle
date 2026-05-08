import { getTenantLimits } from "./db";
import { logger } from "./middleware";

export type FeatureKey =
  | "afterHoursMode"
  | "smsFollowup"
  | "calendarIntegration"
  | "crmIntegration"
  | "advancedAnalytics"
  | "callRecording"
  | "transcriptRetention"
  | "multiLocation"
  | "customWorkflows"
  | "prioritySupport";

export type EntitlementResult =
  | { allowed: true }
  | { allowed: false; reason: "feature_denied_by_plan" | "tenant_limits_unavailable" };

export async function checkFeatureEntitlement(
  tenantId: string,
  featureKey: FeatureKey,
  context: Record<string, unknown> = {},
): Promise<EntitlementResult> {
  try {
    const limits = await getTenantLimits(tenantId);
    const allowed = Boolean((limits as any)[featureKey]);
    if (!allowed) {
      logger.warn("feature denied by plan", {
        tenantId,
        featureKey,
        reason: "feature_denied_by_plan",
        ...context,
      });
      return { allowed: false, reason: "feature_denied_by_plan" };
    }
    return { allowed: true };
  } catch (error) {
    logger.error("feature entitlement check failed", {
      tenantId,
      featureKey,
      err: error,
      ...context,
    });
    return { allowed: false, reason: "tenant_limits_unavailable" };
  }
}
