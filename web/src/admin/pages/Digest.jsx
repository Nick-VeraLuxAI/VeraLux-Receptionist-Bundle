import React from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts";
import { Button } from "@/components/ui/button";
import { PageHeader, Card, CardHeader, KpiCard } from "@/components/vl/Cards";
import { Pill } from "@/components/vl/Pills";
import { QueryBoundary, CardSkeleton } from "@/components/vl/States";
import { chartTheme, ChartTooltip } from "@/components/vl/editors/AnalyticsView";
import { errorMessage } from "@/lib/api";
import { callPartyLabel, fmtRelative, titleCase } from "@/lib/format";
import { useAdmin } from "../AdminApp";

const COMPLETION_TONE = {
  booked: "success",
  tasked: "neutral",
  approval_held: "gold",
  on_call_paged: "warning",
  refused: "danger",
};

export default function Digest() {
  const { api, tenantId } = useAdmin();
  const q = useQuery({ queryKey: ["digest", tenantId], queryFn: () => api.get("/api/admin/digest"), enabled: !!tenantId });
  const send = async () => {
    try {
      const res = await api.post("/api/admin/digest/send", {});
      toast.success(res.sent ? "Digest SMS sent" : "Digest built (no SMS destination)");
    } catch (e) {
      toast.error("Couldn't send digest", { description: errorMessage(e) });
    }
  };
  const exportCsv = async () => {
    try {
      const response = await api.raw("/api/admin/digest.csv");
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = "veralux-night-desk.csv";
      link.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      toast.error("Couldn't export digest", { description: errorMessage(e) });
    }
  };
  return (
    <div data-testid="admin-digest-page">
      <PageHeader serif={false} eyebrow="Selected tenant" title="Morning digest" subtitle="Yesterday's terminals, booked $, held approvals, emergencies." actions={<><Button variant="outline" onClick={exportCsv}>Export CSV</Button><Button onClick={send}>Send now</Button></>} />
      <QueryBoundary query={q} skeleton={<CardSkeleton lines={6} />}>
        {(data) => {
          const m = data.metrics || {};
          const by = m.byCompletion || {};
          const chart = data.series && data.series.length
            ? data.series
            : [{ date: data.localDate || "Last night", ...by }];
          return (
            <div className="space-y-4">
              <div className="grid gap-4 sm:grid-cols-4">
                <KpiCard label="Completions" value={m.total || 0} />
                <KpiCard label="Orphans" value={m.orphans || 0} tone={m.orphans ? "danger" : "success"} />
                <KpiCard label="Booked $" value={`$${((m.bookedCents || 0) / 100).toFixed(0)}`} />
                <KpiCard label="Held" value={data.approvalsPending || 0} />
              </div>
              <Card>
                <CardHeader title="Terminals (24h)" />
                <div className="h-[220px] min-w-0">
                  <ResponsiveContainer width="100%" height="100%" minWidth={0} initialDimension={{ width: 480, height: 200 }}>
                    <BarChart data={chart}>
                      <CartesianGrid stroke={chartTheme.grid} />
                      <XAxis dataKey="date" />
                      <YAxis allowDecimals={false} />
                      <Tooltip content={<ChartTooltip />} />
                      <Bar dataKey="booked" stackId="terminals" fill={chartTheme.gold} />
                      <Bar dataKey="approval_held" stackId="terminals" fill="#c49a4a" />
                      <Bar dataKey="on_call_paged" stackId="terminals" fill="#9b7a38" />
                      <Bar dataKey="tasked" stackId="terminals" fill="#7c8798" />
                      <Bar dataKey="refused" stackId="terminals" fill="#b85c57" />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </Card>
              <Card>
                <CardHeader title="Call links" subtitle="Owner playback is gated by the call-recording plan flag." />
                <ul className="space-y-2">
                  {(data.items || []).slice(0, 20).map((it) => (
                    <li key={it.id || it.call_id} className="flex flex-col gap-1 border-b border-vl-border py-2 last:border-0 sm:flex-row sm:items-center sm:justify-between">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <Pill size="sm" tone={COMPLETION_TONE[it.completion] || "neutral"}>{titleCase(it.completion || "tasked")}</Pill>
                          <span className="text-[13px] font-medium truncate">{callPartyLabel(it)}</span>
                        </div>
                        <div className="vl-meta mt-0.5">{it.created_at ? fmtRelative(it.created_at) : ""}</div>
                      </div>
                      <div className="flex flex-wrap gap-3 text-[13px] shrink-0">
                        <a className="text-vl-gold-deep underline" href={it.adminUrl || `/admin/calls?call=${encodeURIComponent(it.call_id || "")}`}>Open call</a>
                        {it.recordingUrl ? <a className="underline" href={it.recordingUrl} target="_blank" rel="noreferrer">Recording</a> : null}
                      </div>
                    </li>
                  ))}
                </ul>
              </Card>
            </div>
          );
        }}
      </QueryBoundary>
    </div>
  );
}
