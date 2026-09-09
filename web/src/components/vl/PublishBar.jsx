import React from "react";
import { UploadCloud, AlertTriangle } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { SyncPill } from "./Pills";
import { fmtDateTime } from "@/lib/format";
import { errorMessage } from "@/lib/api";
import { lastPublishedFromRuntimeConfig } from "@/lib/controlPlaneAdapters";
import { cn } from "@/lib/utils";

/**
 * Publish / sync control. `sync` = { state, label, lastPublishedAt }.
 * Calls POST /api/admin/runtime/tenants/:id/publish-from-tenant.
 */
export const PublishBar = ({ api, tenantId, sync, onPublished, className, compact = false, label = "Publish changes" }) => {
  const [busy, setBusy] = React.useState(false);
  const publish = async () => {
    setBusy(true);
    try {
      const res = await api.post(`/api/admin/runtime/tenants/${tenantId}/publish-from-tenant`);
      const at = lastPublishedFromRuntimeConfig(res);
      toast.success("Receptionist synced", { description: at ? `Live as of ${fmtDateTime(at)}` : "Live." });
      onPublished && onPublished({ ...res, lastRuntimePublishedAt: at });
    } catch (e) {
      toast.error("Publish failed", { description: errorMessage(e) });
      onPublished && onPublished(null, e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className={cn("flex flex-wrap items-center gap-3", compact ? "" : "vl-card-soft px-4 py-3", className)} data-testid="publish-bar">
      <SyncPill sync={sync} />
      {!compact ? (
        <span className="vl-meta">
          {sync?.lastPublishedAt ? `Last published ${fmtDateTime(sync.lastPublishedAt)}` : "Your receptionist has not been published yet."}
        </span>
      ) : null}
      {sync?.state === "not_live" && !compact ? (
        <span className="flex items-center gap-1.5 text-[12px] text-vl-warning">
          <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" /> Saved changes are not live until you publish
        </span>
      ) : null}
      <div className="ml-auto">
        <Button size="sm" onClick={publish} disabled={busy} data-testid="publish-button">
          <UploadCloud className="h-4 w-4" /> {busy ? "Publishing…" : label}
        </Button>
      </div>
    </div>
  );
};
