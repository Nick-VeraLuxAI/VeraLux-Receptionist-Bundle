import React from "react";
import { AnalyticsView } from "@/components/vl/editors/AnalyticsView";
import { useAdmin } from "../AdminApp";
import { TenantContextBar, NoTenant } from "../AdminShell";

export default function Analytics() {
  const { api, tenantId } = useAdmin();
  if (!tenantId) return <NoTenant />;
  return (
    <div data-testid="admin-analytics-page">
      <TenantContextBar title="Analytics" subtitle="Requires advancedAnalytics on the tenant plan." />
      <AnalyticsView api={api} mode="admin" tenantId={tenantId} upgradeHref="/admin/plans" />
    </div>
  );
}
