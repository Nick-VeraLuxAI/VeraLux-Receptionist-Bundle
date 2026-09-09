import React from "react";
import { PageHeader } from "@/components/vl/Cards";
import { RulesForm } from "@/components/vl/nightDesk/RulesForm";
import { usePortal } from "../PortalApp";

export default function Rules() {
  const { api, tenantId, markSaved } = usePortal();
  return (
    <div data-testid="portal-rules-page">
      <PageHeader eyebrow="My receptionist" title="Shop rules" subtitle="What your night desk is allowed to book, refuse, hold, or page. You see the same cards VeraLux staff publish." />
      <RulesForm api={api} tenantId={tenantId} readOnly canGrantEdit={false} onSaved={markSaved} />
    </div>
  );
}
