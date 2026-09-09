import React from "react";
import { Card } from "@/components/vl/Cards";
import { LeadsList } from "@/components/vl/editors/LeadsList";
import { useAdmin } from "../AdminApp";
import { TenantContextBar, NoTenant } from "../AdminShell";

export default function Leads() {
  const { api, tenantId } = useAdmin();
  if (!tenantId) return <NoTenant />;
  return (
    <div data-testid="admin-leads-page">
      <TenantContextBar title="Leads" subtitle="Leads captured by the receptionist for this tenant." />
      <Card>
        <LeadsList api={api} mode="admin" tenantId={tenantId} callHref={(id) => `/admin/calls?call=${id}`} limit={200} />
      </Card>
    </div>
  );
}
