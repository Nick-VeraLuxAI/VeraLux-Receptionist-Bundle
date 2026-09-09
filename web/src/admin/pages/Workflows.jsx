import React from "react";
import { WorkflowsPanel } from "@/components/vl/editors/WorkflowsPanel";
import { useAdmin } from "../AdminApp";
import { TenantContextBar, NoTenant } from "../AdminShell";

export default function Workflows() {
  const { api, tenantId } = useAdmin();
  if (!tenantId) return <NoTenant />;
  return (
    <div data-testid="admin-workflows-page">
      <TenantContextBar title="Workflows" subtitle="Requires customWorkflows. New workflow opens the template gallery. Lock individual workflows to keep the owner portal review-only." />
      <WorkflowsPanel api={api} mode="admin" tenantId={tenantId} upgradeHref="/admin/plans" />
    </div>
  );
}
