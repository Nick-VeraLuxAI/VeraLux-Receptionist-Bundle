import React from "react";
import { PageHeader } from "@/components/vl/Cards";
import { RulesForm } from "@/components/vl/nightDesk/RulesForm";
import { useAdmin } from "../AdminApp";

export default function Rules() {
  const { api, tenantId, markSaved } = useAdmin();
  return (
    <div data-testid="admin-rules-page">
      <PageHeader serif={false} eyebrow="Selected tenant" title="Shop rules" subtitle="Hard constraints the model cannot override. Saving publishes them immediately." />
      <RulesForm api={api} tenantId={tenantId} readOnly={false} canGrantEdit onSaved={markSaved} />
    </div>
  );
}
