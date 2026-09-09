import React from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { PageHeader, Card, CardHeader } from "@/components/vl/Cards";
import { QueryBoundary, CardSkeleton, EmptyState } from "@/components/vl/States";
import { errorMessage } from "@/lib/api";
import { fmtDateTime } from "@/lib/format";
import { useAdmin } from "../AdminApp";

export default function Approvals() {
  const { api, tenantId } = useAdmin();
  const q = useQuery({ queryKey: ["approvals", tenantId], queryFn: () => api.get("/api/admin/approvals"), enabled: !!tenantId });
  const auditQ = useQuery({ queryKey: ["completion-audit", tenantId], queryFn: () => api.get("/api/admin/completions"), enabled: !!tenantId });
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
    <div data-testid="admin-approvals-page">
      <PageHeader serif={false} eyebrow="Selected tenant" title="Approval queue" subtitle="Why a booking was held, and the audit of who decided." />
      <QueryBoundary query={q} skeleton={<CardSkeleton lines={5} />}>
        {(data) => {
          const rows = data.approvals || [];
          return (
            <Card>
              <CardHeader title={`${rows.length} items`} />
              {!rows.length ? <EmptyState title="No held bookings" compact /> : <ul className="space-y-3">
                {rows.map((a) => (
                  <li key={a.id} className="border border-vl-border rounded-[2px] p-3" data-testid={`approval-${a.id}`}>
                    <div className="font-medium">{a.summary}</div>
                    <div className="vl-meta">{a.status} · {fmtDateTime(a.created_at)}{a.decided_by ? ` · ${a.decided_by}` : ""}</div>
                    {a.payload && a.payload.reason ? <div className="mt-1 text-[13px]">Why: {a.payload.reason}</div> : null}
                    {a.status === "pending" ? (
                      <div className="mt-2 flex gap-2">
                        <Button size="sm" onClick={() => decide(a.id, "approved")}>Approve</Button>
                        <Button size="sm" variant="outline" onClick={() => decide(a.id, "rejected")}>Reject</Button>
                      </div>
                    ) : null}
                  </li>
                ))}
              </ul>}
            </Card>
          );
        }}
      </QueryBoundary>
      <div className="mt-4">
        <QueryBoundary query={auditQ} skeleton={<CardSkeleton lines={5} />}>
          {(data) => (
            <Card>
              <CardHeader title="Terminal audit" subtitle="Why each call was booked, held, paged, tasked, or refused." />
              <ul className="space-y-2 text-[13px]">
                {(data.audit || []).map((event) => (
                  <li key={event.id} className="border-b border-vl-border pb-2">
                    <span className="font-medium">{event.to_completion}</span> · {event.reason} · {event.call_id}
                    <div className="vl-meta">{fmtDateTime(event.created_at)}{event.actor ? ` · ${event.actor}` : ""}</div>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </QueryBoundary>
      </div>
    </div>
  );
}
