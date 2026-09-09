import React from "react";
import { PageHeader } from "@/components/vl/Cards";
import { AnalyticsView } from "@/components/vl/editors/AnalyticsView";
import { LockedState } from "@/components/vl/States";
import { usePortal } from "../PortalApp";

export default function Analytics() {
  const { api, tenantId, has } = usePortal();
  if (has("advancedAnalytics") === false) return <LockedState feature="advancedAnalytics" upgradeHref="/portal/billing" />;
  return (
    <div data-testid="portal-analytics-page">
      <PageHeader eyebrow="Insights" title="How your receptionist is performing" subtitle="Every number here comes straight from your call records." />
      <AnalyticsView api={api} mode="portal" tenantId={tenantId} upgradeHref="/portal/billing" />
    </div>
  );
}
