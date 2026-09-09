import React from "react";
import { useQuery } from "@tanstack/react-query";
import { PageHeader, Card, CardHeader } from "@/components/vl/Cards";
import { QueryBoundary, CardSkeleton } from "@/components/vl/States";
import { fmtDateTime } from "@/lib/format";
import { usePortal } from "../PortalApp";

export default function OnCall() {
  const { api, tenantId } = usePortal();
  const q = useQuery({ queryKey: ["portal", "oncall", tenantId], queryFn: () => api.get("/api/admin/oncall"), enabled: !!tenantId });
  return (
    <div data-testid="portal-oncall-page">
      <PageHeader eyebrow="My receptionist" title="On-call" subtitle="Who gets paged after hours. Rotation and drills are run by VeraLux." />
      <QueryBoundary query={q} skeleton={<CardSkeleton lines={4} />}>
        {(data) => (
          <Card>
            <CardHeader title="Current line" />
            <div className="text-[14px]">{(data.resolved && data.resolved.e164) || data.staticE164 || "Not set"}</div>
            <div className="vl-meta mt-2">
              Last drill: {data.lastDrill ? `${fmtDateTime(data.lastDrill.created_at)} · ${data.lastDrill.status || (data.lastDrill.ok ? "answered" : "failed")}${data.lastDrill.latency_ms ? ` · ${data.lastDrill.latency_ms} ms` : ""}` : "none yet"}
            </div>
          </Card>
        )}
      </QueryBoundary>
    </div>
  );
}
