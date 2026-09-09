import React from "react";
import { PageHeader } from "@/components/vl/Cards";
import { WorkflowsPanel } from "@/components/vl/editors/WorkflowsPanel";
import { LockedState } from "@/components/vl/States";
import { usePortal } from "../PortalApp";

export default function Workflows() {
  const { api, tenantId, has } = usePortal();
  if (has("customWorkflows") === false) return <LockedState feature="customWorkflows" upgradeHref="/portal/billing" />;
  return (
    <div data-testid="portal-workflows-page">
      <PageHeader eyebrow="My receptionist" title="Workflows" subtitle="VeraLux-managed templates. Review and test-run here; edits stay with VeraLux unless Owner can edit is on." />
      <WorkflowsPanel api={api} mode="portal" tenantId={tenantId} upgradeHref="/portal/billing" />
    </div>
  );
}
