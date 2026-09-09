import React from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { PageHeader, Card, CardHeader, InlineNote } from "@/components/vl/Cards";
import { QueryBoundary, CardSkeleton, EmptyState } from "@/components/vl/States";
import { errorMessage } from "@/lib/api";
import { fmtDateTime } from "@/lib/format";
import { usePortal } from "../PortalApp";

export default function Approvals() {
  const { api, tenantId } = usePortal();
  const q = useQuery({ queryKey: ["portal", "approvals", tenantId], queryFn: () => api.get("/api/admin/approvals?status=pending"), enabled: !!tenantId });
  const decide = async (id, status) => {
    try {
      await api.post(`/api/admin/approvals/${id}/decide`, { status });
      toast.success(status === "approved" ? "Approved" : "Rejected");
      q.refetch();
    } catch (e) {
      toast.error("Couldn't decide", { description: errorMessage(e) });
    }
  };
  return (
    <div data-testid="portal-approvals-page">
      <PageHeader eyebrow="Inbox" title="Held bookings" subtitle="Large quotes and storm-mode holds wait here. Approving writes the next step." />
      <QueryBoundary query={q} skeleton={<CardSkeleton lines={4} />}>
        {(data) => {
          const rows = data.approvals || [];
          if (!rows.length) return <EmptyState title="Inbox is clear" description="No held bookings tonight." />;
          return (
            <Card>
              <CardHeader title="Needs you" />
              <InlineNote>Deciding here is the audit trail for why a job was held.</InlineNote>
              <ul className="mt-3 space-y-3">
                {rows.map((a) => (
                  <li key={a.id} className="border border-vl-border rounded-[2px] p-3">
                    <div className="font-medium">{a.summary}</div>
                    <div className="vl-meta">{fmtDateTime(a.created_at)}</div>
                    {a.payload && a.payload.reason ? <div className="mt-1 text-[13px]">Held because: {a.payload.reason}</div> : null}
                    <div className="mt-2 flex gap-2">
                      <Button size="sm" onClick={() => decide(a.id, "approved")}>Approve</Button>
                      <Button size="sm" variant="outline" onClick={() => decide(a.id, "rejected")}>Reject</Button>
                    </div>
                  </li>
                ))}
              </ul>
            </Card>
          );
        }}
      </QueryBoundary>
    </div>
  );
}
