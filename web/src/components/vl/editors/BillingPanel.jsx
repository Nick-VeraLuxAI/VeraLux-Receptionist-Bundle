import React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { CreditCard, ExternalLink, RefreshCw, Save, Trash2, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Card, CardHeader, Field, InlineNote, Stat } from "@/components/vl/Cards";
import { BillingPill, BillingStatePill, Pill, ServicePill } from "@/components/vl/Pills";
import { UsageList } from "@/components/vl/UsageBars";
import { QueryBoundary, CardSkeleton } from "@/components/vl/States";
import { ConfirmDialog } from "@/components/vl/ConfirmDialog";
import { errorMessage } from "@/lib/api";
import { fromSubscription, loadUsageWithLimits } from "@/lib/controlPlaneAdapters";
import { fmtMoney, fmtDate, fmtNumber, titleCase, BILLING_STATUSES, PLAN_TIERS, FEATURE_LABELS, billingLabel, centsToDollarInput, dollarInputToCents } from "@/lib/format";

export const BillingPanel = ({ api, mode, tenantId, returnUrl }) => {
  const qc = useQueryClient();
  const isAdmin = mode === "admin";
  const subQ = useQuery({
    queryKey: [mode, "subscription", tenantId],
    queryFn: async () => fromSubscription(await api.get("/api/admin/subscription")),
    enabled: !!tenantId,
  });
  const stripeQ = useQuery({ queryKey: [mode, "stripe-status"], queryFn: () => api.get("/api/admin/stripe/status") });
  const plansQ = useQuery({
    queryKey: [mode, "stripe-plans"],
    queryFn: () => api.get("/api/admin/stripe/plans"),
    enabled: isAdmin,
  });
  const usageQ = useQuery({ queryKey: [mode, "usage", tenantId], queryFn: () => loadUsageWithLimits(api, tenantId), enabled: !!tenantId });
  const [redirecting, setRedirecting] = React.useState(false);
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: [mode, "subscription", tenantId] });
    qc.invalidateQueries({ queryKey: [mode, "usage", tenantId] });
    qc.invalidateQueries({ queryKey: [mode, "stripe-plans"] });
    qc.invalidateQueries({ queryKey: ["admin", "limits", tenantId] });
  };

  React.useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("checkout") === "success") {
      toast.success("Payment received", { description: isAdmin ? "Run Sync from Stripe to apply the new plan." : "Your plan will update as soon as payment is confirmed." });
      window.history.replaceState({}, "", window.location.pathname);
    } else if (params.get("portal") === "returned") {
      toast.success("Welcome back", { description: "Billing changes appear once Stripe confirms them." });
      window.history.replaceState({}, "", window.location.pathname);
    }
  }, [isAdmin]);

  const openPortal = async () => {
    setRedirecting(true);
    try {
      const r = await api.post("/api/admin/stripe/portal", { returnUrl });
      window.location.assign(r.url);
    } catch (e) {
      toast.error("Couldn't open billing portal", { description: errorMessage(e) });
      setRedirecting(false);
    }
  };

  return (
    <div className="space-y-5" data-testid="billing-panel">
      <QueryBoundary query={subQ} skeleton={<CardSkeleton lines={5} />}>
        {(sub) => {
          const configured = sub.billingState !== "unbilled";
          const stripeOk = stripeQ.data ? stripeQ.data.configured : false;
          const liveMode = !!(stripeQ.data && stripeQ.data.liveMode) || !!sub.liveMode;
          const selfService = !!sub.showBillingPortal && stripeOk;
          const serviceStatus = sub.serviceStatus || (sub.entitlements && sub.entitlements.billingStatus);
          const catalog = (plansQ.data && plansQ.data.plans) || [];
          const tierDefaults = (plansQ.data && plansQ.data.defaults) || {};
          return (
            <>
              {sub.billingState === "past_due" ? (
                <InlineNote tone="warning" icon={AlertTriangle} testId="billing-needs-attention-banner">
                  <span className="font-medium">Payment needs attention.</span> The last invoice didn't go through. {selfService ? "Update your payment method to keep billing current." : "Contact VeraLux to update the payment method."} The receptionist stays on until staff changes Service status.
                </InlineNote>
              ) : null}
              {serviceStatus === "suspended" || serviceStatus === "canceled" ? (
                <InlineNote tone="danger" icon={AlertTriangle} testId="billing-suspended-banner">
                  <span className="font-medium">This account is {billingLabel(serviceStatus).toLowerCase()}.</span> Your receptionist may not answer calls until service is restored.
                </InlineNote>
              ) : null}

              <div className="grid gap-4 lg:grid-cols-2">
                <Card testId="subscription-card">
                  <CardHeader
                    title={isAdmin ? "Subscription" : "Your plan"}
                    icon={CreditCard}
                    action={
                      <div className="flex flex-wrap items-center justify-end gap-1.5">
                        <Pill tone="gold" size="sm">{sub.planName || "—"}</Pill>
                        <ServicePill status={serviceStatus || "trial"} size="sm" />
                        <BillingStatePill state={sub.billingState || "unbilled"} size="sm" />
                      </div>
                    }
                  />
                  {configured ? (
                    <div className="space-y-4">
                      <div>
                        <div className="vl-serif text-[28px] leading-none">{sub.planName}</div>
                        <div className="mt-1 text-[14px] text-vl-secondary">
                          {fmtMoney(sub.priceCents, sub.currency)} / {sub.billingInterval || "month"}
                        </div>
                      </div>
                      <div className="grid grid-cols-2 gap-3">
                        <Stat label="Current period" value={`${fmtDate(sub.currentPeriodStart)} – ${fmtDate(sub.currentPeriodEnd)}`} />
                        <Stat label="Renews" value={sub.cancelAtPeriodEnd ? "Cancels at period end" : fmtDate(sub.currentPeriodEnd)} />
                        {isAdmin ? <Stat label="Stripe customer" value={sub.stripeCustomerId || "—"} /> : null}
                        {isAdmin ? <Stat label="Stripe subscription" value={sub.stripeSubscriptionId || "—"} /> : null}
                      </div>
                    </div>
                  ) : (
                    <InlineNote testId="subscription-not-configured">
                      {isAdmin
                        ? "Unbilled — no Stripe subscription is on file. Select a catalog price and Create subscription, or save a local record for invoiced accounts."
                        : "NOT CONFIGURED. VeraLux will set this up with you."}
                    </InlineNote>
                  )}
                  <div className="mt-5 flex flex-wrap gap-2">
                    {selfService && (configured || isAdmin) ? (
                      <Button onClick={openPortal} disabled={redirecting || (!configured && !isAdmin)} data-testid="billing-portal-button">
                        <ExternalLink className="h-4 w-4" /> Manage billing
                      </Button>
                    ) : null}
                    {isAdmin ? (
                      <Button
                        variant="outline"
                        onClick={async () => {
                          try {
                            const r = await api.post("/api/admin/stripe/sync");
                            toast.success("Synced from Stripe", { description: r.changes && r.changes.length ? r.changes.join("; ") : "No changes" });
                            invalidate();
                          } catch (e) {
                            toast.error("Sync failed", { description: errorMessage(e) });
                          }
                        }}
                        data-testid="billing-sync-button"
                      >
                        <RefreshCw className="h-4 w-4" /> Sync from Stripe
                      </Button>
                    ) : null}
                  </div>
                  {!isAdmin && !selfService ? <p className="mt-4 vl-meta">Plan changes are handled by your VeraLux contact.</p> : null}
                </Card>

                <Card testId="usage-card">
                  <CardHeader title="Usage this month" subtitle="Against what's included in the plan" />
                  <QueryBoundary query={usageQ} skeleton={<CardSkeleton lines={4} />} compact>
                    {(u) => (
                      <>
                        <UsageList usage={u.usage} limits={u.limits} />
                        <div className="mt-4 grid grid-cols-2 gap-3">
                          <Stat label="Included minutes left" value={u.includedMinutesRemaining ?? "—"} />
                          <Stat label="Overage minutes" value={u.overageMinutes ?? 0} />
                          {u.hardCapRemainingMinutes !== null && u.hardCapRemainingMinutes !== undefined ? <Stat label="Until hard cap" value={`${u.hardCapRemainingMinutes} min`} /> : null}
                          <Stat label="Overage handling" value={titleCase(u.overageMode || "—")} />
                        </div>
                      </>
                    )}
                  </QueryBoundary>
                </Card>
              </div>

              {isAdmin ? (
                <AdminSubscriptionTools
                  api={api}
                  sub={sub}
                  catalog={catalog}
                  tierDefaults={tierDefaults}
                  stripeOk={stripeOk}
                  liveMode={liveMode}
                  onDone={invalidate}
                />
              ) : null}
            </>
          );
        }}
      </QueryBoundary>
    </div>
  );
};

const dash = (v) => (v === null || v === undefined || v === "" ? "—" : v);

const TierIncludesPanel = ({ defaults }) => {
  const d = defaults || {};
  const overageCents = d.monthlyMinuteOverageRateCents;
  const limits = [
    ["Concurrent calls", dash(d.maxConcurrentCalls)],
    ["Included minutes / month", dash(d.includedMonthlyMinutes)],
    ["Hard cap minutes", dash(d.maxMonthlyMinutesHardCap)],
    ["Calls / day", dash(d.maxDailyCalls)],
    ["Calls / month", dash(d.maxMonthlyCalls)],
    ["Phone numbers", dash(d.maxPhoneNumbers)],
    ["Admin users", dash(d.maxAdminUsers)],
    ["Integrations", dash(d.maxIntegrations)],
    ["Locations", dash(d.maxLocations)],
    ["Overage rate", overageCents === null || overageCents === undefined ? "—" : `${fmtMoney(overageCents)}/min`],
  ];
  return (
    <div className="mt-4 vl-card-soft p-4 space-y-3" data-testid="tier-includes-panel">
      <div>
        <div className="text-[15px] font-semibold">What this tier includes</div>
        <p className="vl-meta mt-0.5">Same defaults as Plans & limits → Reset to defaults.</p>
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        {limits.map(([label, value]) => (
          <div key={label} className="flex justify-between gap-3 text-[13px]">
            <span className="text-vl-secondary">{label}</span>
            <span className="font-medium">{typeof value === "number" ? fmtNumber(value) : value}</span>
          </div>
        ))}
      </div>
      <div>
        <div className="vl-label mb-2">Feature gates</div>
        <div className="flex flex-wrap gap-1.5">
          {Object.entries(FEATURE_LABELS).map(([key, label]) => {
            const on = d[key];
            const known = typeof on === "boolean";
            return (
              <Pill key={key} size="sm" tone={!known ? "neutral" : on ? "success" : "neutral"}>
                {label} · {known ? (on ? "On" : "Off") : "—"}
              </Pill>
            );
          })}
        </div>
      </div>
    </div>
  );
};

const AdminSubscriptionTools = ({ api, sub, catalog, tierDefaults = {}, stripeOk, liveMode, onDone }) => {
  const monthly = catalog.filter((p) => p.kind === "recurring");
  const [form, setForm] = React.useState({
    planName: sub.planName || "",
    planTier: sub.planTier || (sub.entitlements && sub.entitlements.planTier) || "professional",
    priceCents: sub.priceCents ?? "",
    currency: sub.currency || "usd",
    billingInterval: sub.billingInterval || "monthly",
    status: sub.status || "active",
    stripeCustomerId: sub.stripeCustomerId || "",
    stripeSubscriptionId: sub.stripeSubscriptionId || "",
    stripePriceId: sub.stripePriceId || "",
    cancelAtPeriodEnd: !!sub.cancelAtPeriodEnd,
  });
  const [dollarDraft, setDollarDraft] = React.useState(centsToDollarInput(sub.priceCents));
  const [settings, setSettings] = React.useState({ showBillingPortal: !!sub.showBillingPortal, adminNotes: sub.adminNotes || "" });
  const [includeSetup, setIncludeSetup] = React.useState(false);
  const [applyTierDefaults, setApplyTierDefaults] = React.useState(true);
  const [busy, setBusy] = React.useState(false);
  const [confirmCreate, setConfirmCreate] = React.useState(false);
  const [confirmDelete, setConfirmDelete] = React.useState(false);
  const set = (k) => (v) => setForm((f) => ({ ...f, [k]: v }));

  const selected = monthly.find((p) => p.id === form.stripePriceId);
  const setup = selected
    ? catalog.find((p) => p.kind === "setup" && (p.id === selected.setupPriceId || p.lookupKey === (selected.lookupKey || "").replace("_monthly", "_setup")))
    : null;
  const setupCents = selected
    ? selected.setupPriceCents || setup?.priceCents || (selected.lookupKey === "receptionist_pilot_monthly" ? 350000 : selected.lookupKey === "receptionist_list_monthly" ? 500000 : null)
    : null;

  const applyCatalogPrice = (priceId) => {
    const p = monthly.find((x) => x.id === priceId);
    const cents = p?.priceCents ?? "";
    setDollarDraft(centsToDollarInput(cents));
    setForm((f) => ({
      ...f,
      stripePriceId: priceId,
      planName: p?.name || f.planName,
      priceCents: cents,
      currency: p?.currency || f.currency,
      billingInterval: p?.billingInterval || f.billingInterval,
      planTier: p?.planTier || (p?.lookupKey === "receptionist_pilot_monthly" ? "pilot" : p ? "professional" : f.planTier),
    }));
  };

  const createConfirmDescription = (() => {
    if (!selected) return "Select a catalog price first.";
    const parts = [
      `${selected.name} at ${fmtMoney(selected.priceCents, selected.currency)}/${selected.billingInterval}`,
    ];
    if (includeSetup && setupCents) parts[0] += ` plus setup ${fmtMoney(setupCents, selected.currency)}`;
    parts[0] += ".";
    if (applyTierDefaults) parts.push(`${titleCase(form.planTier)} entitlement defaults will be applied to Plans & limits.`);
    parts.push(
      liveMode
        ? "Live keys — this creates a real customer invoice. It does not charge a card automatically unless one is already on file and collection is automatic."
        : "This uses the configured Stripe account.",
    );
    return parts.join(" ");
  })();

  const createOnStripe = async () => {
    if (!form.stripePriceId) {
      toast.error("Select a Stripe price");
      return;
    }
    setBusy(true);
    try {
      const r = await api.post("/api/admin/stripe/subscribe", {
        priceId: form.stripePriceId,
        includeSetup,
        confirm: true,
        planTier: form.planTier,
        applyTierDefaults,
      });
      toast.success(r.created === false ? "Existing Stripe subscription reused" : "Stripe subscription created", {
        description: liveMode ? "Live mode — invoice/subscription is on the live Stripe account." : "Test/sandbox Stripe.",
      });
      setConfirmCreate(false);
      onDone();
    } catch (e) {
      toast.error("Couldn't create subscription", { description: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card testId="subscription-editor">
        <CardHeader
          title={sub.configured ? "Edit subscription" : "Create subscription"}
          subtitle="Uses the live Stripe catalog. Does not create new Products or Prices."
        />
        {!stripeOk ? <InlineNote tone="warning">STRIPE_SECRET_KEY is not configured on this control plane.</InlineNote> : null}
        {liveMode ? <InlineNote tone="warning" testId="live-stripe-banner">Live Stripe keys. Creating a subscription invoices the customer. Confirm before continuing.</InlineNote> : null}
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Stripe price" htmlFor="s-priceid" hint="Active catalog prices (lookup_key / sku)">
            <Select value={form.stripePriceId || "__none"} onValueChange={(v) => applyCatalogPrice(v === "__none" ? "" : v)}>
              <SelectTrigger id="s-priceid" data-testid="stripe-price-select">
                <SelectValue placeholder="Select a catalog price" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__none">None</SelectItem>
                {monthly.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name} · {fmtMoney(p.priceCents, p.currency)} / {p.billingInterval}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label="Plan name" htmlFor="s-plan">
            <Input id="s-plan" value={form.planName} onChange={(e) => set("planName")(e.target.value)} data-testid="sub-plan-name" />
          </Field>
          <Field label="Plan tier" htmlFor="s-tier" hint="Controls limits & features — not the Stripe charge.">
            <Select value={form.planTier} onValueChange={set("planTier")}>
              <SelectTrigger id="s-tier" data-testid="sub-plan-tier">
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
          <Field label="Price" htmlFor="s-price" hint="Stored as cents. Catalog list is $2,000/mo; pilot is $1,500/mo.">
            <div className="relative">
              <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[13px] text-vl-secondary">$</span>
              <Input
                id="s-price"
                type="text"
                inputMode="decimal"
                className="pl-7"
                value={dollarDraft}
                onChange={(e) => {
                  setDollarDraft(e.target.value);
                  const cents = dollarInputToCents(e.target.value);
                  set("priceCents")(cents);
                }}
                onBlur={() => setDollarDraft(centsToDollarInput(form.priceCents))}
                placeholder="1,500.00"
                data-testid="sub-price"
              />
            </div>
            <p className="mt-1 text-[13px] font-medium">{form.priceCents === "" ? "—" : fmtMoney(form.priceCents, form.currency)}</p>
          </Field>
          <Field label="Status" htmlFor="s-status">
            <Select value={form.status} onValueChange={set("status")}>
              <SelectTrigger id="s-status" data-testid="sub-status">
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
          <Field label="Interval" htmlFor="s-int">
            <Select value={form.billingInterval} onValueChange={set("billingInterval")}>
              <SelectTrigger id="s-int">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="monthly">Monthly</SelectItem>
                <SelectItem value="yearly">Yearly</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <Field label="Stripe customer id" htmlFor="s-cus">
            <Input id="s-cus" value={form.stripeCustomerId} onChange={(e) => set("stripeCustomerId")(e.target.value)} placeholder="cus_…" />
          </Field>
          <Field label="Stripe subscription id" htmlFor="s-sub">
            <Input id="s-sub" value={form.stripeSubscriptionId} onChange={(e) => set("stripeSubscriptionId")(e.target.value)} placeholder="sub_…" />
          </Field>
        </div>
        <TierIncludesPanel defaults={tierDefaults[form.planTier]} />
        <label className="mt-3 flex items-start gap-3 rounded-[4px] border border-vl-border bg-vl-soft p-3.5">
          <Switch checked={applyTierDefaults} onCheckedChange={setApplyTierDefaults} data-testid="apply-tier-defaults-switch" />
          <span>
            <span className="block text-[13px] font-medium">Apply tier entitlement defaults to Plans & limits</span>
            <span className="block vl-meta">
              {applyTierDefaults
                ? `Create subscription / Save will reset this tenant’s limits and feature gates to ${titleCase(form.planTier)} defaults (Service status is kept).`
                : "Only the subscription record / Stripe charge will change. Plans & limits stay as they are."}
            </span>
          </span>
        </label>
        <label className="mt-3 flex items-start gap-3 rounded-[4px] border border-vl-border bg-vl-soft p-3.5">
          <Switch checked={includeSetup} onCheckedChange={setIncludeSetup} disabled={!setupCents} data-testid="include-setup-switch" />
          <span>
            <span className="block text-[13px] font-medium">Include setup</span>
            <span className="block vl-meta">
              {setupCents
                ? `Adds the matching one-time setup of ${fmtMoney(setupCents, form.currency)} to the first Stripe invoice${includeSetup ? "." : " when enabled."}`
                : "No matching setup price for this catalog item."}
            </span>
          </span>
        </label>
        <label className="mt-3 inline-flex items-center gap-2 text-[13px]">
          <Switch checked={form.cancelAtPeriodEnd} onCheckedChange={set("cancelAtPeriodEnd")} /> Cancel at period end
        </label>
        <div className="mt-4 flex flex-wrap gap-2">
          <Button disabled={busy || !form.stripePriceId || !stripeOk} onClick={() => setConfirmCreate(true)} data-testid="sub-save-button">
            <Save className="h-4 w-4" /> Create subscription
          </Button>
          <Button
            variant="outline"
            disabled={busy || !form.planName || form.priceCents === ""}
            onClick={async () => {
              setBusy(true);
              try {
                await api.post("/api/admin/subscription", {
                  ...form,
                  priceCents: Number(form.priceCents),
                  applyTierDefaults,
                });
                toast.success(applyTierDefaults ? "Local record saved and tier defaults applied" : "Local subscription record saved");
                onDone();
              } catch (e) {
                toast.error("Couldn't save subscription", { description: errorMessage(e) });
              } finally {
                setBusy(false);
              }
            }}
            data-testid="sub-local-save-button"
          >
            Save local record
          </Button>
          {sub.configured ? (
            <Button variant="ghost" className="text-vl-danger hover:text-vl-danger" onClick={() => setConfirmDelete(true)} data-testid="sub-delete-button">
              <Trash2 className="h-4 w-4" /> Delete local record
            </Button>
          ) : null}
        </div>
        <ConfirmDialog
          open={confirmCreate}
          onOpenChange={setConfirmCreate}
          title={liveMode ? "Create a live Stripe subscription?" : "Create this Stripe subscription?"}
          description={createConfirmDescription}
          confirmLabel={liveMode ? "Confirm live subscription" : "Create subscription"}
          destructive={liveMode}
          loading={busy}
          testId="confirm-create-subscription"
          onConfirm={createOnStripe}
        />
        <ConfirmDialog
          open={confirmDelete}
          onOpenChange={setConfirmDelete}
          title="Delete this subscription record?"
          description="This removes the subscription from VeraLux. It does not cancel anything in Stripe."
          confirmLabel="Delete"
          destructive
          loading={busy}
          onConfirm={async () => {
            setBusy(true);
            try {
              await api.del("/api/admin/subscription");
              toast.success("Subscription deleted");
              setConfirmDelete(false);
              onDone();
            } catch (e) {
              toast.error("Couldn't delete", { description: errorMessage(e) });
            } finally {
              setBusy(false);
            }
          }}
        />
      </Card>

      <Card testId="billing-settings">
        <CardHeader title="Owner billing access" subtitle="Controls what the owner sees in their portal" />
        <label className="flex items-start gap-3 rounded-[4px] border border-vl-border bg-vl-soft p-3.5">
          <Switch checked={settings.showBillingPortal} onCheckedChange={(v) => setSettings((s) => ({ ...s, showBillingPortal: v }))} data-testid="show-billing-portal-switch" />
          <span>
            <span className="block text-[13px] font-medium">Allow self-service billing</span>
            <span className="block vl-meta">When on, the owner can open the Stripe Customer Portal from /portal/billing. They cannot pick arbitrary prices.</span>
          </span>
        </label>
        <Field label="Internal notes" htmlFor="s-notes" hint="Staff-only. Never shown to the owner." className="mt-4">
          <Textarea id="s-notes" rows={4} value={settings.adminNotes} onChange={(e) => setSettings((s) => ({ ...s, adminNotes: e.target.value }))} data-testid="admin-notes" />
        </Field>
        <div className="mt-4 flex justify-end">
          <Button
            variant="outline"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await api.patch("/api/admin/subscription", settings);
                toast.success("Billing access saved");
                onDone();
              } catch (e) {
                toast.error("Couldn't save", { description: errorMessage(e) });
              } finally {
                setBusy(false);
              }
            }}
            data-testid="billing-settings-save"
          >
            <Save className="h-4 w-4" /> Save access settings
          </Button>
        </div>
      </Card>
    </div>
  );
};
