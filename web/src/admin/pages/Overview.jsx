import React from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Building2, Activity, Server, Cpu, Mic, AudioLines, ArrowRight, Bot, Phone, UploadCloud, Hash, CreditCard, ScrollText, ExternalLink, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PageHeader, Card, CardHeader, KpiCard, Stat, InlineNote } from "@/components/vl/Cards";
import { Pill, SyncPill, BillingStatePill, ServicePill, StatusChip } from "@/components/vl/Pills";
import { UsageList } from "@/components/vl/UsageBars";
import { CardSkeleton, KpiSkeleton, RowsSkeleton, QueryBoundary } from "@/components/vl/States";
import { PublishBar } from "@/components/vl/PublishBar";
import { useAdmin } from "../AdminApp";
import { TenantContextBar } from "../AdminShell";
import { fmtRelative, fmtNumber, fmtDateTime, titleCase, sortCallsNewestFirst } from "@/lib/format";
import { ApiError } from "@/lib/api";
import { fromRuntimeHealth, fromSubscription, isServiceStatusOk, loadUsageWithLimits } from "@/lib/controlPlaneAdapters";

export default function Overview() {
  const { api, tenants, tenantsQ, tenantId, tenant, caps, health, healthOk, healthLoading, sync, markPublished } = useAdmin();
  const runtimeQ = useQuery({ queryKey: ["admin", "runtime-health"], queryFn: () => api.get("/api/admin/runtime/health"), refetchInterval: 60_000 });
  const auditQ = useQuery({ queryKey: ["admin", "audit", 8], queryFn: () => api.get("/api/admin/audit?limit=8"), enabled: caps.audit !== false });
  const usageQ = useQuery({ queryKey: ["admin", "usage", tenantId], queryFn: () => loadUsageWithLimits(api, tenantId), enabled: !!tenantId });
  const subQ = useQuery({ queryKey: ["admin", "subscription", tenantId], queryFn: async () => fromSubscription(await api.get("/api/admin/subscription")), enabled: !!tenantId });
  const callsQ = useQuery({ queryKey: ["admin", "calls", tenantId, 5], queryFn: () => api.get("/api/admin/calls?limit=5"), enabled: !!tenantId });
  const opQ = useQuery({ queryKey: ["admin", "operator-state", tenantId], queryFn: () => api.get(`/api/admin/tenants/${tenantId}/operator-state`), enabled: !!tenantId });
  const deskQ = useQuery({ queryKey: ["admin", "completions", tenantId], queryFn: () => api.get("/api/admin/completions"), enabled: !!tenantId });
  const cutQ = useQuery({ queryKey: ["admin", "cutover", tenantId], queryFn: () => api.get("/api/admin/cutover"), enabled: !!tenantId });

  const rt = runtimeQ.data ? fromRuntimeHealth(runtimeQ.data) : runtimeQ.data;
  const runtimeOk = runtimeQ.isError ? false : rt ? rt.ok === true : null;
  const degraded = healthOk === false || runtimeOk === false;
  const past_due = tenants.length ? null : null; // aggregation across tenants is not supported by the API; do not fabricate.

  return (
    <div className="space-y-5" data-testid="admin-overview">
      <PageHeader serif={false} eyebrow="VeraLux Platform" title="Operations overview" subtitle="Platform health across services, and the tenant you're currently working in." />

      {degraded ? (
        <InlineNote tone="danger" icon={AlertTriangle} testId="platform-degraded-banner">
          <span className="font-medium">Platform health is degraded.</span> Check the service status below before making tenant changes.
        </InlineNote>
      ) : null}

      {tenantsQ.isPending || healthLoading || runtimeQ.isPending ? (
        <KpiSkeleton />
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
          <KpiCard icon={Building2} label="Tenants" value={fmtNumber(tenants.length)} hint="from tenant directory" testId="admin-kpi-tenants" />
          <KpiCard icon={Activity} label="Active calls (platform)" value={fmtNumber(health && health.activeCalls)} hint={health ? `as of ${fmtRelative(health.timestamp)}` : undefined} testId="admin-kpi-active-calls" />
          <KpiCard icon={Server} label="Runtime (Redis)" value={runtimeOk === null ? "—" : runtimeOk ? "Healthy" : "Degraded"} hint={rt && rt.redis ? `${rt.redis.latencyMs} ms · ${rt.publishedTenants} published` : runtimeQ.isError ? "unreachable" : undefined} tone={runtimeOk === false ? "danger" : "success"} testId="admin-kpi-runtime" />
          <KpiCard icon={Cpu} label="Voice services" value={healthOk ? "All OK" : "Issue"} hint={health ? `LLM ${health.llm && health.llm.status} · STT ${health.stt && health.stt.status} · TTS ${health.tts && health.tts.status}` : undefined} tone={healthOk ? "success" : "danger"} testId="admin-kpi-services" />
        </div>
      )}

      <div className="grid gap-4 xl:grid-cols-12">
        <Card className="xl:col-span-4" testId="service-health-card">
          <CardHeader title="Service health" icon={Activity} />
          {healthLoading ? (
            <RowsSkeleton rows={4} />
          ) : (
            <ul className="space-y-2.5">
              {[
                ["LLM", Cpu, health && health.llm],
                ["Speech to text", Mic, health && health.stt],
                ["Text to speech", AudioLines, health && health.tts],
                ["Runtime store", Server, rt ? { status: rt.status, ...(rt.redis || {}) } : null],
              ].map(([label, Icon, s]) => (
                <li key={label} className="flex items-center gap-3 text-[13px]">
                  <Icon className="h-4 w-4 text-vl-secondary" aria-hidden="true" />
                  <span className="font-medium flex-1">{label}</span>
                  <span className="vl-meta">{s && (s.provider || s.engine || s.role) ? s.provider || s.engine || s.role : ""}{s && s.model ? ` · ${s.model}` : ""}{s && s.latencyMs !== undefined ? ` · ${s.latencyMs} ms` : ""}</span>
                  <StatusChip ok={!!s && isServiceStatusOk(s.status)} okLabel="OK" badLabel={s ? titleCase(s.status || "error") : "Unknown"} />
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card className="xl:col-span-8" testId="selected-tenant-card">
          <TenantContextBar title={tenant ? tenant.name : "No tenant selected"} subtitle={tenant ? `Created ${fmtRelative(tenant.createdAt)} · ${(tenant.numbers || []).length} number${(tenant.numbers || []).length === 1 ? "" : "s"}` : "Pick a tenant from the selector to see its status."} actions={tenant ? <Button asChild variant="outline" size="sm"><Link to={`/admin/tenants/${tenant.id}`}>Tenant detail <ArrowRight className="h-4 w-4" /></Link></Button> : null} />
          {tenant ? (
            <>
              <div className="grid gap-4 md:grid-cols-2">
                <div className="vl-card-soft p-4">
                  <div className="vl-eyebrow-dark mb-2">Plan & billing</div>
                  <QueryBoundary query={usageQ} skeleton={<CardSkeleton lines={3} className="border-0 p-0" />} compact>
                    {(u) => (
                      <>
                        <div className="flex items-center gap-2 flex-wrap mb-3">
                          <Pill tone="gold">{u.limits.planName}</Pill>
                          <ServicePill status={u.limits.billingStatus} size="sm" />
                          <BillingStatePill state={(subQ.data && subQ.data.billingState) || "unbilled"} size="sm" />
                        </div>
                        <UsageList usage={u.usage} limits={u.limits} keys={[{ label: "Minutes", used: u.usage.minutesUsed, limit: u.limits.includedMonthlyMinutes }, { label: "Calls this month", used: u.usage.callsThisMonth, limit: u.limits.maxMonthlyCalls }, { label: "Phone numbers", used: u.usage.phoneNumbers, limit: u.limits.maxPhoneNumbers }]} />
                      </>
                    )}
                  </QueryBoundary>
                </div>
                <div className="vl-card-soft p-4 space-y-3">
                  <div className="vl-eyebrow-dark">Receptionist</div>
                  <div className="flex items-center gap-2 flex-wrap">
                    <SyncPill sync={sync} />
                    <span className="vl-meta">{sync.lastPublishedAt ? `Published ${fmtRelative(sync.lastPublishedAt)}` : "Never published"}</span>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <Stat label="Numbers" value={(tenant.numbers || []).join(", ") || "None"} />
                    <Stat label="Business number" value={tenant.businessNumber || "—"} />
                    <Stat label="Test call" value={opQ.data ? (opQ.data.testCall && opQ.data.testCall.completedAt ? `Done ${fmtRelative(opQ.data.testCall.completedAt)}` : "Not yet") : "…"} />
                    <Stat label="Owner login" value={opQ.data ? (opQ.data.onboarding && opQ.data.onboarding.credentialsSet ? "Set" : "Missing") : "…"} />
                    <Stat label="Completion rate" value={deskQ.data ? `${Math.round((deskQ.data.completionRate || 0) * 100)}%` : "…"} />
                    <Stat label="Orphans" value={deskQ.data ? String(deskQ.data.orphanPromise || 0) : "…"} />
                    <Stat label="Go-live" value={cutQ.data ? (cutQ.data.live ? "Live" : "Cutover open") : "…"} />
                  </div>
                  <PublishBar compact api={api} tenantId={tenantId} sync={sync} onPublished={markPublished} label="Publish runtime" />
                </div>
              </div>
              <div className="mt-4 flex flex-wrap gap-2" data-testid="tenant-quick-actions">
                <QuickAction to="/admin/rules" icon={Bot} label="Shop rules" />
                <QuickAction to="/admin/receptionist" icon={Bot} label="Manage receptionist" />
                <QuickAction to="/admin/calls" icon={Phone} label="View calls" />
                {caps.carrier !== false ? <QuickAction to="/admin/numbers" icon={Hash} label="Manage numbers" /> : null}
                <QuickAction to="/admin/billing" icon={CreditCard} label="Billing" />
                <Button asChild variant="ghost" size="sm">
                  <a href="/portal/login" target="_blank" rel="noreferrer">
                    <ExternalLink className="h-4 w-4" /> Customer portal
                  </a>
                </Button>
              </div>
            </>
          ) : null}
        </Card>
      </div>

      <div className="grid gap-4 xl:grid-cols-12">
        <Card className="xl:col-span-7" padded={false} testId="recent-calls-card">
          <div className="p-5 pb-3">
            <CardHeader className="mb-0" title="Latest calls for this tenant" icon={Phone} action={<Link to="/admin/calls" className="text-[13px] font-medium text-vl-gold-deep">All calls</Link>} />
          </div>
          {!tenantId ? (
            <p className="px-5 pb-5 vl-meta">Select a tenant.</p>
          ) : (
            <QueryBoundary query={callsQ} skeleton={<RowsSkeleton rows={5} className="px-5 pb-5" />} compact emptyWhen={(d) => !(d.calls || []).length} empty={<p className="px-5 pb-5 vl-meta">No calls recorded yet.</p>}>
              {(d) => (
                <table className="w-full text-[13px] vl-table">
                  <thead>
                    <tr className="text-left border-t border-b border-vl-border">
                      <th className="py-2 px-5">Caller</th>
                      <th className="py-2 pr-3">Summary</th>
                      <th className="py-2 pr-3">Stage</th>
                      <th className="py-2 pr-5">When</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sortCallsNewestFirst(d.calls).map((c) => (
                      <tr key={c.id} className="border-b border-vl-border last:border-0">
                        <td className="py-2 px-5 font-medium whitespace-nowrap">{c.callerId}{c.missed ? <Pill size="sm" tone="danger" className="ml-2">Missed</Pill> : null}</td>
                        <td className="py-2 pr-3 text-vl-secondary max-w-[360px] truncate">{c.transcriptSummary}</td>
                        <td className="py-2 pr-3">{titleCase(c.stage)}</td>
                        <td className="py-2 pr-5 text-vl-muted whitespace-nowrap">{fmtRelative(c.createdAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </QueryBoundary>
          )}
        </Card>

        <Card className="xl:col-span-5" padded={false} testId="recent-audit-card">
          <div className="p-5 pb-3">
            <CardHeader className="mb-0" title="Recent operator activity" icon={ScrollText} action={caps.audit !== false ? <Link to="/admin/audit" className="text-[13px] font-medium text-vl-gold-deep">Audit log</Link> : null} />
          </div>
          {caps.audit === false ? (
            <p className="px-5 pb-5 vl-meta">Audit history is available to superadmins.</p>
          ) : (
            <QueryBoundary query={auditQ} skeleton={<RowsSkeleton rows={5} className="px-5 pb-5" />} compact>
              {(d) => (
                <ul className="divide-y divide-vl-border">
                  {(d.entries || []).map((e) => (
                    <li key={e.id} className="px-5 py-2.5 text-[13px] flex items-start gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="font-medium">{e.action}</div>
                        <div className="vl-meta truncate">{e.actor}{e.tenantId ? ` · ${e.tenantId}` : ""}</div>
                      </div>
                      <span className="vl-meta whitespace-nowrap" title={fmtDateTime(e.at)}>{fmtRelative(e.at)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </QueryBoundary>
          )}
        </Card>
      </div>
    </div>
  );
}

const QuickAction = ({ to, icon: Icon, label }) => (
  <Button asChild variant="outline" size="sm">
    <Link to={to}>
      <Icon className="h-4 w-4" /> {label}
    </Link>
  </Button>
);
