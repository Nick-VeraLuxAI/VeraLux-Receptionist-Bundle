import React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { computeSyncState } from "@/lib/format";
import { lastPublishedFromRuntimeConfig, fromAdminHealth } from "@/lib/controlPlaneAdapters";
import { ApiError } from "@/lib/api";

/**
 * Real runtime sync state for a tenant.
 * portal -> GET /api/owner/voice-runtime-sync ; admin -> GET /api/admin/runtime/tenants/:id/config
 * Health -> GET /api/admin/health (degraded => Needs attention)
 */
export function useSync({ api, tenantId, mode }) {
  const qc = useQueryClient();
  const [pendingLocal, setPendingLocal] = React.useState(false);
  const [publishFailed, setPublishFailed] = React.useState(false);

  const syncQ = useQuery({
    queryKey: [mode, "sync", tenantId],
    enabled: !!tenantId,
    queryFn: async () => {
      if (mode === "portal") return api.get("/api/owner/voice-runtime-sync");
      try {
        const r = await api.get(`/api/admin/runtime/tenants/${tenantId}/config`);
        return {
          lastRuntimePublishedAt: lastPublishedFromRuntimeConfig(r),
          pendingChanges: false,
        };
      } catch (e) {
        if (e instanceof ApiError && e.status === 404) {
          return { lastRuntimePublishedAt: null, pendingChanges: true };
        }
        throw e;
      }
    },
  });
  const healthQ = useQuery({
    queryKey: [mode, "health", tenantId],
    enabled: !!tenantId,
    refetchInterval: 60_000,
    queryFn: () => api.get("/api/admin/health"),
  });

  const lastPublishedAt = (syncQ.data && syncQ.data.lastRuntimePublishedAt) || null;
  const pending = pendingLocal || !!(syncQ.data && syncQ.data.pendingChanges);
  const health = healthQ.data ? fromAdminHealth(healthQ.data) : healthQ.data;
  const healthOk = healthQ.isError ? false : health ? health.ok === true : true;
  const sync = { ...computeSyncState({ lastPublishedAt, pendingChanges: pending, healthOk, publishFailed }), lastPublishedAt, loading: syncQ.isPending };

  const refresh = React.useCallback(() => {
    qc.invalidateQueries({ queryKey: [mode, "sync", tenantId] });
  }, [qc, mode, tenantId]);

  /** Call with a config-write response ({saved, published, lastRuntimePublishedAt}). */
  const markSaved = React.useCallback(
    (res) => {
      if (res && res.published === false) setPendingLocal(true);
      else if (res && res.published === true) setPendingLocal(false);
      refresh();
    },
    [refresh],
  );
  const markPublished = React.useCallback(
    (res, err) => {
      if (err) setPublishFailed(true);
      else {
        setPublishFailed(false);
        setPendingLocal(false);
      }
      refresh();
    },
    [refresh],
  );

  return { sync, health, healthOk, healthLoading: healthQ.isPending, healthError: healthQ.isError, markSaved, markPublished, refresh };
}
