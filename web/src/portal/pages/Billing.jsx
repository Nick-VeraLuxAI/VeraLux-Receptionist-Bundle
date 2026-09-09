import React from "react";
import { PageHeader } from "@/components/vl/Cards";
import { BillingPanel } from "@/components/vl/editors/BillingPanel";
import { usePortal } from "../PortalApp";

export default function Billing() {
  const { api, tenantId } = usePortal();
  return (
    <div data-testid="portal-billing-page">
      <PageHeader eyebrow="Account" title="Plan & billing" subtitle="Your plan, billing status, and what's included this month. VeraLux sets this up unless self-service is enabled." />
      <BillingPanel api={api} mode="portal" tenantId={tenantId} returnUrl={`${window.location.origin}/portal/billing`} />
    </div>
  );
}
