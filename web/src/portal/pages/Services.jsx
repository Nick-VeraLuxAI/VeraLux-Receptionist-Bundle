import React from "react";
import { useQuery } from "@tanstack/react-query";
import { PageHeader, Card } from "@/components/vl/Cards";
import { PublishBar } from "@/components/vl/PublishBar";
import { PricingEditor } from "@/components/vl/editors/PricingEditor";
import { LockedState } from "@/components/vl/States";
import { usePortal } from "../PortalApp";

export default function Services() {
  const { api, tenantId, sync, markSaved, markPublished, has } = usePortal();
  if (has("crmIntegration") === false) return <LockedState feature="crmIntegration" upgradeHref="/portal/billing" />;
  return (
    <div data-testid="portal-services-page">
      <PageHeader eyebrow="My receptionist" title="Services & prices" subtitle="The only prices your receptionist is allowed to quote." actions={<PublishBar compact api={api} tenantId={tenantId} sync={sync} onPublished={markPublished} />} />
      <Card>
        <PricingEditor api={api} mode="portal" tenantId={tenantId} onSaved={markSaved} upgradeHref="/portal/billing" />
      </Card>
    </div>
  );
}
