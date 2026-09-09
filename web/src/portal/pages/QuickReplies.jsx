import React from "react";
import { PageHeader, Card } from "@/components/vl/Cards";
import { PublishBar } from "@/components/vl/PublishBar";
import { QuickRepliesEditor } from "@/components/vl/editors/QuickRepliesEditor";
import { usePortal } from "../PortalApp";

export default function QuickReplies() {
  const { api, tenantId, sync, markSaved, markPublished } = usePortal();
  return (
    <div data-testid="portal-quick-replies-page">
      <PageHeader eyebrow="My receptionist" title="Quick replies" subtitle="Instant, consistent answers to the questions you hear every day." actions={<PublishBar compact api={api} tenantId={tenantId} sync={sync} onPublished={markPublished} />} />
      <Card>
        <QuickRepliesEditor api={api} mode="portal" tenantId={tenantId} onSaved={markSaved} onPublished={markPublished} />
      </Card>
    </div>
  );
}
