import React from "react";
import { useQuery } from "@tanstack/react-query";
import { QueryBoundary, CardSkeleton } from "@/components/vl/States";
import { QaScores } from "@/components/vl/editors/QaScores";
import { useAdmin } from "../AdminApp";
import { TenantContextBar, NoTenant } from "../AdminShell";

export default function Qa() {
  const { api, tenantId } = useAdmin();
  const q = useQuery({ queryKey: ["qa", tenantId], queryFn: () => api.get("/api/admin/qa"), enabled: !!tenantId });
  if (!tenantId) return <NoTenant />;
  return (
    <div data-testid="admin-qa-page">
      <TenantContextBar title="Call QA" subtitle="Who called, what they needed, and what you should do if the night desk slipped." />
      <QueryBoundary query={q} skeleton={<CardSkeleton lines={4} />}>
        {(data) => <QaScores data={data} callHref={(id) => `/admin/calls?call=${encodeURIComponent(id || "")}`} />}
      </QueryBoundary>
    </div>
  );
}
