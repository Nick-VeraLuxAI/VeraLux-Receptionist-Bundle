import React from "react";
import { BillingPanel } from "@/components/vl/editors/BillingPanel";
import { useAdmin } from "../AdminApp";
import { TenantContextBar, NoTenant } from "../AdminShell";

export default function Billing() {
  const { api, tenantId } = useAdmin();
  if (!tenantId) return <NoTenant />;
  return (
    <div data-testid="admin-billing-page">
      <TenantContextBar title="Billing" subtitle="Live Stripe catalog, staff-created subscriptions, and owner self-service controls." />
      <BillingPanel api={api} mode="admin" tenantId={tenantId} returnUrl={`${window.location.origin}/admin/billing`} />
    </div>
  );
}
