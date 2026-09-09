import React from "react";
import { useQuery } from "@tanstack/react-query";
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from "recharts";
import { Phone, PhoneMissed, Users, Clock, Timer, CalendarCheck } from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Card, CardHeader, KpiCard } from "@/components/vl/Cards";
import { QueryBoundary, KpiSkeleton, EmptyState } from "@/components/vl/States";
import { fmtNumber, fmtShortDate, titleCase, stageLabel } from "@/lib/format";
import { fromAnalytics } from "@/lib/controlPlaneAdapters";

export const chartTheme = {
  grid: "rgba(18, 17, 16, 0.10)",
  tick: { fill: "#736f68", fontSize: 11 },
  gold: "#c59b48",
  goldLight: "#e2c27c",
  danger: "#9f3d34",
  charcoal: "#423f3b",
  bar: "#c59b48",
};

export const ChartTooltip = ({ active, payload, label }) => {
  if (!active || !payload || !payload.length) return null;
  return (
    <div className="rounded-[4px] border border-vl-border bg-white px-3 py-2 text-[12px] shadow-vl">
      <div className="font-medium mb-1">{label}</div>
      {payload.map((p) => (
        <div key={p.dataKey} className="flex items-center gap-2 text-vl-secondary">
          <span className="inline-block h-2 w-2 rounded-full" style={{ background: p.color || p.fill }} />
          {p.name}: <span className="text-vl-text font-medium">{fmtNumber(p.value)}</span>
        </div>
      ))}
    </div>
  );
};

/** Deterministic delta vs previous period from API data. */
const delta = (cur, prev) => {
  if (prev === undefined || prev === null) return null;
  if (!prev) return cur ? { text: "new", tone: "neutral" } : null;
  const d = Math.round(((cur - prev) / prev) * 100);
  return { text: `${d >= 0 ? "+" : ""}${d}% vs prior period`, tone: d >= 0 ? "success" : "neutral" };
};

export const AnalyticsView = ({ api, mode, tenantId, upgradeHref }) => {
  const [days, setDays] = React.useState("30");
  const q = useQuery({ queryKey: [mode, "analytics", tenantId, days], queryFn: async () => fromAnalytics(await api.get(`/api/admin/analytics?days=${days}`)), enabled: !!tenantId });

  return (
    <div className="space-y-5" data-testid="analytics-view">
      <div className="flex items-center justify-end">
        <Select value={days} onValueChange={setDays}>
          <SelectTrigger className="w-[150px] bg-white" data-testid="analytics-range">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="7">Last 7 days</SelectItem>
            <SelectItem value="30">Last 30 days</SelectItem>
            <SelectItem value="90">Last 90 days</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <QueryBoundary query={q} skeleton={<KpiSkeleton count={6} />} upgradeHref={upgradeHref}>
        {(a) => {
          const t = a.totals || {};
          const p = a.previousPeriod || {};
          const missedDelta = delta(t.missedCalls, p.missedCalls);
          const kpis = [
            { icon: Phone, label: "Calls handled", value: fmtNumber(t.calls), d: delta(t.calls, p.calls) },
            { icon: PhoneMissed, label: "Missed calls", value: fmtNumber(t.missedCalls), d: missedDelta ? { ...missedDelta, tone: missedDelta.tone === "success" ? "danger" : "success" } : null },
            { icon: Users, label: "Leads captured", value: fmtNumber(t.leads), d: delta(t.leads, p.leads) },
            { icon: Clock, label: "Minutes", value: fmtNumber(t.minutes), d: delta(t.minutes, p.minutes) },
            { icon: Timer, label: "Avg call length", value: t.avgDurationSec ? `${Math.floor(t.avgDurationSec / 60)}m ${t.avgDurationSec % 60}s` : "—", d: null },
            { icon: CalendarCheck, label: "Booked", value: fmtNumber(t.booked), d: delta(t.booked, p.booked) },
          ];
          const daily = (a.daily || []).map((d) => ({ ...d, label: fmtShortDate(d.date) }));
          const hasData = (t.calls || 0) > 0;
          return (
            <>
              <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4">
                {kpis.map((k) => (
                  <KpiCard key={k.label} icon={k.icon} label={k.label} value={k.value} hint={k.d ? k.d.text : undefined} tone={k.d ? k.d.tone : undefined} testId="analytics-kpi" />
                ))}
              </div>
              {!hasData ? (
                <Card>
                  <EmptyState icon={Phone} title="No calls in this period" description="Charts will fill in as your receptionist handles calls." />
                </Card>
              ) : (
                <>
                  <Card testId="analytics-daily-chart">
                    <CardHeader title="Calls per day" subtitle="Handled vs missed" />
                    <div className="h-[260px] min-w-0">
                      <ResponsiveContainer width="100%" height="100%" minWidth={0} initialDimension={{ width: 480, height: 200 }}>
                        <BarChart data={daily} margin={{ top: 8, right: 8, left: -18, bottom: 0 }} barGap={2}>
                          <CartesianGrid vertical={false} stroke={chartTheme.grid} />
                          <XAxis dataKey="label" tick={chartTheme.tick} axisLine={false} tickLine={false} interval={daily.length > 31 ? 6 : daily.length > 10 ? 3 : 0} />
                          <YAxis tick={chartTheme.tick} axisLine={false} tickLine={false} allowDecimals={false} />
                          <Tooltip content={<ChartTooltip />} cursor={{ fill: "#f6f4ed" }} />
                          <Legend iconType="circle" wrapperStyle={{ fontSize: 12 }} />
                          <Bar dataKey="calls" name="Calls" fill={chartTheme.gold} radius={[6, 6, 0, 0]} />
                          <Bar dataKey="missed" name="Missed" fill={chartTheme.danger} radius={[6, 6, 0, 0]} />
                        </BarChart>
                      </ResponsiveContainer>
                    </div>
                  </Card>
                  <div className="grid gap-4 lg:grid-cols-3">
                    <Card testId="analytics-hourly-chart">
                      <CardHeader title="Busiest hours" subtitle="Calls by hour of day (UTC)" />
                      <div className="h-[200px] min-w-0">
                        <ResponsiveContainer width="100%" height="100%" minWidth={0} initialDimension={{ width: 480, height: 200 }}>
                          <BarChart data={(a.byHour || []).map((h) => ({ ...h, label: `${h.hour}:00` }))} margin={{ top: 8, right: 8, left: -18, bottom: 0 }}>
                            <CartesianGrid vertical={false} stroke={chartTheme.grid} />
                            <XAxis dataKey="label" tick={chartTheme.tick} axisLine={false} tickLine={false} interval={3} />
                            <YAxis tick={chartTheme.tick} axisLine={false} tickLine={false} allowDecimals={false} />
                            <Tooltip content={<ChartTooltip />} cursor={{ fill: "#f6f4ed" }} />
                            <Bar dataKey="calls" name="Calls" fill={chartTheme.goldLight} radius={[4, 4, 0, 0]} />
                          </BarChart>
                        </ResponsiveContainer>
                      </div>
                    </Card>
                    <Card testId="analytics-intents">
                      <CardHeader title="What callers ask about" />
                      <Breakdown rows={(a.intents || []).map((i) => ({ label: titleCase(i.intent), count: i.count }))} total={t.calls} />
                    </Card>
                    <Card testId="analytics-outcomes">
                      <CardHeader title="Outcomes & lead stages" />
                      <Breakdown rows={(a.outcomes || []).map((o) => ({ label: titleCase(o.outcome), count: o.count }))} total={t.calls} />
                      {(a.leadStages || []).length ? (
                        <>
                          <div className="vl-eyebrow-dark mt-4 mb-2">Lead stages</div>
                          <Breakdown rows={a.leadStages.map((s) => ({ label: stageLabel(s.stage), count: s.count }))} total={t.leads} />
                        </>
                      ) : null}
                    </Card>
                  </div>
                </>
              )}
            </>
          );
        }}
      </QueryBoundary>
    </div>
  );
};

export const Breakdown = ({ rows, total }) => (
  <ul className="space-y-2.5">
    {rows.length === 0 ? <li className="vl-meta">No data</li> : null}
    {rows.map((r) => {
      const p = total ? Math.round((r.count / total) * 100) : 0;
      return (
        <li key={r.label} className="flex items-center gap-3 text-[13px]">
          <span className="w-7 text-right font-semibold">{r.count}</span>
          <div className="flex-1 min-w-0">
            <div className="flex justify-between gap-2">
              <span className="truncate">{r.label}</span>
              <span className="vl-meta">{p}%</span>
            </div>
            <div className="mt-1 h-1.5 rounded-full bg-vl-warm overflow-hidden">
              <div className="h-full rounded-full bg-vl-gold" style={{ width: `${p}%` }} />
            </div>
          </div>
        </li>
      );
    })}
  </ul>
);
