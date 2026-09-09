import React from "react";
import { useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Phone, PhoneMissed, Gauge, User, MessageSquare, Copy, RefreshCw, Play } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { Card, Stat, InlineNote } from "@/components/vl/Cards";
import { Pill } from "@/components/vl/Pills";
import { QueryBoundary, RowsSkeleton, EmptyState } from "@/components/vl/States";
import { useAdmin } from "../AdminApp";
import { TenantContextBar, NoTenant } from "../AdminShell";
import { fmtDateTime, fmtRelative, fmtDuration, stageLabel, titleCase, sortCallsNewestFirst } from "@/lib/format";
import { cn } from "@/lib/utils";

export default function Calls() {
  const { api, tenantId } = useAdmin();
  const [params, setParams] = useSearchParams();
  const filter = params.get("filter") === "missed" ? "missed" : "all";
  const selected = params.get("call");
  const q = useQuery({ queryKey: ["admin", "calls", tenantId, filter, 200], queryFn: () => api.get(`/api/admin/calls?limit=200&filter=${filter}`), enabled: !!tenantId });
  const setFilter = (f) => setParams((p) => { const n = new URLSearchParams(p); if (f === "all") n.delete("filter"); else n.set("filter", f); return n; });
  const open = (id) => setParams((p) => { const n = new URLSearchParams(p); n.set("call", id); return n; });
  const close = () => setParams((p) => { const n = new URLSearchParams(p); n.delete("call"); return n; });
  if (!tenantId) return <NoTenant />;
  const call = q.data && (q.data.calls || []).find((c) => c.id === selected);

  return (
    <div data-testid="admin-calls-page">
      <TenantContextBar title="Calls" subtitle="Full call records including transcripts and quality metrics. Staff view - owners see masked callers only." actions={<Button variant="outline" size="sm" onClick={() => q.refetch()}><RefreshCw className="h-4 w-4" /> Refresh</Button>} />
      <Card padded={false}>
        <div className="flex flex-wrap items-center gap-3 p-4 border-b border-vl-border">
          <div className="inline-flex rounded-lg bg-vl-warm p-1" role="tablist">
            {[["all", "All"], ["missed", "Missed"]].map(([id, label]) => (
              <button key={id} role="tab" aria-selected={filter === id} onClick={() => setFilter(id)} className={cn("rounded-md px-3 py-1 text-[13px] font-medium", filter === id ? "bg-white border border-vl-border" : "text-vl-secondary")} data-testid={`admin-calls-filter-${id}`}>
                {label}
              </button>
            ))}
          </div>
          {q.data && q.data.counts ? <span className="vl-meta ml-auto">{q.data.counts.total} total · {q.data.counts.missed} missed</span> : null}
        </div>
        <QueryBoundary query={q} skeleton={<RowsSkeleton rows={8} className="p-5" />} emptyWhen={(d) => !(d.calls || []).length} empty={<EmptyState icon={Phone} title="No calls" description="Nothing recorded for this tenant yet." />}>
          {(d) => (
            <div className="overflow-x-auto vl-scroll">
              <table className="w-full text-[13px] vl-table" data-testid="admin-calls-table">
                <thead>
                  <tr className="text-left border-b border-vl-border">
                    <th className="py-2 px-4">When</th>
                    <th className="py-2 pr-3">Caller</th>
                    <th className="py-2 pr-3">Duration</th>
                    <th className="py-2 pr-3">Stage</th>
                    <th className="py-2 pr-3">Outcome</th>
                    <th className="py-2 pr-3">Lead</th>
                    <th className="py-2 pr-3">Quality</th>
                    <th className="py-2 pr-4">Summary</th>
                  </tr>
                </thead>
                <tbody>
                  {sortCallsNewestFirst(d.calls).map((c) => (
                    <tr key={c.id} onClick={() => open(c.id)} className="border-b border-vl-border last:border-0 hover:bg-vl-soft cursor-pointer vl-row" data-testid="admin-call-row">
                      <td className="py-2 px-4 whitespace-nowrap text-vl-secondary" title={fmtDateTime(c.createdAt)}>{fmtRelative(c.createdAt)}</td>
                      <td className="py-2 pr-3 whitespace-nowrap font-mono">{c.callerId}</td>
                      <td className="py-2 pr-3 whitespace-nowrap">{c.missed ? <Pill size="sm" tone="danger" icon={PhoneMissed}>Missed</Pill> : fmtDuration(c.durationMs)}</td>
                      <td className="py-2 pr-3 whitespace-nowrap">{stageLabel(c.stage)}</td>
                      <td className="py-2 pr-3 whitespace-nowrap">{titleCase(c.outcome || "—")}</td>
                      <td className="py-2 pr-3 whitespace-nowrap">{c.lead ? <Pill size="sm" tone={c.lead.needsAttention ? "danger" : "gold"}>{c.lead.name || "Lead"}</Pill> : <span className="vl-meta">—</span>}</td>
                      <td className="py-2 pr-3 whitespace-nowrap">{c.callQuality ? `${c.callQuality.score} / 5` : <span className="vl-meta">—</span>}</td>
                      <td className="py-2 pr-4 text-vl-secondary max-w-[360px] truncate">{c.transcriptSummary}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </QueryBoundary>
      </Card>

      <Sheet open={!!selected} onOpenChange={(o) => !o && close()}>
        <SheetContent className="w-full sm:max-w-xl overflow-y-auto bg-vl-canvas" data-testid="admin-call-drawer">
          <SheetHeader>
            <SheetTitle>Call record</SheetTitle>
            <SheetDescription>Full record for staff review.</SheetDescription>
          </SheetHeader>
          {call ? (
            <div className="mt-5 space-y-4">
              <div className="vl-card p-4 grid grid-cols-2 gap-3">
                <Stat label="Caller" value={<span className="font-mono">{call.callerId}</span>} />
                <Stat label="Masked (owner view)" value={call.callerDisplay} />
                <Stat label="Started" value={fmtDateTime(call.createdAt)} />
                <Stat label="Duration" value={call.missed ? "Missed" : fmtDuration(call.durationMs)} />
                <Stat label="Stage" value={stageLabel(call.stage)} />
                <Stat label="Outcome" value={titleCase(call.outcome || "—")} />
                <Stat label="Intent" value={titleCase(call.intent || "—")} />
                <Stat label="To" value={call.toNumber || "—"} />
                <div className="col-span-2 flex items-center gap-2">
                  <Stat label="Call control id" value={<code className="text-[12px]">{call.callControlId}</code>} className="flex-1" />
                  <Button variant="ghost" size="icon" onClick={() => { navigator.clipboard && navigator.clipboard.writeText(call.callControlId); toast.success("Copied"); }} aria-label="Copy call control id">
                    <Copy className="h-4 w-4" />
                  </Button>
                </div>
              </div>
              {call.recordingUrl ? (
                <a className="inline-flex items-center gap-2 text-[13px] underline" href={call.recordingUrl} target="_blank" rel="noreferrer">
                  <Play className="h-4 w-4" /> Play recording
                </a>
              ) : null}
              <div className="vl-card p-4">
                <div className="vl-eyebrow-dark mb-2">Summary</div>
                <p className="text-[14px]">{call.transcriptSummary}</p>
              </div>
              {call.lead ? (
                <div className="vl-card p-4">
                  <div className="vl-eyebrow-dark mb-2 inline-flex items-center gap-1.5"><User className="h-3.5 w-3.5" /> Lead</div>
                  <div className="grid grid-cols-2 gap-3">
                    <Stat label="Name" value={call.lead.name || "—"} />
                    <Stat label="Phone" value={call.lead.phone} />
                    <Stat label="Intent" value={call.lead.intent} />
                    <Stat label="Stage" value={stageLabel(call.lead.stage)} />
                  </div>
                </div>
              ) : null}
              {call.callQuality ? (
                <div className="vl-card p-4" data-testid="admin-call-quality">
                  <div className="vl-eyebrow-dark mb-2 inline-flex items-center gap-1.5"><Gauge className="h-3.5 w-3.5" /> Quality</div>
                  <div className="grid grid-cols-2 gap-3">
                    <Stat label="Score" value={`${call.callQuality.score} / 5`} />
                    <Stat label="Latency" value={`${call.callQuality.latencyMs} ms`} />
                    <Stat label="Interruptions" value={call.callQuality.interruptions} />
                    <Stat label="STT confidence" value={`${Math.round(call.callQuality.sttConfidence * 100)}%`} />
                    <Stat label="Audio issues" value={(call.callQuality.audioIssues || []).map(titleCase).join(", ") || "None"} className="col-span-2" />
                  </div>
                </div>
              ) : null}
              <div className="vl-card p-4" data-testid="admin-call-transcript">
                <div className="vl-eyebrow-dark mb-3 inline-flex items-center gap-1.5"><MessageSquare className="h-3.5 w-3.5" /> Transcript</div>
                {(call.transcript || []).length === 0 ? (
                  <InlineNote>No transcript captured for this call.</InlineNote>
                ) : (
                  <ol className="space-y-2.5">
                    {call.transcript.map((t, i) => (
                      <li key={i} className={cn("flex gap-3 text-[13px]", t.role === "assistant" ? "" : "flex-row-reverse text-right")}>
                        <div className={cn("max-w-[85%] rounded-[4px] px-3 py-2", t.role === "assistant" ? "bg-vl-warm" : "bg-white border border-vl-border")}>
                          <div className="vl-meta mb-0.5">{t.role === "assistant" ? "Receptionist" : "Caller"} · {fmtDuration(t.atMs)}</div>
                          {t.text}
                        </div>
                      </li>
                    ))}
                  </ol>
                )}
              </div>
            </div>
          ) : null}
        </SheetContent>
      </Sheet>
    </div>
  );
}
