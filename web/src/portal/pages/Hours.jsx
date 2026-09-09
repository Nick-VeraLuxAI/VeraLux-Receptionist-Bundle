import React from "react";
import { useQuery } from "@tanstack/react-query";
import { PageHeader, Card } from "@/components/vl/Cards";
import { PublishBar } from "@/components/vl/PublishBar";
import { HoursEditor } from "@/components/vl/editors/HoursEditor";
import { usePortal } from "../PortalApp";

export default function Hours() {
  const { api, tenantId, sync, markSaved, markPublished, has } = usePortal();
  const playbookQ = useQuery({ queryKey: ["portal", "shop-playbook", tenantId], queryFn: () => api.get("/api/admin/shop-playbook") });
  const readOnly = playbookQ.data ? !playbookQ.data.ownerCanEdit : true;
  return (
    <div data-testid="portal-hours-page">
      <PageHeader eyebrow="My receptionist" title="Business hours" subtitle="Your receptionist uses these to know when you're open and what to say after hours." actions={<PublishBar compact api={api} tenantId={tenantId} sync={sync} onPublished={markPublished} />} />
      <Card>
        <HoursEditor api={api} mode="portal" tenantId={tenantId} onSaved={markSaved} readOnly={readOnly} afterHoursLocked={has("afterHoursMode") === false} />
      </Card>
    </div>
  );
}
