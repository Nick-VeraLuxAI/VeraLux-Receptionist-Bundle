import React from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts";
import { Phone, Users, PhoneMissed, Clock, ArrowRight, ChevronRight, Play, Settings2, CheckCircle2, AlertCircle, Store, Bot, Square, Loader2, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Card, CardHeader, KpiCard } from "@/components/vl/Cards";
import { Pill, Dot, SyncPill, OnlinePill } from "@/components/vl/Pills";
import { VoiceMark, VMark } from "@/components/vl/Logo";
import { UsageList } from "@/components/vl/UsageBars";
import { KpiSkeleton, CardSkeleton, RowsSkeleton, EmptyState } from "@/components/vl/States";
import { useVoicePreview } from "@/components/vl/editors/VoiceEditor";
import { chartTheme, ChartTooltip } from "@/components/vl/editors/AnalyticsView";
import { usePortal } from "../PortalApp";
import { ApiError, errorMessage } from "@/lib/api";
import { fromAnalytics, fromSubscription, loadUsageWithLimits } from "@/lib/controlPlaneAdapters";
import { greeting, fmtRelative, fmtDateTime, fmtNumber, fmtShortDate, stageLabel, titleCase, sortCallsNewestFirst } from "@/lib/format";
import dayjs from "dayjs";

const TONE_LABEL = { neutral: "Neutral", warm: "Warm", energetic: "Energetic", calm: "Calm" };

export default function Overview() {
  const { api, tenantId, tenant, sync, health, healthOk, healthLoading, markPublished, has } = usePortal();
  const callsQ = useQuery({ queryKey: ["portal", "calls", tenantId, "overview"], queryFn: () => api.get("/api/owner/calls?limit=60") });
  const leadsQ = useQuery({ queryKey: ["portal", "leads", tenantId, 100], queryFn: () => api.get("/api/admin/leads?limit=100") });
  const analyticsQ = useQuery({ queryKey: ["portal", "analytics", tenantId, "30"], queryFn: async () => fromAnalytics(await api.get("/api/admin/analytics?days=30")), enabled: has("advancedAnalytics") !== false });
  const usageQ = useQuery({ queryKey: ["portal", "usage", tenantId], queryFn: () => loadUsageWithLimits(api, tenantId) });
  const hoursQ = useQuery({ queryKey: ["portal", "hours", tenantId], queryFn: () => api.get("/api/owner/business-hours") });
  const opQ = useQuery({ queryKey: ["portal", "operator-state", tenantId], queryFn: () => api.get("/api/owner/operator-state") });
  const subQ = useQuery({ queryKey: ["portal", "subscription", tenantId], queryFn: async () => fromSubscription(await api.get("/api/admin/subscription")) });
  const promptsQ = useQuery({ queryKey: ["portal", "prompts", tenantId], queryFn: () => api.get("/api/admin/prompts") });
  const deskQ = useQuery({ queryKey: ["portal", "completions", tenantId], queryFn: () => api.get("/api/admin/completions") });
  const cutQ = useQuery({ queryKey: ["portal", "cutover", tenantId], queryFn: () => api.get("/api/admin/cutover") });
  const ttsQ = useQuery({ queryKey: ["portal", "tts", tenantId], queryFn: () => api.get("/api/tts/config") });
  const preview = useVoicePreview(api);

  const analyticsGated = analyticsQ.isError && analyticsQ.error instanceof ApiError && analyticsQ.error.isFeatureGate;
  const a = analyticsQ.data;
  const calls = React.useMemo(() => sortCallsNewestFirst((callsQ.data && callsQ.data.calls) || []), [callsQ.data]);
  const counts = (callsQ.data && callsQ.data.counts) || {};
  const leads = (leadsQ.data && leadsQ.data.leads) || [];
  const missedNeedingReview = calls.filter((c) => c.missed && dayjs(c.createdAt).isAfter(dayjs().subtract(7, "day"))).length;

  const kpisLoading = callsQ.isPending || leadsQ.isPending || usageQ.isPending || (has("advancedAnalytics") !== false && analyticsQ.isPending);
  const delta = (cur, prev) => (prev === undefined || prev === null || !prev ? null : { text: `${cur - prev >= 0 ? "+" : ""}${Math.round(((cur - prev) / prev) * 100)}% vs prior 30d`, up: cur - prev >= 0 });

  const kpis = a
    ? [
        { icon: Phone, label: "Calls handled (30d)", value: fmtNumber(a.totals.calls), d: delta(a.totals.calls, a.previousPeriod && a.previousPeriod.calls), goodUp: true },
        { icon: Users, label: "New leads (30d)", value: fmtNumber(a.totals.leads), d: delta(a.totals.leads, a.previousPeriod && a.previousPeriod.leads), goodUp: true },
        { icon: PhoneMissed, label: "Missed calls (30d)", value: fmtNumber(a.totals.missedCalls), d: delta(a.totals.missedCalls, a.previousPeriod && a.previousPeriod.missedCalls), goodUp: false },
        { icon: Clock, label: "Minutes used", value: fmtNumber(usageQ.data && usageQ.data.usage && usageQ.data.usage.minutesUsed), d: usageQ.data ? { text: `of ${fmtNumber(usageQ.data.limits && usageQ.data.limits.includedMonthlyMinutes)} included`, neutral: true } : null },
        { icon: CheckCircle2, label: "Night desk completion", value: deskQ.data ? `${Math.round((deskQ.data.completionRate || 0) * 100)}%` : "—", d: deskQ.data ? { text: `${deskQ.data.orphanPromise || 0} orphans`, neutral: true } : null, goodUp: true },
        { icon: Store, label: "Go-live", value: cutQ.data ? (cutQ.data.live ? "Live" : "Install open") : "—", d: null },
      ]
    : [
        { icon: Phone, label: "Calls handled", value: fmtNumber(counts.total), d: null },
        { icon: Users, label: "Leads captured", value: fmtNumber(leadsQ.data && leadsQ.data.counts && leadsQ.data.counts.total), d: null },
        { icon: PhoneMissed, label: "Missed calls", value: fmtNumber(counts.missed), d: null },
        { icon: Clock, label: "Minutes used", value: fmtNumber(usageQ.data && usageQ.data.usage && usageQ.data.usage.minutesUsed), d: usageQ.data ? { text: `of ${fmtNumber(usageQ.data.limits && usageQ.data.limits.includedMonthlyMinutes)} included`, neutral: true } : null },
        { icon: CheckCircle2, label: "Night desk completion", value: deskQ.data ? `${Math.round((deskQ.data.completionRate || 0) * 100)}%` : "—", d: deskQ.data ? { text: `${deskQ.data.orphanPromise || 0} orphans`, neutral: true } : null },
        { icon: Store, label: "Go-live", value: cutQ.data ? (cutQ.data.live ? "Live" : "Install open") : "—", d: null },
      ];

  // Lead stage breakdown from real leads
  const stageOrder = ["inquiry", "qualified", "ready_to_book", "booked"];
  const stageCounts = stageOrder.map((s) => ({ stage: s, count: leads.filter((l) => (l.stage || "inquiry") === s).length }));

  // Call activity chart: analytics daily if available, else deterministic bucketing of owner calls
  const [range, setRange] = React.useState("7");
  const activity = React.useMemo(() => {
    const days = Number(range);
    const out = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = dayjs().subtract(i, "day");
      const key = d.format("YYYY-MM-DD");
      let row = { date: key, label: fmtShortDate(key), calls: 0, missed: 0 };
      if (a && a.daily) {
        const hit = a.daily.find((x) => x.date === key);
        if (hit) row = { ...row, calls: hit.calls, missed: hit.missed };
      } else {
        const dc = calls.filter((c) => c.createdAt && c.createdAt.slice(0, 10) === key);
        row = { ...row, calls: dc.length, missed: dc.filter((c) => c.missed).length };
      }
      out.push(row);
    }
    return out;
  }, [a, calls, range]);

  const hrs = hoursQ.data;
  const op = opQ.data;
  const sub = subQ.data;
  const tts = ttsQ.data;
  const receptionistName = (tts && (tts.clonedVoice && tts.defaultVoiceMode === "cloned" ? tts.clonedVoice.label : tts.voiceLabel)) || "Your receptionist";
  const greetingText = promptsQ.data && promptsQ.data.greetingText;

  return (
    <div className="space-y-5" data-testid="portal-overview">
      <div className="relative overflow-hidden rounded-card">
        <div className="vl-eyebrow mb-2">{greeting()}</div>
        <h1 className="vl-page-title">Here's how your receptionist is doing, {tenant.name}{/[.!?]$/.test(tenant.name || "") ? "" : "."}</h1>
        <p className="mt-2 text-[15px] text-vl-secondary">Live status, recent conversations, and anything that needs you.</p>
      </div>

      {kpisLoading ? (
        <KpiSkeleton />
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
          {kpis.map((k) => (
            <KpiCard key={k.label} icon={k.icon} label={k.label} value={k.value} hint={k.d ? k.d.text : undefined} tone={k.d && !k.d.neutral ? (k.d.up === k.goodUp ? "success" : "danger") : undefined} testId="portal-kpi-card" />
          ))}
        </div>
      )}

      <div className="grid grid-cols-1 xl:grid-cols-12 gap-4">
        {/* Your AI Receptionist */}
        <Card className="xl:col-span-5" testId="portal-receptionist-card">
          <CardHeader title="Your AI Receptionist" icon={Bot} action={!healthLoading ? <OnlinePill ok={healthOk} label={healthOk ? "Online" : health ? "Degraded" : "Unreachable"} /> : null} />
          {ttsQ.isPending || promptsQ.isPending ? (
            <CardSkeleton lines={5} className="border-0 p-0" />
          ) : (
            <>
              <div className="flex items-center gap-4">
                <VoiceMark size={68} animate={preview.state === "playing"} />
                <div className="min-w-0">
                  <div className="vl-serif text-[28px] leading-none truncate">{receptionistName}</div>
                  <div className="vl-meta mt-1">Your AI receptionist</div>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {tts && tts.preset ? <Pill size="sm">{TONE_LABEL[tts.preset] || titleCase(tts.preset)}</Pill> : null}
                    {tts && tts.defaultVoiceMode ? <Pill size="sm">{tts.defaultVoiceMode === "cloned" ? "Cloned voice" : "Preset voice"}</Pill> : null}
                    {tts && tts.language ? <Pill size="sm">{tts.language}</Pill> : null}
                  </div>
                </div>
              </div>
              <div className="mt-4 vl-card-soft p-3.5 flex gap-3">
                <Sparkles className="h-4 w-4 mt-0.5 text-vl-gold-deep shrink-0" aria-hidden="true" />
                <p className="text-[13px] text-vl-secondary italic" data-testid="portal-greeting-preview">
                  {greetingText ? `“${greetingText}”` : "No greeting set yet — add one in My Receptionist."}
                </p>
              </div>
              <div className="mt-4 grid grid-cols-2 gap-4 divide-x divide-vl-border">
                <div>
                  <div className="vl-label">Business status</div>
                  {hrs ? (
                    <>
                      <div className="mt-1 flex items-center gap-2 text-[14px] font-medium">
                        <Dot tone={hrs.openNow ? "success" : "neutral"} /> {hrs.openNow ? "Open now" : "Closed"}
                      </div>
                      <div className="vl-meta">{hrs.openNow && hrs.summary && hrs.summary.closesAt ? `Closes at ${hrs.summary.closesAt}` : hrs.summary && hrs.summary.nextOpen ? `Opens ${hrs.summary.nextOpen.isToday ? "today" : hrs.summary.nextOpen.day} at ${hrs.summary.nextOpen.time}` : ""}</div>
                    </>
                  ) : (
                    <div className="vl-meta mt-1">—</div>
                  )}
                </div>
                <div className="pl-4">
                  <div className="vl-label">Runtime sync</div>
                  <div className="mt-1">
                    <SyncPill sync={sync} size="sm" />
                  </div>
                  <div className="vl-meta mt-1">{sync.lastPublishedAt ? `Last published ${fmtDateTime(sync.lastPublishedAt)}` : "Not published yet"}</div>
                </div>
              </div>
              <div className="mt-5 flex flex-wrap gap-2">
                {preview.state === "playing" ? (
                  <Button onClick={preview.stop} data-testid="portal-hear-voice-button">
                    <Square className="h-4 w-4" /> Stop
                  </Button>
                ) : (
                  <Button onClick={() => preview.play()} disabled={preview.state === "pending"} data-testid="portal-hear-voice-button">
                    {preview.state === "pending" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />} {preview.state === "pending" ? "Generating…" : "Hear voice"}
                  </Button>
                )}
                <Button asChild variant="outline" data-testid="portal-configure-receptionist-button">
                  <Link to="/portal/receptionist">
                    <Settings2 className="h-4 w-4" /> Configure receptionist
                  </Link>
                </Button>
              </div>
            </>
          )}
        </Card>

        {/* Recent calls */}
        <Card className="xl:col-span-4" padded={false} testId="portal-recent-calls">
          <div className="p-5 pb-3">
            <CardHeader className="mb-0" title="Recent calls" icon={Phone} action={<Link to="/portal/calls" className="text-[13px] font-medium text-vl-gold-deep inline-flex items-center gap-1" data-testid="portal-view-all-calls">View all <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" /></Link>} />
          </div>
          {callsQ.isPending ? (
            <RowsSkeleton rows={5} className="px-5 pb-5" />
          ) : callsQ.isError ? (
            <p className="px-5 pb-5 text-[13px] text-vl-danger">{errorMessage(callsQ.error)}</p>
          ) : calls.length === 0 ? (
            <EmptyState compact icon={Phone} title="No calls yet" description="Your receptionist's conversations will show up here." />
          ) : (
            <ul className="divide-y divide-vl-border" data-testid="portal-recent-calls-list">
              {calls.slice(0, 5).map((c) => (
                <li key={c.id}>
                  <Link to={`/portal/calls?call=${c.id}`} className="flex items-center gap-3 px-5 py-3 hover:bg-vl-soft transition-colors" data-testid="portal-recent-call-row">
                    <span className={`inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full ${c.missed ? "bg-vl-danger-bg text-vl-danger" : "bg-vl-success-bg text-vl-success"}`}>
                      {c.missed ? <PhoneMissed className="h-4 w-4" aria-hidden="true" /> : <Phone className="h-4 w-4" aria-hidden="true" />}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-[14px] font-medium">{c.callerDisplay}</span>
                        <span className="vl-meta">{fmtRelative(c.createdAt)}</span>
                      </div>
                      <div className="text-[13px] text-vl-secondary truncate">{c.transcriptSummary || (c.missed ? "Missed call" : "Call handled")}</div>
                    </div>
                    {c.missed ? (
                      <Pill tone="danger" size="sm">
                        Needs review
                      </Pill>
                    ) : null}
                    <ChevronRight className="h-4 w-4 text-vl-muted shrink-0" aria-hidden="true" />
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>

        {/* Leads */}
        <Card className="xl:col-span-3" testId="portal-leads-card">
          <CardHeader title="Leads & opportunities" icon={Users} action={<Link to="/portal/leads" className="text-[13px] font-medium text-vl-gold-deep inline-flex items-center gap-1">View all <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" /></Link>} />
          {leadsQ.isPending ? (
            <RowsSkeleton rows={4} />
          ) : leads.length === 0 ? (
            <EmptyState compact icon={Users} title="No leads yet" description="Interested callers are captured here automatically." />
          ) : (
            <ul className="space-y-4">
              {stageCounts.map((s) => {
                const p = leads.length ? Math.round((s.count / leads.length) * 100) : 0;
                return (
                  <li key={s.stage} className="flex items-center gap-3" data-testid="portal-lead-stage-row">
                    <span className="w-8 text-[22px] font-semibold text-vl-gold-deep leading-none">{s.count}</span>
                    <div className="flex-1 min-w-0">
                      <div className="flex justify-between text-[13px]">
                        <span className="font-medium">{stageLabel(s.stage)}</span>
                        <span className="vl-meta">{p}%</span>
                      </div>
                      <div className="mt-1.5 h-2 rounded-full bg-vl-warm overflow-hidden">
                        <div className="h-full rounded-full bg-vl-gold" style={{ width: `${p}%` }} />
                      </div>
                    </div>
                  </li>
                );
              })}
              {leads.filter((l) => l.needsAttention).length ? (
                <li className="pt-1">
                  <Link to="/portal/leads" className="inline-flex items-center gap-1.5 text-[13px] text-vl-danger font-medium">
                    <AlertCircle className="h-3.5 w-3.5" aria-hidden="true" /> {leads.filter((l) => l.needsAttention).length} need your attention
                  </Link>
                </li>
              ) : null}
            </ul>
          )}
        </Card>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-12 gap-4">
        {/* Call activity */}
        <Card className="xl:col-span-5" testId="call-activity-chart">
          <CardHeader
            title="Call activity"
            subtitle={analyticsGated ? "From your recent calls" : "Handled vs missed"}
            action={
              <Select value={range} onValueChange={setRange}>
                <SelectTrigger className="h-8 w-[130px] text-[12px]" data-testid="call-activity-range">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="7">Last 7 days</SelectItem>
                  <SelectItem value="14">Last 14 days</SelectItem>
                  <SelectItem value="30">Last 30 days</SelectItem>
                </SelectContent>
              </Select>
            }
          />
          {callsQ.isPending ? (
            <CardSkeleton lines={5} className="border-0 p-0" />
          ) : activity.every((d) => !d.calls) ? (
            <EmptyState compact icon={Phone} title="No calls in this range" description="Activity appears as calls come in." />
          ) : (
            <div className="h-[220px] min-w-0">
              <ResponsiveContainer width="100%" height="100%" minWidth={0} initialDimension={{ width: 480, height: 200 }}>
                <BarChart data={activity} margin={{ top: 8, right: 4, left: -22, bottom: 0 }}>
                  <CartesianGrid vertical={false} stroke={chartTheme.grid} />
                  <XAxis dataKey="label" tick={chartTheme.tick} axisLine={false} tickLine={false} interval={activity.length > 14 ? 4 : 0} />
                  <YAxis tick={chartTheme.tick} axisLine={false} tickLine={false} allowDecimals={false} />
                  <Tooltip content={<ChartTooltip />} cursor={{ fill: "#f6f4ed" }} />
                  <Bar dataKey="calls" name="Calls" fill={chartTheme.gold} radius={[6, 6, 0, 0]} />
                  <Bar dataKey="missed" name="Missed" fill={chartTheme.danger} radius={[6, 6, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </Card>

        {/* Business status */}
        <Card className="xl:col-span-4" testId="portal-business-status">
          <CardHeader title="Business status" icon={Store} action={hrs ? <Pill tone={hrs.openNow ? "success" : "neutral"} icon={Clock}>{hrs.openNow ? "Open now" : "Closed"}</Pill> : null} />
          <ul className="space-y-2">
            <StatusRow ok={!!(hrs && hrs.openNow)} neutral={!(hrs && hrs.openNow)} title={hrs ? (hrs.openNow ? "Business is open" : "Business is closed") : "Loading hours…"} sub={hrs && hrs.summary ? (hrs.openNow && hrs.summary.closesAt ? `Closes at ${hrs.summary.closesAt}` : hrs.summary.nextOpen ? `Opens ${hrs.summary.nextOpen.isToday ? "today" : hrs.summary.nextOpen.day} at ${hrs.summary.nextOpen.time}` : hrs.summary.text) : ""} to="/portal/hours" />
            <StatusRow ok={missedNeedingReview === 0} danger={missedNeedingReview > 0} title={missedNeedingReview ? `${missedNeedingReview} missed call${missedNeedingReview === 1 ? "" : "s"} this week` : "No missed calls this week"} sub={missedNeedingReview ? "Review and follow up" : "Every caller was answered"} to="/portal/calls?filter=missed" testId="status-missed-calls" />
            <StatusRow ok={sync.state === "synced"} danger={sync.state === "attention"} warning={sync.state === "not_live"} title={sync.state === "synced" ? "Receptionist configuration is live" : sync.state === "not_live" ? (sync.lastPublishedAt ? "Changes not live yet" : "Receptionist not published yet") : "Receptionist needs attention"} sub={sync.lastPublishedAt ? `Published ${fmtRelative(sync.lastPublishedAt)}` : "Publish from My Receptionist"} to="/portal/receptionist" testId="status-sync" />
            <StatusRow
              ok={!!(op && op.testCall && op.testCall.completedAt)}
              warning={!!(op && !(op.testCall && op.testCall.completedAt))}
              title={op && op.testCall && op.testCall.completedAt ? "Test call complete" : "Make a test call"}
              sub={op && op.testCall && op.testCall.completedAt ? `Last run ${fmtDateTime(op.testCall.completedAt)}` : "Call your number and hear your receptionist"}
              testId="status-test-call"
              action={
                op && !(op.testCall && op.testCall.completedAt) ? (
                  <Button size="sm" variant="outline" onClick={async () => { try { await api.post("/api/owner/operator-test-call/complete"); toast.success("Test call marked complete"); opQ.refetch(); } catch (e) { toast.error(errorMessage(e)); } }} data-testid="mark-test-call-done">
                    Mark done
                  </Button>
                ) : null
              }
            />
            <StatusRow ok={!!(sub && sub.billingState === "subscribed")} warning={!!(sub && sub.billingState === "past_due")} neutral={!!(sub && (!sub.configured || sub.billingState === "unbilled"))} danger={!!(sub && sub.billingState === "canceled")} title={sub ? (sub.billingState === "unbilled" ? "NOT CONFIGURED" : sub.billingState === "subscribed" ? `${sub.planName || "Plan"} · subscribed` : sub.billingState === "past_due" ? "Payment needs attention" : `Billing ${sub.billingState}`) : "Loading billing…"} sub={sub && sub.configured && sub.currentPeriodEnd ? `Renews ${fmtShortDate(sub.currentPeriodEnd)}` : sub && !sub.configured ? "VeraLux will set this up" : ""} to="/portal/billing" testId="status-billing" />
          </ul>
        </Card>

        {/* Plan usage */}
        <Card className="xl:col-span-3" testId="portal-plan-usage">
          <CardHeader title="Plan usage" action={<Link to="/portal/billing" className="text-[13px] font-medium text-vl-gold-deep inline-flex items-center gap-1" data-testid="portal-manage-plan">Manage plan <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" /></Link>} />
          {usageQ.isPending ? <CardSkeleton lines={4} className="border-0 p-0" /> : usageQ.isError ? <p className="text-[13px] text-vl-danger">{errorMessage(usageQ.error)}</p> : <UsageList usage={usageQ.data.usage} limits={usageQ.data.limits} keys={[{ label: "Minutes used", used: usageQ.data.usage.minutesUsed, limit: usageQ.data.limits.includedMonthlyMinutes }, { label: "Concurrent now", used: usageQ.data.usage.concurrentCallsNow, limit: usageQ.data.limits.maxConcurrentCalls }, { label: "Phone numbers", used: usageQ.data.usage.phoneNumbers, limit: usageQ.data.limits.maxPhoneNumbers }]} />}
          {usageQ.data && usageQ.data.limits ? <div className="mt-4 vl-meta">{usageQ.data.limits.planName} plan</div> : null}
        </Card>
      </div>

      {/* Brand banner */}
      <div className="relative overflow-hidden vl-card p-5 sm:p-6" data-testid="portal-brand-banner">
        <div className="absolute inset-0 vl-banner-gradient pointer-events-none" aria-hidden="true" />
        <div className="relative flex flex-col sm:flex-row sm:items-center gap-5">
          <VMark size={44} />
          <div className="hidden sm:block h-12 w-px bg-vl-border" />
          <div className="min-w-0">
            <div className="vl-eyebrow">AI systems that complete the next step</div>
            <div className="vl-serif text-[24px] sm:text-[28px] leading-tight mt-1">Request. Understand. Decide. Act.</div>
          </div>
          <div className="sm:ml-auto flex items-center gap-4">
            <span className="hidden md:block text-[13px] text-vl-secondary">Turn more conversations into customers.</span>
            <Button asChild>
              <a href="mailto:support@veralux.ai">
                Get support <ArrowRight className="h-4 w-4" />
              </a>
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

const StatusRow = ({ ok, warning, danger, neutral, title, sub, to, action, testId }) => {
  const Icon = danger ? AlertCircle : warning ? AlertCircle : ok ? CheckCircle2 : Clock;
  const cls = danger ? "bg-vl-danger-bg text-vl-danger" : warning ? "bg-vl-warning-bg text-vl-warning" : ok ? "bg-vl-success-bg text-vl-success" : "bg-vl-warm text-vl-secondary";
  const body = (
    <>
      <span className={`inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${cls}`}>
        <Icon className="h-4 w-4" aria-hidden="true" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-medium">{title}</div>
        {sub ? <div className="vl-meta truncate">{sub}</div> : null}
      </div>
      {action || (to ? <ChevronRight className="h-4 w-4 text-vl-muted" aria-hidden="true" /> : null)}
    </>
  );
  const rowCls = `flex items-center gap-3 rounded-[4px] px-2.5 py-2 ${danger ? "bg-vl-danger-bg/60" : ""}`;
  return <li data-testid={testId}>{to && !action ? <Link to={to} className={`${rowCls} hover:bg-vl-soft transition-colors`}>{body}</Link> : <div className={rowCls}>{body}</div>}</li>;
};
