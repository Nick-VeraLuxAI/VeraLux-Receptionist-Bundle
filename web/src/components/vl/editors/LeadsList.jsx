import React from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Trash2, Users, AlertCircle, Phone, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Pill } from "@/components/vl/Pills";
import { QueryBoundary, RowsSkeleton, EmptyState } from "@/components/vl/States";
import { ConfirmDialog } from "@/components/vl/ConfirmDialog";
import { errorMessage } from "@/lib/api";
import { fmtRelative, fmtDateTime, stageLabel } from "@/lib/format";
import { cn } from "@/lib/utils";

const STAGE_TONE = { booked: "success", ready_to_book: "gold", qualified: "neutral", inquiry: "neutral", lost: "danger" };

function leadIntent(l) {
  return l.intent || l.issue || l.category || "—";
}

function leadStage(l) {
  return l.stage || "inquiry";
}

function LeadIdentity({ l }) {
  return (
    <div className="min-w-0">
      <div className="font-medium truncate">{l.name || "Unnamed caller"}</div>
      <div className="vl-meta inline-flex items-center gap-1 min-w-0">
        <Phone className="h-3 w-3 shrink-0" aria-hidden="true" />
        <span className="truncate">{l.callerDisplay || l.phone || "—"}</span>
      </div>
    </div>
  );
}

export const LeadsList = ({ api, mode, tenantId, callHref, limit = 100, canDelete = true }) => {
  const q = useQuery({ queryKey: [mode, "leads", tenantId, limit], queryFn: () => api.get(`/api/admin/leads?limit=${limit}`), enabled: !!tenantId });
  const [filter, setFilter] = React.useState("all");
  const [deleting, setDeleting] = React.useState(null);
  const [busy, setBusy] = React.useState(false);

  const remove = async () => {
    setBusy(true);
    try {
      await api.del(`/api/admin/leads/${deleting.id}`);
      toast.success("Lead removed");
      setDeleting(null);
      q.refetch();
    } catch (e) {
      toast.error("Couldn't remove lead", { description: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div data-testid="leads-list">
      <QueryBoundary query={q} skeleton={<RowsSkeleton rows={6} />}>
        {(data) => {
          const all = data.leads || [];
          const rows = filter === "attention" ? all.filter((l) => l.needsAttention) : all;
          return (
            <>
              <div className="mb-4 flex flex-wrap items-center gap-2">
                <div className="inline-flex rounded-full bg-vl-warm p-1" role="tablist" aria-label="Lead filter">
                  {[
                    ["all", `All (${all.length})`],
                    ["attention", `Needs attention (${all.filter((l) => l.needsAttention).length})`],
                  ].map(([id, label]) => (
                    <button key={id} role="tab" aria-selected={filter === id} onClick={() => setFilter(id)} className={cn("rounded-full px-3.5 py-1.5 text-[13px] font-medium transition-colors", filter === id ? "bg-white border border-vl-border shadow-xs text-vl-text" : "text-vl-secondary hover:text-vl-text")} data-testid={`leads-filter-${id}`}>
                      {label}
                    </button>
                  ))}
                </div>
              </div>
              {rows.length === 0 ? (
                <EmptyState icon={Users} title={filter === "attention" ? "Nothing needs attention" : "No leads yet"} description={filter === "attention" ? "All caught up. Leads that need follow-up will appear here." : "When callers show interest, your receptionist captures them here."} />
              ) : (
                <>
                  <ul className="space-y-2 md:hidden" data-testid="leads-card-list">
                    {rows.map((l) => (
                      <li key={l.id} className="rounded-[4px] border border-vl-border bg-white p-3" data-testid="data-table-row">
                        <div className="flex items-start justify-between gap-3">
                          <LeadIdentity l={l} />
                          <Pill size="sm" tone={STAGE_TONE[leadStage(l)] || "neutral"}>{stageLabel(leadStage(l))}</Pill>
                        </div>
                        <div className="mt-2 text-[13px] text-vl-secondary break-words">{leadIntent(l)}</div>
                        <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                          <span className="vl-meta" title={fmtDateTime(l.createdAt)}>Created {fmtRelative(l.createdAt)}</span>
                          <span className="vl-meta" title={fmtDateTime(l.updatedAt || l.createdAt)}>Updated {fmtRelative(l.updatedAt || l.createdAt)}</span>
                        </div>
                        <div className="mt-2 flex items-center justify-end gap-1">
                          {l.needsAttention ? <Pill size="sm" tone="danger" icon={AlertCircle}>Needs attention</Pill> : null}
                          {l.callId && callHref ? (
                            <Button asChild variant="ghost" size="sm" data-testid="lead-view-call">
                              <a href={callHref(l.callId)}>
                                <ExternalLink className="h-4 w-4" /> Call
                              </a>
                            </Button>
                          ) : null}
                          {canDelete ? (
                            <Button variant="ghost" size="icon" onClick={() => setDeleting(l)} aria-label="Remove lead" data-testid="lead-delete-button">
                              <Trash2 className="h-4 w-4 text-vl-danger" />
                            </Button>
                          ) : null}
                        </div>
                      </li>
                    ))}
                  </ul>
                  <div className="hidden md:block overflow-x-auto vl-scroll">
                    <table className="w-full min-w-[760px] text-[13px] vl-table" data-testid="data-table">
                      <thead>
                        <tr className="text-left border-b border-vl-border">
                          <th className="py-2 pr-3 pl-1">Lead</th>
                          <th className="py-2 pr-3">Interested in</th>
                          <th className="py-2 pr-3">Stage</th>
                          <th className="py-2 pr-3">Created</th>
                          <th className="py-2 pr-3">Updated</th>
                          <th className="py-2 pr-3"></th>
                        </tr>
                      </thead>
                      <tbody>
                        {rows.map((l) => (
                          <tr key={l.id} className="border-b border-vl-border last:border-0 vl-row hover:bg-vl-soft" data-testid="data-table-row">
                            <td className="py-2.5 pr-3 pl-1">
                              <LeadIdentity l={l} />
                            </td>
                            <td className="py-2.5 pr-3 text-vl-secondary max-w-[260px]">
                              <div className="truncate">{leadIntent(l)}</div>
                            </td>
                            <td className="py-2.5 pr-3">
                              <div className="flex flex-wrap gap-1.5">
                                <Pill size="sm" tone={STAGE_TONE[leadStage(l)] || "neutral"}>
                                  {stageLabel(leadStage(l))}
                                </Pill>
                                {l.needsAttention ? (
                                  <Pill size="sm" tone="danger" icon={AlertCircle} testId="lead-attention-pill">
                                    Needs attention
                                  </Pill>
                                ) : null}
                              </div>
                            </td>
                            <td className="py-2.5 pr-3 text-vl-muted whitespace-nowrap" title={fmtDateTime(l.createdAt)}>
                              {fmtRelative(l.createdAt)}
                            </td>
                            <td className="py-2.5 pr-3 text-vl-muted whitespace-nowrap" title={fmtDateTime(l.updatedAt || l.createdAt)}>
                              {fmtRelative(l.updatedAt || l.createdAt)}
                            </td>
                            <td className="py-2.5 pr-1 text-right whitespace-nowrap">
                              {l.callId && callHref ? (
                                <Button asChild variant="ghost" size="sm" data-testid="lead-view-call">
                                  <a href={callHref(l.callId)}>
                                    <ExternalLink className="h-4 w-4" /> Call
                                  </a>
                                </Button>
                              ) : null}
                              {canDelete ? (
                                <Button variant="ghost" size="icon" onClick={() => setDeleting(l)} aria-label="Remove lead" data-testid="lead-delete-button">
                                  <Trash2 className="h-4 w-4 text-vl-danger" />
                                </Button>
                              ) : null}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
            </>
          );
        }}
      </QueryBoundary>
      <ConfirmDialog open={!!deleting} onOpenChange={(o) => !o && setDeleting(null)} title="Remove this lead?" description={`${deleting?.name || "This lead"} will be deleted permanently.`} confirmLabel="Remove lead" destructive onConfirm={remove} loading={busy} />
    </div>
  );
};
