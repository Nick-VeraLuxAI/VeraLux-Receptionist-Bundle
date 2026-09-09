import React from "react";
import { useQuery } from "@tanstack/react-query";
import { PageHeader } from "@/components/vl/Cards";
import { QueryBoundary, CardSkeleton } from "@/components/vl/States";
import { QaScores } from "@/components/vl/editors/QaScores";
import { usePortal } from "../PortalApp";

export default function Qa() {
  const { api, tenantId } = usePortal();
  const q = useQuery({ queryKey: ["portal", "qa", tenantId], queryFn: () => api.get("/api/admin/qa"), enabled: !!tenantId });
  return (
    <div data-testid="portal-qa-page">
      <PageHeader eyebrow="Insights" title="Call coaching" subtitle="See who called, what they needed, and the one thing to do if a check failed." />
      <QueryBoundary query={q} skeleton={<CardSkeleton lines={4} />}>
        {(data) => <QaScores data={data} callHref={(id) => `/portal/calls?call=${encodeURIComponent(id || "")}`} />}
      </QueryBoundary>
    </div>
  );
}
