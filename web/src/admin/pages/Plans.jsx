import React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Save, RotateCcw, Layers, Receipt, AlertTriangle, Lock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Card, CardHeader, Field, InlineNote, Stat } from "@/components/vl/Cards";
import { Pill, BillingPill } from "@/components/vl/Pills";
import { UsageList } from "@/components/vl/UsageBars";
import { QueryBoundary, CardSkeleton } from "@/components/vl/States";
import { ConfirmDialog } from "@/components/vl/ConfirmDialog";
import { useAdmin } from "../AdminApp";
import { TenantContextBar, NoTenant } from "../AdminShell";
import { errorMessage } from "@/lib/api";
import { loadUsageWithLimits, loadBillingSummary } from "@/lib/controlPlaneAdapters";
import { PLAN_TIERS, BILLING_STATUSES, OVERAGE_MODES, FEATURE_LABELS, LIMIT_LABELS, titleCase, billingLabel, fmtMoney, fmtNumber } from "@/lib/format";

const NUMERIC = Object.keys(LIMIT_LABELS);
const FLAGS = Object.keys(FEATURE_LABELS);

export default function Plans() {
  const { api, tenantId } = useAdmin();
  const qc = useQueryClient();
  const limitsQ = useQuery({ queryKey: ["admin", "limits", tenantId], queryFn: () => api.get(`/api/admin/tenants/${tenantId}/limits`), enabled: !!tenantId });
  const usageQ = useQuery({ queryKey: ["admin", "usage", tenantId], queryFn: () => loadUsageWithLimits(api, tenantId), enabled: !!tenantId });
  const [month, setMonth] = React.useState(new Date().toISOString().slice(0, 7));
  const summaryQ = useQuery({ queryKey: ["admin", "billing-summary", tenantId, month], queryFn: () => loadBillingSummary(api, tenantId, month), enabled: !!tenantId && /^\d{4}-\d{2}$/.test(month) });
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["admin", "limits", tenantId] });
    qc.invalidateQueries({ queryKey: ["admin", "usage", tenantId] });
    qc.invalidateQueries({ queryKey: ["admin", "billing-summary", tenantId] });
    qc.invalidateQueries({ queryKey: ["admin", "subscription", tenantId] });
  };
  if (!tenantId) return <NoTenant />;

  return (
    <div data-testid="admin-plans-page">
      <TenantContextBar title="Plans & limits" subtitle="Plan tier, entitlements, hard limits and billing status. Changes apply immediately." />
      <div className="grid gap-4 xl:grid-cols-12">
        <div className="xl:col-span-8">
          <QueryBoundary query={limitsQ} skeleton={<CardSkeleton lines={10} />}>
            {(d) => <LimitsForm key={JSON.stringify(d.limits)} api={api} tenantId={tenantId} limits={d.limits} onSaved={invalidate} />}
          </QueryBoundary>
        </div>
        <div className="xl:col-span-4 space-y-4">
          <Card testId="plans-usage-card">
            <CardHeader title="Usage this month" icon={Layers} />
            <QueryBoundary query={usageQ} skeleton={<CardSkeleton lines={4} className="border-0 p-0" />} compact>
              {(u) => (
                <>
                  <UsageList usage={u.usage} limits={u.limits} keys={[{ label: "Minutes", used: u.usage.minutesUsed, limit: u.limits.includedMonthlyMinutes }, { label: "Minutes vs hard cap", used: u.usage.minutesUsed, limit: u.limits.maxMonthlyMinutesHardCap }, { label: "Calls this month", used: u.usage.callsThisMonth, limit: u.limits.maxMonthlyCalls }, { label: "Calls today", used: u.usage.callsToday, limit: u.limits.maxDailyCalls }, { label: "Concurrent now", used: u.usage.concurrentCallsNow, limit: u.limits.maxConcurrentCalls }, { label: "Phone numbers", used: u.usage.phoneNumbers, limit: u.limits.maxPhoneNumbers }, { label: "Locations", used: u.usage.locations, limit: u.limits.maxLocations }, { label: "Integrations", used: u.usage.integrations, limit: u.limits.maxIntegrations }, { label: "Knowledge base (MB)", used: u.usage.knowledgeBaseSizeMb, limit: u.limits.maxKnowledgeBaseSizeMb }]} />
                  <div className="mt-4 grid grid-cols-2 gap-3">
                    <Stat label="Included left" value={`${u.includedMinutesRemaining} min`} />
                    <Stat label="Overage" value={`${u.overageMinutes} min`} />
                    <Stat label="Until hard cap" value={u.hardCapRemainingMinutes === null || u.hardCapRemainingMinutes === undefined ? "No cap" : `${u.hardCapRemainingMinutes} min`} />
                    <Stat label="Overage mode" value={titleCase(u.overageMode)} />
                  </div>
                </>
              )}
            </QueryBoundary>
          </Card>
          <Card testId="billing-summary-card">
            <CardHeader title="Billing summary" icon={Receipt} action={<Input type="month" value={month} onChange={(e) => setMonth(e.target.value)} className="h-8 w-[13.5rem] min-w-[13.5rem] px-2.5 text-[12px] [&::-webkit-calendar-picker-indicator]:ml-1 [&::-webkit-calendar-picker-indicator]:shrink-0" aria-label="Month" data-testid="billing-summary-month" />} />
            <QueryBoundary query={summaryQ} skeleton={<CardSkeleton lines={4} className="border-0 p-0" />} compact>
              {(s) => (
                <div className="space-y-3">
                  <div className="flex items-center gap-2">
                    <Pill tone="gold">{s.planName}</Pill>
                    <BillingPill status={s.billingStatus} size="sm" />
                  </div>
                  <ul className="divide-y divide-vl-border text-[13px]">
                    {(s.lineItems || []).map((li, i) => (
                      <li key={i} className="flex justify-between py-1.5">
                        <span className="text-vl-secondary">{li.label}</span>
                        <span className="font-medium">{fmtMoney(li.amountCents, s.currency)}</span>
                      </li>
                    ))}
                    <li className="flex justify-between py-2 font-semibold">
                      <span>Estimated total</span>
                      <span data-testid="billing-summary-total">{fmtMoney(s.estimatedTotalCents, s.currency)}</span>
                    </li>
                  </ul>
                  <div className="grid grid-cols-2 gap-3">
                    <Stat label="Minutes used" value={`${fmtNumber(s.minutesUsed)} / ${fmtNumber(s.includedMinutes)}`} />
                    <Stat label="Overage" value={s.overageRateCents == null ? `${fmtNumber(s.overageMinutes)} min` : `${fmtNumber(s.overageMinutes)} min @ ${s.overageRateCents}¢`} />
                  </div>
                  {!s.subscriptionConfigured ? <InlineNote>No subscription record. Estimated total is usage overage only, not a plan invoice.</InlineNote> : null}
                </div>
              )}
            </QueryBoundary>
          </Card>
        </div>
      </div>
    </div>
  );
}

const LimitsForm = ({ api, tenantId, limits, onSaved }) => {
  const [form, setForm] = React.useState(() => ({ ...limits }));
  const [busy, setBusy] = React.useState(false);
  const [resetTier, setResetTier] = React.useState(limits.planTier || "starter");
  const [confirmReset, setConfirmReset] = React.useState(false);
  const [billingStatus, setBillingStatus] = React.useState(limits.billingStatus || "trial");
  const changed = Object.keys(form).filter((k) => JSON.stringify(form[k]) !== JSON.stringify(limits[k]) && k !== "billingStatus");

  const save = async () => {
    if (!changed.length) return;
    const patch = {};
    changed.forEach((k) => (patch[k] = NUMERIC.includes(k) ? Number(form[k]) : form[k]));
    setBusy(true);
    try {
      const r = await api.patch(`/api/admin/tenants/${tenantId}/limits`, patch);
      toast.success("Limits saved", { description: r.runtimeSyncOk === false ? "Runtime is not synced yet - publish the receptionist." : `${changed.length} field${changed.length === 1 ? "" : "s"} updated.` });
      onSaved();
    } catch (e) {
      toast.error("Couldn't save limits", { description: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };
  const doReset = async () => {
    setBusy(true);
    try {
      await api.post(`/api/admin/tenants/${tenantId}/limits/reset-to-plan-defaults`, { planTier: resetTier });
      toast.success(`Reset to ${titleCase(resetTier)} defaults`);
      setConfirmReset(false);
      onSaved();
    } catch (e) {
      toast.error("Reset failed", { description: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };
  const saveBilling = async () => {
    setBusy(true);
    try {
      await api.post(`/api/admin/tenants/${tenantId}/billing-status`, { billingStatus });
      toast.success(`Billing status set to ${billingLabel(billingStatus)}`);
      onSaved();
    } catch (e) {
      toast.error("Couldn't update billing status", { description: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4" data-testid="limits-editor">
      <Card>
        <CardHeader title="Plan" action={<BillingPill status={limits.billingStatus} />} />
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Plan name" htmlFor="l-name">
            <Input id="l-name" value={form.planName || ""} onChange={(e) => setForm((f) => ({ ...f, planName: e.target.value }))} data-testid="limits-plan-name" />
          </Field>
          <Field label="Plan tier" htmlFor="l-tier">
            <Select value={form.planTier} onValueChange={(v) => setForm((f) => ({ ...f, planTier: v }))}>
              <SelectTrigger id="l-tier" data-testid="limits-plan-tier">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PLAN_TIERS.map((t) => (
                  <SelectItem key={t} value={t}>
                    {titleCase(t)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label="Overage mode" htmlFor="l-over">
            <Select value={form.overageMode} onValueChange={(v) => setForm((f) => ({ ...f, overageMode: v }))}>
              <SelectTrigger id="l-over" data-testid="limits-overage-mode">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {OVERAGE_MODES.map((m) => (
                  <SelectItem key={m} value={m}>
                    {titleCase(m)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        </div>
        <div className="mt-4 flex flex-wrap items-end gap-3 rounded-[4px] border border-vl-border bg-vl-soft p-3">
          <Field label="Reset all limits to tier defaults" htmlFor="l-reset" className="flex-1 min-w-[200px]">
            <Select value={resetTier} onValueChange={setResetTier}>
              <SelectTrigger id="l-reset" className="bg-white" data-testid="limits-reset-tier">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PLAN_TIERS.map((t) => (
                  <SelectItem key={t} value={t}>
                    {titleCase(t)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Button variant="outline" onClick={() => setConfirmReset(true)} disabled={busy} data-testid="limits-reset-button">
            <RotateCcw className="h-4 w-4" /> Reset to defaults
          </Button>
        </div>
      </Card>

      <Card>
        <CardHeader title="Limits" subtitle="Hard numbers enforced by the platform" />
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {NUMERIC.map((k) => (
            <Field key={k} label={LIMIT_LABELS[k]} htmlFor={`l-${k}`} hint={<code className="text-[11px]">{k}</code>}>
              <Input id={`l-${k}`} type="number" min="0" value={form[k] ?? ""} onChange={(e) => setForm((f) => ({ ...f, [k]: e.target.value }))} data-testid={`limit-${k}`} />
            </Field>
          ))}
        </div>
      </Card>

      <Card>
        <CardHeader title="Features" subtitle="Entitlements that gate portal screens and receptionist behaviour" />
        <div className="grid gap-2 sm:grid-cols-2">
          {FLAGS.map((k) => {
            const locked = k === "transcriptRetention";
            return (
              <label key={k} className="flex items-center gap-3 rounded-[4px] border border-vl-border bg-vl-soft px-3.5 py-2.5" data-testid={`flag-${k}`}>
                <Switch checked={!!form[k]} disabled={locked} onCheckedChange={(v) => setForm((f) => ({ ...f, [k]: v }))} aria-label={FEATURE_LABELS[k]} />
                <span className="min-w-0 flex-1">
                  <span className="block text-[13px] font-medium">{FEATURE_LABELS[k]}</span>
                  <span className="block vl-meta">{k}</span>
                </span>
                {locked ? <Pill size="sm" icon={Lock}>Always on</Pill> : null}
              </label>
            );
          })}
        </div>
        <div className="mt-4 flex items-center justify-end gap-3">
          {changed.length ? <span className="vl-meta">{changed.length} unsaved change{changed.length === 1 ? "" : "s"}</span> : null}
          <Button onClick={save} disabled={busy || !changed.length} data-testid="limits-save-button">
            <Save className="h-4 w-4" /> Save limits
          </Button>
        </div>
      </Card>

      <Card testId="billing-status-card">
        <CardHeader title="Billing status" subtitle="Controls whether the receptionist keeps answering" />
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Status" htmlFor="l-bs" className="min-w-[220px]">
            <Select value={billingStatus} onValueChange={setBillingStatus}>
              <SelectTrigger id="l-bs" data-testid="billing-status-select">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {BILLING_STATUSES.map((s) => (
                  <SelectItem key={s} value={s}>
                    {billingLabel(s)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Button variant="outline" onClick={saveBilling} disabled={busy || billingStatus === limits.billingStatus} data-testid="billing-status-save">
            Update status
          </Button>
          {["suspended", "canceled"].includes(billingStatus) && billingStatus !== limits.billingStatus ? (
            <InlineNote tone="warning" icon={AlertTriangle} className="basis-full">
              Setting {billingLabel(billingStatus).toLowerCase()} may stop the receptionist from answering calls.
            </InlineNote>
          ) : null}
        </div>
      </Card>

      <ConfirmDialog open={confirmReset} onOpenChange={setConfirmReset} title={`Reset to ${titleCase(resetTier)} defaults?`} description="Every limit and feature flag will be replaced with the tier defaults. Billing status is kept." confirmLabel="Reset limits" onConfirm={doReset} loading={busy} />
    </div>
  );
};
