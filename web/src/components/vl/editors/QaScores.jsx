import React from "react";
import { Phone, ExternalLink, AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, KpiCard } from "@/components/vl/Cards";
import { Pill } from "@/components/vl/Pills";
import { EmptyState } from "@/components/vl/States";
import { fmtDateTime, fmtMoney } from "@/lib/format";
import { cn } from "@/lib/utils";

const OUTCOME_TONE = {
  booked: "success",
  tasked: "neutral",
  approval_held: "gold",
  on_call_paged: "warning",
  refused: "danger",
};

export function QaScores({ data, callHref }) {
  const all = data.scores || [];
  const reviewCount = data.needsReview ?? all.filter((s) => s.needsReview).length;
  const [filter, setFilter] = React.useState(reviewCount ? "review" : "all");
  const rows = filter === "review" ? all.filter((s) => s.needsReview) : all;

  if (!all.length) {
    return <EmptyState title="No coaching scores yet" description="After night-desk calls close, you will see who called, what they needed, and whether you need to do anything." />;
  }

  return (
    <div className="space-y-4" data-testid="qa-scores">
      <div className="grid gap-3 sm:grid-cols-3">
        <KpiCard label="Need a human" value={reviewCount} tone={reviewCount ? "danger" : "success"} testId="qa-kpi-review" />
        <KpiCard label="Average score" value={data.averageScore ?? "—"} testId="qa-kpi-average" />
        <KpiCard label="Scored calls" value={all.length} testId="qa-kpi-total" />
      </div>
      <Card>
        <CardHeader title="Recent coaching" subtitle="Failed checks become a next step. Clean calls tell you what was booked or tasked." />
        <div className="mb-4 inline-flex rounded-full bg-vl-warm p-1" role="tablist" aria-label="QA filter">
          {[
            ["review", `Needs you (${reviewCount})`],
            ["all", `All (${all.length})`],
          ].map(([id, label]) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={filter === id}
              onClick={() => setFilter(id)}
              className={cn("rounded-full px-3.5 py-1.5 text-[13px] font-medium", filter === id ? "bg-white border border-vl-border shadow-xs" : "text-vl-secondary")}
              data-testid={`qa-filter-${id}`}
            >
              {label}
            </button>
          ))}
        </div>
        {rows.length === 0 ? (
          <EmptyState compact title="Nothing needs you" description="Every scored call already has a written next step." />
        ) : (
          <ul className="space-y-3">
            {rows.map((s) => {
              const fails = (s.findings || []).filter((f) => !f.passed);
              const href = callHref ? callHref(s.callId) : `/admin/calls?call=${encodeURIComponent(s.callId || "")}`;
              return (
                <li key={s.id || s.callId} className="rounded-[4px] border border-vl-border p-3" data-testid="qa-score-row">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <Pill size="sm" tone={OUTCOME_TONE[s.outcome] || "neutral"}>{s.outcomeLabel || "Outcome unknown"}</Pill>
                        {s.needsReview ? <Pill size="sm" tone="danger" icon={AlertCircle}>Needs you</Pill> : <Pill size="sm" tone="success">Clean</Pill>}
                      </div>
                      <div className="mt-1.5 text-[15px] font-medium">{s.callerDisplay || "Caller"}</div>
                      <div className="vl-meta mt-0.5">
                        {s.issue ? <span>{s.issue} · </span> : null}
                        {s.bookedCents ? <span>{fmtMoney(s.bookedCents)} · </span> : null}
                        {fmtDateTime(s.createdAt)}
                      </div>
                    </div>
                    <div className="shrink-0 text-right">
                      <div className="text-[22px] font-semibold tabular-nums leading-none">{s.score}</div>
                      <div className="vl-meta mt-1">score</div>
                    </div>
                  </div>
                  <p className="mt-3 text-[14px] leading-snug">{s.headline}</p>
                  {s.nextAction ? (
                    <p className="mt-2 text-[13px] text-vl-text">
                      <span className="font-medium">Do this: </span>
                      {s.nextAction}
                    </p>
                  ) : null}
                  {s.summary ? <p className="mt-2 vl-meta break-words">{s.summary}</p> : null}
                  {fails.length ? (
                    <ul className="mt-3 space-y-1.5">
                      {fails.map((f) => (
                        <li key={f.key} className="text-[13px]">
                          <span className="font-medium text-vl-danger">{f.label}.</span>{" "}
                          <span className="text-vl-secondary">{f.action || f.detail}</span>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  <div className="mt-3 flex flex-wrap gap-2">
                    <Button asChild variant="outline" size="sm">
                      <a href={href}>
                        <Phone className="h-3.5 w-3.5" /> Open call
                      </a>
                    </Button>
                    {s.recordingUrl ? (
                      <Button asChild variant="ghost" size="sm">
                        <a href={s.recordingUrl} target="_blank" rel="noreferrer">
                          <ExternalLink className="h-3.5 w-3.5" /> Recording
                        </a>
                      </Button>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </div>
  );
}

