import React from "react";
import { useQuery } from "@tanstack/react-query";
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts";
import { PageHeader, Card, CardHeader, KpiCard } from "@/components/vl/Cards";
import { Button } from "@/components/ui/button";
import { QueryBoundary, CardSkeleton } from "@/components/vl/States";
import { chartTheme, ChartTooltip } from "@/components/vl/editors/AnalyticsView";
import { usePortal } from "../PortalApp";

export default function Digest() {
  const { api, tenantId, has } = usePortal();
  const q = useQuery({ queryKey: ["portal", "digest", tenantId], queryFn: () => api.get("/api/admin/digest"), enabled: !!tenantId });
  const exportCsv = async () => {
    const response = await api.raw("/api/admin/digest.csv");
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "veralux-night-desk.csv";
    link.click();
    URL.revokeObjectURL(url);
  };
  return (
    <div data-testid="portal-digest-page">
      <PageHeader eyebrow="Insights" title="Last night" subtitle="Completions, booked dollars, held approvals, and call links." actions={<Button variant="outline" onClick={exportCsv}>Export CSV</Button>} />
      <QueryBoundary query={q} skeleton={<CardSkeleton lines={6} />}>
        {(data) => {
          const m = data.metrics || {};
          const chart = data.series && data.series.length
            ? data.series
            : [{ date: data.localDate || "Last night", ...(m.byCompletion || {}) }];
          return (
            <div className="space-y-4">
              <div className="grid gap-4 sm:grid-cols-4">
                <KpiCard label="Completions" value={m.total || 0} />
                <KpiCard label="Orphan promises" value={m.orphans || 0} tone={m.orphans ? "danger" : "success"} />
                <KpiCard label="Booked $" value={`$${((m.bookedCents || 0) / 100).toFixed(0)}`} />
                <KpiCard label="Held" value={data.approvalsPending || 0} />
              </div>
              <Card>
                <CardHeader title="How last night closed" />
                <div className="h-[220px]">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={chart}>
                      <CartesianGrid stroke={chartTheme.grid} />
                      <XAxis dataKey="date" />
                      <YAxis allowDecimals={false} />
                      <Tooltip content={<ChartTooltip />} />
                      <Bar dataKey="booked" stackId="terminals" fill={chartTheme.bar} />
                      <Bar dataKey="approval_held" stackId="terminals" fill="#c49a4a" />
                      <Bar dataKey="on_call_paged" stackId="terminals" fill="#9b7a38" />
                      <Bar dataKey="tasked" stackId="terminals" fill="#7c8798" />
                      <Bar dataKey="refused" stackId="terminals" fill="#b85c57" />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </Card>
              <Card>
                <CardHeader title="Calls" subtitle={has("callRecording") ? "Recording links included on your plan." : "Upgrade recording to play back audio."} />
                <ul className="space-y-1 text-[13px]">
                  {(data.items || []).slice(0, 20).map((it) => (
                    <li key={it.id || it.call_id}>
                      {it.completion} · <a className="underline" href={it.portalUrl || "/portal/calls"}>Open in Calls</a>
                      {has("callRecording") && it.recordingUrl ? (
                        <> · <a className="underline" href={it.recordingUrl} target="_blank" rel="noreferrer">Play recording</a></>
                      ) : null}
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
