import React from "react";
import { PageHeader, Card } from "@/components/vl/Cards";
import { PublishBar } from "@/components/vl/PublishBar";
import { ForwardingEditor } from "@/components/vl/editors/ForwardingEditor";
import { LockedState } from "@/components/vl/States";
import { usePortal } from "../PortalApp";

export default function TransferLines() {
  const { api, tenantId, sync, markSaved, markPublished, limits, has } = usePortal();
  if (has("multiLocation") === false) return <LockedState feature="multiLocation" upgradeHref="/portal/billing" />;
  return (
    <div data-testid="portal-transfer-lines-page">
      <PageHeader eyebrow="My receptionist" title="Transfer lines" subtitle="People and desks your receptionist can hand a caller to." actions={<PublishBar compact api={api} tenantId={tenantId} sync={sync} onPublished={markPublished} />} />
      <Card>
        <ForwardingEditor api={api} mode="portal" tenantId={tenantId} onSaved={markSaved} upgradeHref="/portal/billing" maxLocations={limits && limits.maxLocations} />
      </Card>
    </div>
  );
}
