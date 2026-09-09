import React from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Bot, Phone, Hash, CreditCard, ExternalLink, Pencil, KeyRound, CheckCircle2, AlertCircle, Layers, PhoneCall } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, Stat, InlineNote } from "@/components/vl/Cards";
import { Pill, SyncPill, BillingStatePill, ServicePill, OnlinePill } from "@/components/vl/Pills";
import { UsageList } from "@/components/vl/UsageBars";
import { QueryBoundary, CardSkeleton, ErrorState } from "@/components/vl/States";
import { PublishBar } from "@/components/vl/PublishBar";
import { useAdmin } from "../AdminApp";
import { TenantContextBar } from "../AdminShell";
import { TenantSheet, CredentialsSheet, DeleteTenantControl } from "./Tenants";
import { fmtDateTime, fmtRelative, titleCase } from "@/lib/format";
import { errorMessage } from "@/lib/api";
import { fromSubscription, loadUsageWithLimits } from "@/lib/controlPlaneAdapters";

export default function TenantDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { api, tenants, tenantsQ, tenantId, setTenantId, caps, sync, markPublished, healthOk, healthLoading, health } = useAdmin();
  React.useEffect(() => {
    if (id && id !== tenantId && tenants.some((t) => t.id === id)) setTenantId(id);
  }, [id, tenantId, tenants, setTenantId]);
  const tenant = tenants.find((t) => t.id === id);
  const active = tenantId === id;
  const [editing, setEditing] = React.useState(false);
  const [creds, setCreds] = React.useState(false);

  const usageQ = useQuery({ queryKey: ["admin", "usage", id], queryFn: () => loadUsageWithLimits(api, id), enabled: active });
  const subQ = useQuery({ queryKey: ["admin", "subscription", id], queryFn: async () => fromSubscription(await api.get("/api/admin/subscription")), enabled: active });
  const opQ = useQuery({ queryKey: ["admin", "operator-state", id], queryFn: () => api.get(`/api/admin/tenants/${id}/operator-state`), enabled: active });
  const portalQ = useQuery({ queryKey: ["admin", "owner-portal-status", id], queryFn: () => api.get(`/api/admin/tenants/${id}/owner-portal-status`), enabled: active });
  const didsQ = useQuery({
    queryKey: ["admin", "dids", id, (tenant && tenant.numbers) || []],
    enabled: active && caps.carrier === true && !!tenant,
    queryFn: async () => Promise.all((tenant.numbers || []).map((n) => api.get(`/api/admin/runtime/dids/${encodeURIComponent(n)}`).catch((e) => ({ didE164: n, error: errorMessage(e) })))),
  });

  if (tenantsQ.isPending) return <CardSkeleton lines={6} />;
  if (!tenant) return <ErrorState error={new Error("Tenant not found or not in your scope.")} title="Tenant not found" />;

  return (
    <div data-testid="admin-tenant-detail">
      <TenantContextBar
        title={tenant.name}
        subtitle={`Created ${fmtDateTime(tenant.createdAt)} · Updated ${fmtRelative(tenant.updatedAt)}`}
        actions={
          <>
            <Button variant="outline" size="sm" onClick={() => setCreds(true)} data-testid="detail-owner-login">
              <KeyRound className="h-4 w-4" /> Owner login
            </Button>
            <Button variant="outline" size="sm" onClick={() => setEditing(true)} data-testid="detail-edit-tenant">
              <Pencil className="h-4 w-4" /> Edit tenant
            </Button>
            <DeleteTenantControl
              api={api}
              tenant={tenant}
              variant="outline"
              onDeleted={(deleted) => {
                const remaining = ((tenantsQ.data && tenantsQ.data.tenants) || []).filter((x) => x.id !== deleted.id);
                if (deleted.id === tenantId) setTenantId(remaining[0] ? remaining[0].id : null);
                tenantsQ.refetch();
                navigate("/admin/tenants");
              }}
            />
          </>
        }
      />

      <div className="grid gap-4 xl:grid-cols-12">
        <Card className="xl:col-span-4" testId="detail-identity">
          <CardHeader title="Identity & numbers" icon={Hash} />
          <div className="space-y-3">
            <Stat label="Tenant id" value={<code className="text-[13px]">{tenant.id}</code>} />
            <Stat label="Business number" value={tenant.businessNumber || "—"} />
            <div>
              <div className="vl-label mb-1.5">Receptionist numbers</div>
              {(tenant.numbers || []).length === 0 ? <InlineNote tone="warning" icon={AlertCircle}>No number assigned. Use Numbers to provision and map one.</InlineNote> : null}
              <ul className="space-y-1.5">
                {(tenant.numbers || []).map((n) => {
                  const d = didsQ.data && didsQ.data.find((x) => x.didE164 === n);
                  return (
                    <li key={n} className="flex items-center justify-between gap-2 rounded-lg border border-vl-border bg-vl-soft px-3 py-2 text-[13px]" data-testid="detail-number-row">
                      <span className="font-mono">{n}</span>
                      {caps.carrier === true ? d ? d.error ? <Pill size="sm" tone="neutral">{d.error}</Pill> : d.mapped && d.tenantId === tenant.id ? <Pill size="sm" tone="success" icon={CheckCircle2}>DID mapped</Pill> : d.mapped ? <Pill size="sm" tone="danger" icon={AlertCircle}>Mapped to {d.tenantId}</Pill> : <Pill size="sm" tone="warning" icon={AlertCircle}>Not mapped</Pill> : <span className="vl-meta">checking…</span> : null}
                    </li>
                  );
                })}
              </ul>
            </div>
            {caps.carrier !== false ? (
              <Button asChild variant="outline" size="sm" className="w-full">
                <Link to="/admin/numbers">
                  <Hash className="h-4 w-4" /> Manage numbers & DID mapping
                </Link>
              </Button>
            ) : null}
          </div>
        </Card>

        <Card className="xl:col-span-4" testId="detail-plan">
          <CardHeader title="Plan & usage" icon={Layers} action={<Button asChild variant="ghost" size="sm"><Link to="/admin/plans">Edit limits</Link></Button>} />
          <QueryBoundary query={usageQ} skeleton={<CardSkeleton lines={4} className="border-0 p-0" />} compact>
            {(u) => (
              <>
                <div className="flex flex-wrap items-center gap-2 mb-4">
                  <Pill tone="gold">{u.limits.planName}</Pill>
                  <ServicePill status={u.limits.billingStatus} size="sm" />
                  <BillingStatePill state={(subQ.data && subQ.data.billingState) || "unbilled"} size="sm" />
                  <Pill size="sm">{titleCase(u.limits.overageMode)}</Pill>
                </div>
                <UsageList usage={u.usage} limits={u.limits} />
                <div className="mt-4 grid grid-cols-2 gap-3">
                  <Stat label="Included left" value={`${u.includedMinutesRemaining} min`} />
                  <Stat label="Overage" value={`${u.overageMinutes} min`} />
                </div>
              </>
            )}
          </QueryBoundary>
        </Card>

        <Card className="xl:col-span-4" testId="detail-runtime">
          <CardHeader title="Receptionist & runtime" icon={Bot} action={!healthLoading ? <OnlinePill ok={healthOk} label={healthOk ? "Runtime OK" : health ? "Degraded" : "Unreachable"} size="sm" /> : null} />
          <div className="space-y-4">
            <div className="flex items-center gap-2 flex-wrap">
              <SyncPill sync={sync} />
              <span className="vl-meta">{sync.lastPublishedAt ? `Published ${fmtDateTime(sync.lastPublishedAt)}` : "Never published"}</span>
            </div>
            <PublishBar compact api={api} tenantId={tenant.id} sync={sync} onPublished={markPublished} label="Publish runtime" />
            <QueryBoundary query={opQ} skeleton={<CardSkeleton lines={3} className="border-0 p-0" />} compact>
              {(op) => (
                <ul className="space-y-1.5 text-[13px]" data-testid="detail-onboarding">
                  {Object.entries(op.onboarding || {}).map(([k, v]) => (
                    <li key={k} className="flex items-center gap-2">
                      {v ? <CheckCircle2 className="h-4 w-4 text-vl-success" aria-hidden="true" /> : <AlertCircle className="h-4 w-4 text-vl-warning" aria-hidden="true" />}
                      <span className={v ? "" : "text-vl-secondary"}>{titleCase(k)}</span>
                    </li>
                  ))}
                  {!(op.testCall && op.testCall.completedAt) ? (
                    <li className="pt-1">
                      <Button size="sm" variant="outline" onClick={async () => { try { await api.post(`/api/admin/tenants/${tenant.id}/operator-test-call/complete`); toast.success("Test call marked complete"); opQ.refetch(); } catch (e) { toast.error(errorMessage(e)); } }} data-testid="detail-mark-test-call">
                        <PhoneCall className="h-4 w-4" /> Mark test call complete
                      </Button>
                    </li>
                  ) : null}
                </ul>
              )}
            </QueryBoundary>
          </div>
        </Card>
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-12">
        <Card className="xl:col-span-6" testId="detail-billing">
          <CardHeader title="Subscription" icon={CreditCard} action={<Button asChild variant="ghost" size="sm"><Link to="/admin/billing">Billing</Link></Button>} />
          <QueryBoundary query={subQ} skeleton={<CardSkeleton lines={3} className="border-0 p-0" />} compact>
            {(s) =>
              s.configured ? (
                <div className="grid grid-cols-2 gap-3">
                  <Stat label="Plan" value={s.planName} />
                  <Stat label="Billing" value={<BillingStatePill state={s.billingState} size="sm" />} />
                  <Stat label="Period ends" value={fmtDateTime(s.currentPeriodEnd)} />
                  <Stat label="Owner self-service" value={s.showBillingPortal ? "Enabled" : "Off"} />
                  {s.adminNotes ? <div className="col-span-2 vl-card-soft p-3 text-[13px]"><span className="vl-eyebrow-dark">Staff notes</span><p className="mt-1">{s.adminNotes}</p></div> : null}
                </div>
              ) : (
                <div className="space-y-3">
                  <div className="flex flex-wrap gap-2">
                    <BillingStatePill state="unbilled" size="sm" />
                  </div>
                  <InlineNote>Unbilled — no Stripe subscription. Owner self-service is {s.showBillingPortal ? "enabled" : "off"}.</InlineNote>
                </div>
              )
            }
          </QueryBoundary>
        </Card>
        <Card className="xl:col-span-6" testId="detail-owner-portal">
          <CardHeader title="Owner portal access" icon={KeyRound} />
          <QueryBoundary query={portalQ} skeleton={<CardSkeleton lines={2} className="border-0 p-0" />} compact>
            {(p) => (
              <div className="flex flex-wrap gap-2">
                <Pill tone={p.emailLoginSet ? "success" : "neutral"} icon={p.emailLoginSet ? CheckCircle2 : AlertCircle}>
                  Email login {p.emailLoginSet ? `set${p.email ? ` · ${p.email}` : ""}` : "not set"}
                </Pill>
                <Pill tone={p.passcodeSet ? "success" : "neutral"} icon={p.passcodeSet ? CheckCircle2 : AlertCircle}>
                  Passcode {p.passcodeSet ? "set" : "not set"}
                </Pill>
              </div>
            )}
          </QueryBoundary>
          <div className="mt-4 flex flex-wrap gap-2">
            <Button asChild variant="outline" size="sm">
              <Link to="/admin/receptionist">
                <Bot className="h-4 w-4" /> Manage receptionist
              </Link>
            </Button>
            <Button asChild variant="outline" size="sm">
              <Link to="/admin/calls">
                <Phone className="h-4 w-4" /> View calls
              </Link>
            </Button>
            <Button asChild variant="ghost" size="sm">
              <a href="/portal/login" target="_blank" rel="noreferrer">
                <ExternalLink className="h-4 w-4" /> Open customer portal
              </a>
            </Button>
          </div>
        </Card>
      </div>

      {editing ? <TenantSheet api={api} tenant={tenant} onClose={() => setEditing(false)} onSaved={() => tenantsQ.refetch()} /> : null}
      {creds ? <CredentialsSheet api={api} tenant={tenant} onClose={() => { setCreds(false); portalQ.refetch(); }} /> : null}
    </div>
  );
}
