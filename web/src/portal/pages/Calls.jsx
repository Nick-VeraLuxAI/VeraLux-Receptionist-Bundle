import React from "react";
import { useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Phone, PhoneMissed, ChevronRight, Clock, Gauge, User, Info, Play } from "lucide-react";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { PageHeader, Card, Stat, InlineNote } from "@/components/vl/Cards";
import { Pill } from "@/components/vl/Pills";
import { QueryBoundary, RowsSkeleton, EmptyState, CardSkeleton } from "@/components/vl/States";
import { usePortal } from "../PortalApp";
import { fmtRelative, fmtDateTime, fmtDuration, stageLabel, titleCase, sortCallsNewestFirst } from "@/lib/format";
import { cn } from "@/lib/utils";

export default function Calls() {
  const { api, tenantId, has } = usePortal();
  const [params, setParams] = useSearchParams();
  const filter = params.get("filter") === "missed" ? "missed" : "all";
  const selected = params.get("call");
  const q = useQuery({ queryKey: ["portal", "calls", tenantId, filter], queryFn: () => api.get(`/api/owner/calls?limit=100&filter=${filter}`) });

  const setFilter = (f) => setParams((p) => { const n = new URLSearchParams(p); if (f === "all") n.delete("filter"); else n.set("filter", f); return n; });
  const open = (id) => setParams((p) => { const n = new URLSearchParams(p); n.set("call", id); return n; });
  const close = () => setParams((p) => { const n = new URLSearchParams(p); n.delete("call"); return n; });

  return (
    <div data-testid="portal-calls-page">
      <PageHeader eyebrow="Your calls" title="Every conversation, at a glance" subtitle="Caller identities are masked to protect your customers' privacy." />
      <Card padded={false}>
        <div className="flex flex-wrap items-center gap-3 p-4 border-b border-vl-border">
          <div className="inline-flex rounded-full bg-vl-warm p-1" role="tablist" aria-label="Call filter">
            {[
              ["all", "All calls"],
              ["missed", "Missed"],
            ].map(([id, label]) => (
              <button key={id} role="tab" aria-selected={filter === id} onClick={() => setFilter(id)} className={cn("rounded-full px-3.5 py-1.5 text-[13px] font-medium transition-colors", filter === id ? "bg-white border border-vl-border shadow-xs text-vl-text" : "text-vl-secondary hover:text-vl-text")} data-testid={`calls-filter-${id}`}>
                {label}
              </button>
            ))}
          </div>
          {q.data && q.data.counts ? (
            <span className="vl-meta ml-auto">
              {q.data.counts.total} total · {q.data.counts.missed} missed
            </span>
          ) : null}
        </div>
        <QueryBoundary query={q} skeleton={<RowsSkeleton rows={8} className="p-5" />} emptyWhen={(d) => !(d.calls || []).length} empty={<EmptyState icon={Phone} title={filter === "missed" ? "No missed calls" : "No calls yet"} description={filter === "missed" ? "Your receptionist has answered everything. Nice." : "Once callers reach your number, their conversations appear here."} />}>
          {(d) => (
            <ul className="divide-y divide-vl-border" data-testid="portal-calls-list">
              {sortCallsNewestFirst(d.calls).map((c) => (
                <li key={c.id}>
                  <button onClick={() => open(c.id)} className="w-full flex items-center gap-3 px-4 sm:px-5 py-3 text-left hover:bg-vl-soft transition-colors vl-row" data-testid="portal-call-row">
                    <span className={`inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full ${c.missed ? "bg-vl-danger-bg text-vl-danger" : "bg-vl-success-bg text-vl-success"}`}>
                      {c.missed ? <PhoneMissed className="h-4 w-4" aria-hidden="true" /> : <Phone className="h-4 w-4" aria-hidden="true" />}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-x-2">
                        <span className="text-[14px] font-medium" data-testid="call-caller-display">{c.callerDisplay}</span>
                        <span className="vl-meta" title={fmtDateTime(c.createdAt)}>{fmtRelative(c.createdAt)}</span>
                        {!c.missed && c.durationMs ? <span className="vl-meta hidden sm:inline">· {fmtDuration(c.durationMs)}</span> : null}
                      </div>
                      <div className="text-[13px] text-vl-secondary truncate">{c.transcriptSummary || (c.missed ? "Missed call" : "Call handled")}</div>
                      {c.existingCustomer ? <div className="vl-meta">Known caller · {c.existingCustomer}{c.openJobs && c.openJobs.length ? ` · ${c.openJobs.length} open job${c.openJobs.length === 1 ? "" : "s"}` : ""}{c.membership ? ` · ${c.membership}` : ""}{c.warranty ? ` · ${c.warranty}` : ""}</div> : null}
                    </div>
                    <div className="hidden md:flex items-center gap-1.5">
                      {c.stage && c.stage !== "unknown" ? <Pill size="sm" tone={c.stage === "booked" ? "success" : "neutral"}>{stageLabel(c.stage)}</Pill> : null}
                      {c.completion ? <Pill size="sm" tone={c.completion === "booked" ? "success" : c.completion === "tasked" ? "warning" : "neutral"}>{titleCase(c.completion)}</Pill> : null}
                      {c.missed ? <Pill size="sm" tone="danger">Needs review</Pill> : <Pill size="sm" tone="neutral">{titleCase(c.outcome || "handled")}</Pill>}
                    </div>
                    <ChevronRight className="h-4 w-4 text-vl-muted shrink-0" aria-hidden="true" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </QueryBoundary>
      </Card>
      <CallDetail api={api} tenantId={tenantId} callId={selected} onClose={close} />
    </div>
  );
}

const CallDetail = ({ api, tenantId, callId, onClose }) => {
  const q = useQuery({ queryKey: ["portal", "call", tenantId, callId], queryFn: () => api.get(`/api/owner/calls/${callId}`), enabled: !!callId });
  return (
    <Sheet open={!!callId} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="w-full sm:max-w-lg overflow-y-auto bg-vl-canvas" data-testid="call-detail-drawer">
        <SheetHeader>
          <SheetTitle className="vl-serif text-[26px]">Call details</SheetTitle>
          <SheetDescription>The story of this conversation, from your receptionist's notes.</SheetDescription>
        </SheetHeader>
        <div className="mt-5">
          <QueryBoundary query={q} skeleton={<CardSkeleton lines={6} />}>
            {(c) => (
              <div className="space-y-4">
                <div className="vl-card p-4 flex items-center gap-3">
                  <span className={`inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full ${c.missed ? "bg-vl-danger-bg text-vl-danger" : "bg-vl-success-bg text-vl-success"}`}>
                    {c.missed ? <PhoneMissed className="h-5 w-5" aria-hidden="true" /> : <Phone className="h-5 w-5" aria-hidden="true" />}
                  </span>
                  <div className="min-w-0">
                    <div className="text-[18px] font-semibold" data-testid="call-detail-caller">{c.callerDisplay}</div>
                    <div className="vl-meta">{fmtDateTime(c.createdAt)}</div>
                  </div>
                  <div className="ml-auto">{c.missed ? <Pill tone="danger">Missed</Pill> : <Pill tone="success">{titleCase(c.outcome || "handled")}</Pill>}</div>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <Stat label="Duration" value={c.missed ? "—" : fmtDuration(c.durationMs)} />
                  <Stat label="Stage" value={stageLabel(c.stage)} />
                  <Stat label="Topic" value={c.intent ? titleCase(c.intent) : "—"} />
                  <Stat label="Updated" value={fmtRelative(c.updatedAt)} />
                  <Stat label="Completion" value={c.completion ? titleCase(c.completion) : "—"} />
                  <Stat label="Known caller" value={c.existingCustomer || "New / unknown"} />
                  <Stat label="Membership" value={c.membership || "—"} />
                  <Stat label="Warranty" value={c.warranty || "—"} />
                </div>
                {has("callRecording") !== false && c.recordingUrl ? (
                  <a className="inline-flex items-center gap-2 text-[13px] underline" href={c.recordingUrl} target="_blank" rel="noreferrer">
                    <Play className="h-4 w-4" /> Play recording
                  </a>
                ) : null}
                <div className="vl-card p-4">
                  <div className="vl-eyebrow-dark mb-2">What happened</div>
                  <p className="text-[14px] leading-relaxed" data-testid="call-detail-summary">{c.transcriptSummary || "No summary was captured for this call."}</p>
                </div>
                {c.lead ? (
                  <div className="vl-card p-4">
                    <div className="vl-eyebrow-dark mb-2 inline-flex items-center gap-1.5">
                      <User className="h-3.5 w-3.5" aria-hidden="true" /> Lead captured
                    </div>
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <div className="text-[14px] font-medium">{c.lead.name || "Unnamed caller"}</div>
                        <div className="vl-meta">{c.lead.intent}</div>
                      </div>
                      <div className="flex gap-1.5">
                        <Pill size="sm">{stageLabel(c.lead.stage)}</Pill>
                        {c.lead.needsAttention ? <Pill size="sm" tone="danger">Needs attention</Pill> : null}
                      </div>
                    </div>
                  </div>
                ) : null}
                {c.callQuality ? (
                  <div className="vl-card p-4" data-testid="call-quality-card">
                    <div className="vl-eyebrow-dark mb-3 inline-flex items-center gap-1.5">
                      <Gauge className="h-3.5 w-3.5" aria-hidden="true" /> Call quality
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      {c.callQuality.score !== undefined ? <Stat label="Quality score" value={`${c.callQuality.score} / 5`} /> : null}
                      {c.callQuality.latencyMs !== undefined ? <Stat label="Response time" value={`${c.callQuality.latencyMs} ms`} /> : null}
                      {c.callQuality.interruptions !== undefined ? <Stat label="Interruptions" value={c.callQuality.interruptions} /> : null}
                      {c.callQuality.sttConfidence !== undefined ? <Stat label="Understanding" value={`${Math.round(c.callQuality.sttConfidence * 100)}%`} /> : null}
                    </div>
                    {c.callQuality.audioIssues && c.callQuality.audioIssues.length ? <div className="mt-3 vl-meta">Audio notes: {c.callQuality.audioIssues.map(titleCase).join(", ")}</div> : null}
                  </div>
                ) : null}
                {c.transcriptsDisabled ? (
                  <InlineNote icon={Info}>Transcript storage is turned off for your account, so only the summary is kept.</InlineNote>
                ) : (
                  <InlineNote icon={Clock}>Full transcripts stay private inside VeraLux. You see the summary and outcome here.</InlineNote>
                )}
              </div>
            )}
          </QueryBoundary>
        </div>
      </SheetContent>
    </Sheet>
  );
};
