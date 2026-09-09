import React from "react";
import { PageHeader, Card } from "@/components/vl/Cards";
import { LeadsList } from "@/components/vl/editors/LeadsList";
import { usePortal } from "../PortalApp";

export default function Leads() {
  const { api, tenantId } = usePortal();
  return (
    <div data-testid="portal-leads-page">
      <PageHeader eyebrow="Your leads" title="People who want to hear from you" subtitle="Captured by your receptionist during calls. Newest first." />
      <Card>
        <LeadsList api={api} mode="portal" tenantId={tenantId} callHref={(id) => `/portal/calls?call=${id}`} />
      </Card>
    </div>
  );
}
