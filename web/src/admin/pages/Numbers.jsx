import React from "react";
import { Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Search, ShoppingCart, Building2, Link2, CheckCircle2, AlertCircle, RefreshCw, Hash, Unlink, Radio, ArrowRight, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { PageHeader, Card, CardHeader, Field, InlineNote, Stat } from "@/components/vl/Cards";
import { Pill } from "@/components/vl/Pills";
import { QueryBoundary, RowsSkeleton, StaffOnlyState, CardSkeleton, EmptyState } from "@/components/vl/States";
import { ConfirmDialog } from "@/components/vl/ConfirmDialog";
import { useAdmin } from "../AdminApp";
import { ApiError, errorMessage } from "@/lib/api";
import { fmtRelative, fmtMoney } from "@/lib/format";
import { cn } from "@/lib/utils";

const STATES = ["TX", "IL", "WA", "CA", "NY", "FL", "GA", "CO", "MA", "AZ"];
const STEPS = [
  { id: 1, label: "Find a number", icon: Search },
  { id: 2, label: "Purchase", icon: ShoppingCart },
  { id: 3, label: "Add to tenant", icon: Building2 },
  { id: 4, label: "Map to runtime", icon: Link2 },
];

export default function Numbers() {
  const { api, caps, capsLoading, tenants, tenantId, tenantsQ } = useAdmin();
  const qc = useQueryClient();
  const statusQ = useQuery({ queryKey: ["admin", "telnyx-status"], queryFn: () => api.get("/api/admin/telnyx/status"), enabled: caps.carrier !== false });
  const numbersQ = useQuery({ queryKey: ["admin", "telnyx-numbers"], queryFn: () => api.get("/api/admin/telnyx/numbers"), enabled: caps.carrier !== false });
  const connQ = useQuery({ queryKey: ["admin", "telnyx-connections"], queryFn: () => api.get("/api/admin/telnyx/connections"), enabled: caps.carrier !== false });

  // Workflow state
  const [step, setStep] = React.useState(1);
  const [query, setQuery] = React.useState({ country: "US", state: "TX", city: "", contains: "", limit: "8" });
  const [results, setResults] = React.useState(null);
  const [searching, setSearching] = React.useState(false);
  const [searchErr, setSearchErr] = React.useState(null);
  const [selected, setSelected] = React.useState(null); // phone number string
  const [targetTenant, setTargetTenant] = React.useState(tenantId || "");
  const [stepState, setStepState] = React.useState({ 2: { status: "idle" }, 3: { status: "idle" }, 4: { status: "idle" } });
  const setS = (n, patch) => setStepState((s) => ({ ...s, [n]: { ...s[n], ...patch } }));
  const [unmapping, setUnmapping] = React.useState(null);
  React.useEffect(() => {
    if (!targetTenant && tenantId) setTargetTenant(tenantId);
  }, [tenantId, targetTenant]);

  const refreshInventory = () => {
    qc.invalidateQueries({ queryKey: ["admin", "telnyx-numbers"] });
    qc.invalidateQueries({ queryKey: ["admin", "telnyx-status"] });
    qc.invalidateQueries({ queryKey: ["admin", "tenants"] });
    qc.invalidateQueries({ queryKey: ["admin", "dids"] });
  };

  if (capsLoading) return <CardSkeleton lines={6} />;
  if (caps.carrier === false) {
    return (
      <div data-testid="admin-numbers-page">
        <PageHeader serif={false} eyebrow="Platform" title="Numbers" />
        <Card>
          <StaffOnlyState description="Carrier administration (searching, purchasing and mapping phone numbers) is restricted to VeraLux superadmins. Tenant numbers can still be edited from the tenant record." />
        </Card>
      </div>
    );
  }

  const search = async () => {
    setSearching(true);
    setSearchErr(null);
    setResults(null);
    try {
      const p = new URLSearchParams();
      Object.entries(query).forEach(([k, v]) => v && p.set(k, v));
      const r = await api.get(`/api/admin/telnyx/available?${p.toString()}`);
      const rows = r.available || r.numbers || [];
      setResults(rows.map((row) => ({
        ...row,
        phone_number: row.phone_number,
        monthly_cost: row.monthly_cost ?? row.cost_information?.monthly_cost ?? null,
        features: (row.features || []).map((feature) => (typeof feature === "string" ? feature : feature?.name)).filter(Boolean),
        region: row.region || {
          city: row.region_information?.find((region) => ["rate_center", "location", "locality"].includes(region.region_type))?.region_name || null,
          state: row.region_information?.find((region) => ["state", "administrative_area"].includes(region.region_type))?.region_name || null,
          country: row.region_information?.find((region) => ["country_code", "country"].includes(region.region_type))?.region_name || null,
        },
      })));
    } catch (e) {
      setSearchErr(e);
    } finally {
      setSearching(false);
    }
  };

  const purchase = async (mode = "purchase") => {
    setS(2, { status: "running", error: null });
    try {
      const r = await api.post(`/api/admin/telnyx/${mode}`, { phone_number: selected });
      setS(2, { status: "done", result: r });
      refreshInventory();
      setStep(3);
    } catch (e) {
      if (e instanceof ApiError && e.code === "number_already_owned") {
        setS(2, { status: "done", result: { alreadyOwned: true } });
        setStep(3);
        return;
      }
      setS(2, { status: "error", error: e });
    }
  };

  const addToTenant = async () => {
    const t = tenants.find((x) => x.id === targetTenant);
    if (!t) return;
    setS(3, { status: "running", error: null });
    try {
      const numbers = Array.from(new Set([...(t.numbers || []), selected]));
      const r = await api.post("/api/admin/tenants", { id: t.id, numbers });
      setS(3, { status: "done", result: r });
      refreshInventory();
      setStep(4);
    } catch (e) {
      setS(3, { status: "error", error: e });
    }
  };

  const mapDid = async () => {
    setS(4, { status: "running", error: null });
    try {
      await api.post("/api/admin/runtime/dids/map", { didE164: selected, tenantId: targetTenant });
      const check = await api.get(`/api/admin/runtime/dids/${encodeURIComponent(selected)}`);
      if (!check.mapped || check.tenantId !== targetTenant) throw new Error("Mapping did not verify. Try again.");
      setS(4, { status: "done", result: check });
      refreshInventory();
      toast.success("Number is live", { description: `${selected} now routes to ${targetTenant}.` });
    } catch (e) {
      setS(4, { status: "error", error: e });
    }
  };

  const startFromOwned = (num) => {
    setSelected(num);
    setStepState({ 2: { status: "done", result: { alreadyOwned: true } }, 3: { status: "idle" }, 4: { status: "idle" } });
    setStep(3);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };
  const reset = () => {
    setSelected(null);
    setResults(null);
    setStepState({ 2: { status: "idle" }, 3: { status: "idle" }, 4: { status: "idle" } });
    setStep(1);
  };

  const stepDone = (n) => (n === 1 ? !!selected : stepState[n] && stepState[n].status === "done");

  return (
    <div data-testid="admin-numbers-page">
      <PageHeader serif={false} eyebrow="Platform · Carrier" title="Numbers" subtitle="Provision a phone number and connect it to a tenant's receptionist in four guided steps." actions={statusQ.data ? <Pill tone={statusQ.data.configured ? "success" : "danger"} icon={Radio} testId="carrier-status-pill">{statusQ.data.configured ? `Carrier connected${statusQ.data.stub ? " (simulated)" : ""}` : "Carrier not configured"}</Pill> : null} />

      <Card className="mb-4" testId="numbers-workflow">
        <ol className="grid grid-cols-2 md:grid-cols-4 gap-2 mb-5" aria-label="Provisioning steps">
          {STEPS.map((s) => {
            const done = stepDone(s.id);
            const active = step === s.id;
            const errored = stepState[s.id] && stepState[s.id].status === "error";
            return (
              <li key={s.id}>
                <button onClick={() => (s.id === 1 || selected) && setStep(s.id)} className={cn("w-full rounded-[4px] border px-3 py-2.5 text-left transition-colors", active ? "border-vl-gold bg-white" : "border-vl-border bg-vl-soft hover:bg-white", errored && "border-vl-danger")} data-testid={`numbers-step-${s.id}`} aria-current={active ? "step" : undefined}>
                  <div className="flex items-center gap-2">
                    <span className={cn("inline-flex h-6 w-6 items-center justify-center rounded-full text-[11px] font-semibold", done ? "bg-vl-success text-white" : errored ? "bg-vl-danger text-white" : active ? "bg-vl-gold text-white" : "bg-vl-warm text-vl-secondary")}>{done ? <CheckCircle2 className="h-3.5 w-3.5" /> : errored ? "!" : s.id}</span>
                    <span className="text-[13px] font-medium">{s.label}</span>
                  </div>
                </button>
              </li>
            );
          })}
        </ol>

        {selected ? (
          <div className="mb-4 flex flex-wrap items-center gap-3 rounded-[4px] bg-vl-warm px-4 py-2.5">
            <Hash className="h-4 w-4 text-vl-gold-deep" aria-hidden="true" />
            <span className="font-mono text-[14px] font-semibold" data-testid="selected-number">{selected}</span>
            <span className="vl-meta">selected</span>
            <Button variant="ghost" size="sm" className="ml-auto" onClick={reset} data-testid="numbers-start-over">
              Start over
            </Button>
          </div>
        ) : null}

        {step === 1 ? (
          <div className="space-y-4" data-testid="numbers-step1">
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
              <Field label="Country" htmlFor="n-country">
                <Input id="n-country" value={query.country} onChange={(e) => setQuery((q) => ({ ...q, country: e.target.value.toUpperCase() }))} />
              </Field>
              <Field label="State" htmlFor="n-state">
                <Select value={query.state} onValueChange={(v) => setQuery((q) => ({ ...q, state: v }))}>
                  <SelectTrigger id="n-state" data-testid="numbers-state">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {STATES.map((s) => (
                      <SelectItem key={s} value={s}>
                        {s}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field label="City (optional)" htmlFor="n-city">
                <Input id="n-city" value={query.city} onChange={(e) => setQuery((q) => ({ ...q, city: e.target.value }))} />
              </Field>
              <Field label="Contains digits" htmlFor="n-contains">
                <Input id="n-contains" value={query.contains} onChange={(e) => setQuery((q) => ({ ...q, contains: e.target.value }))} placeholder="e.g. 555" data-testid="numbers-contains" />
              </Field>
              <Field label="Results" htmlFor="n-limit">
                <Input id="n-limit" type="number" min="1" max="25" value={query.limit} onChange={(e) => setQuery((q) => ({ ...q, limit: e.target.value }))} />
              </Field>
            </div>
            <div className="flex gap-2">
              <Button onClick={search} disabled={searching} data-testid="numbers-search-button">
                {searching ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />} Search available numbers
              </Button>
            </div>
            {searchErr ? (
              <InlineNote tone="danger" icon={AlertCircle}>
                {errorMessage(searchErr)}
                <Button size="sm" variant="outline" className="ml-3" onClick={search}>
                  <RefreshCw className="h-4 w-4" /> Retry
                </Button>
              </InlineNote>
            ) : null}
            {results ? (
              results.length === 0 ? (
                <EmptyState compact icon={Search} title="No numbers match" description="Loosen the digits filter or try another state." />
              ) : (
                <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4" data-testid="numbers-results">
                  {results.map((r) => (
                    <li key={r.phone_number}>
                      <button onClick={() => { setSelected(r.phone_number); setStepState({ 2: { status: "idle" }, 3: { status: "idle" }, 4: { status: "idle" } }); setStep(2); }} className={cn("w-full rounded-[4px] border px-3 py-3 text-left hover:border-vl-gold transition-colors bg-white", selected === r.phone_number ? "border-vl-gold" : "border-vl-border")} data-testid="numbers-result">
                        <div className="font-mono text-[14px] font-semibold">{r.phone_number}</div>
                        <div className="vl-meta">{[r.region && r.region.city, r.region && r.region.state, r.region && r.region.country].filter(Boolean).join(", ")} · {(r.features || []).join("/")}</div>
                        <div className="vl-meta">${r.monthly_cost}/mo</div>
                      </button>
                    </li>
                  ))}
                </ul>
              )
            ) : null}
          </div>
        ) : null}

        {step === 2 ? (
          <StepPanel title="Purchase the number" state={stepState[2]} onRetry={() => purchase("purchase")} testId="numbers-step2">
            <p className="text-[13px] text-vl-secondary">Buys <span className="font-mono font-medium text-vl-text">{selected}</span> from the carrier and attaches it to the VeraLux voice connection.</p>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button onClick={() => purchase("purchase")} disabled={stepState[2].status === "running" || stepState[2].status === "done"} data-testid="numbers-purchase-button">
                <ShoppingCart className="h-4 w-4" /> Purchase
              </Button>
              <Button variant="outline" onClick={() => purchase("provision")} disabled={stepState[2].status === "running" || stepState[2].status === "done"} data-testid="numbers-provision-button">
                Provision (legacy)
              </Button>
              {stepState[2].status === "done" ? (
                <Button variant="ghost" onClick={() => setStep(3)}>
                  Continue <ArrowRight className="h-4 w-4" />
                </Button>
              ) : null}
            </div>
            {stepState[2].status === "done" && stepState[2].result && stepState[2].result.alreadyOwned ? <InlineNote className="mt-3">This number is already in the account, so no purchase was needed.</InlineNote> : null}
          </StepPanel>
        ) : null}

        {step === 3 ? (
          <StepPanel title="Add the number to a tenant" state={stepState[3]} onRetry={addToTenant} testId="numbers-step3">
            <div className="grid gap-3 sm:grid-cols-[1fr_auto] items-end">
              <Field label="Tenant" htmlFor="n-tenant">
                <Select value={targetTenant} onValueChange={setTargetTenant}>
                  <SelectTrigger id="n-tenant" data-testid="numbers-tenant-select">
                    <SelectValue placeholder="Choose a tenant" />
                  </SelectTrigger>
                  <SelectContent>
                    {tenants.map((t) => (
                      <SelectItem key={t.id} value={t.id}>
                        {t.name} · {(t.numbers || []).length} number{(t.numbers || []).length === 1 ? "" : "s"}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Button onClick={addToTenant} disabled={!targetTenant || stepState[3].status === "running" || stepState[3].status === "done"} data-testid="numbers-add-to-tenant-button">
                <Building2 className="h-4 w-4" /> Add to tenant
              </Button>
            </div>
            {stepState[3].status === "error" && stepState[3].error instanceof ApiError && stepState[3].error.code === "max_phone_numbers_exceeded" ? (
              <InlineNote tone="warning" icon={AlertCircle} className="mt-3">
                This tenant's plan allows {stepState[3].error.details && stepState[3].error.details.maxPhoneNumbers} number(s).{" "}
                <Link to="/admin/plans" className="font-medium text-vl-gold-deep">Raise the limit in Plans</Link>, then retry.
              </InlineNote>
            ) : null}
            {stepState[3].status === "done" ? (
              <Button variant="ghost" className="mt-3" onClick={() => setStep(4)}>
                Continue <ArrowRight className="h-4 w-4" />
              </Button>
            ) : null}
          </StepPanel>
        ) : null}

        {step === 4 ? (
          <StepPanel title="Map the DID to the runtime" state={stepState[4]} onRetry={mapDid} testId="numbers-step4">
            <p className="text-[13px] text-vl-secondary">Tells the voice runtime that calls to <span className="font-mono font-medium text-vl-text">{selected}</span> belong to <span className="font-medium text-vl-text">{targetTenant}</span>. Verified with a read-back.</p>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button onClick={mapDid} disabled={stepState[4].status === "running" || stepState[4].status === "done"} data-testid="numbers-map-did-button">
                <Link2 className="h-4 w-4" /> Map DID
              </Button>
              {stepState[4].status === "done" ? (
                <>
                  <Button asChild variant="outline">
                    <Link to={`/admin/tenants/${targetTenant}`}>View tenant</Link>
                  </Button>
                  <Button variant="ghost" onClick={reset}>
                    Provision another
                  </Button>
                </>
              ) : null}
            </div>
            {stepState[4].status === "done" ? (
              <InlineNote tone="success" icon={CheckCircle2} className="mt-3" testId="numbers-complete-note">
                Done. Remind the tenant to publish their receptionist if they haven't yet.
              </InlineNote>
            ) : null}
          </StepPanel>
        ) : null}
      </Card>

      <div className="grid gap-4 xl:grid-cols-12">
        <Card className="xl:col-span-8" padded={false} testId="numbers-inventory">
          <div className="p-5 pb-3">
            <CardHeader className="mb-0" title="Owned numbers" subtitle="Inventory and runtime mapping" icon={Hash} action={<Button variant="ghost" size="sm" onClick={refreshInventory}><RefreshCw className="h-4 w-4" /> Refresh</Button>} />
          </div>
          <QueryBoundary query={numbersQ} skeleton={<RowsSkeleton rows={4} className="px-5 pb-5" />} compact emptyWhen={(d) => !(d.numbers || []).length} empty={<EmptyState compact icon={Hash} title="No numbers owned" description="Search and purchase one above." />}>
            {(d) => (
              <table className="w-full text-[13px] vl-table">
                <thead>
                  <tr className="text-left border-t border-b border-vl-border">
                    <th className="py-2 px-5">Number</th>
                    <th className="py-2 pr-3">Status</th>
                    <th className="py-2 pr-3">Mapped tenant</th>
                    <th className="py-2 pr-3">Purchased</th>
                    <th className="py-2 pr-5"></th>
                  </tr>
                </thead>
                <tbody>
                  {d.numbers.map((n) => (
                    <tr key={n.phone_number} className="border-b border-vl-border last:border-0 vl-row" data-testid="owned-number-row">
                      <td className="py-2 px-5 font-mono font-medium">{n.phone_number}</td>
                      <td className="py-2 pr-3"><Pill size="sm" tone={n.status === "active" ? "success" : "neutral"}>{n.status}</Pill></td>
                      <td className="py-2 pr-3">{n.mappedTenantId ? <Link to={`/admin/tenants/${n.mappedTenantId}`} className="font-medium text-vl-gold-deep">{n.mappedTenantId}</Link> : <Pill size="sm" tone="warning">Unassigned</Pill>}</td>
                      <td className="py-2 pr-3 text-vl-muted whitespace-nowrap">{fmtRelative(n.purchased_at)}</td>
                      <td className="py-2 pr-5 text-right whitespace-nowrap">
                        {n.mappedTenantId ? (
                          <Button variant="ghost" size="sm" className="text-vl-danger hover:text-vl-danger" onClick={() => setUnmapping(n)} data-testid="unmap-did-button">
                            <Unlink className="h-4 w-4" /> Unmap
                          </Button>
                        ) : (
                          <Button variant="outline" size="sm" onClick={() => startFromOwned(n.phone_number)} data-testid="assign-owned-number-button">
                            Assign to tenant <ArrowRight className="h-4 w-4" />
                          </Button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </QueryBoundary>
        </Card>
        <Card className="xl:col-span-4" testId="carrier-status-card">
          <CardHeader title="Carrier account" icon={Radio} />
          <QueryBoundary query={statusQ} skeleton={<CardSkeleton lines={3} className="border-0 p-0" />} compact>
            {(s) => (
              <div className="grid grid-cols-2 gap-3">
                <Stat label="Account" value={s.account || "—"} className="col-span-2" />
                <Stat label="Owned" value={s.numbersOwned ?? "—"} />
                <Stat label="Mapped" value={s.numbersMapped ?? "—"} />
                {s.balanceCents !== undefined ? <Stat label="Balance" value={fmtMoney(s.balanceCents)} /> : null}
                <Stat label="Connection" value={s.connectionId || "—"} />
              </div>
            )}
          </QueryBoundary>
          <div className="mt-4">
            <div className="vl-eyebrow-dark mb-2">Connections</div>
            <QueryBoundary query={connQ} skeleton={<RowsSkeleton rows={1} />} compact>
              {(c) => (
                <ul className="space-y-1.5">
                  {(c.connections || []).map((x) => (
                    <li key={x.id} className="text-[13px] flex items-center justify-between gap-2">
                      <span className="truncate">{x.name}</span>
                      <Pill size="sm" tone={x.active ? "success" : "neutral"}>{x.active ? "Active" : "Inactive"}</Pill>
                    </li>
                  ))}
                </ul>
              )}
            </QueryBoundary>
          </div>
        </Card>
      </div>

      <ConfirmDialog open={!!unmapping} onOpenChange={(o) => !o && setUnmapping(null)} title={`Unmap ${unmapping && unmapping.phone_number}?`} description={`Calls to this number will stop routing to ${unmapping && unmapping.mappedTenantId}. The number stays in your inventory.`} confirmLabel="Unmap" destructive onConfirm={async () => { try { await api.post("/api/admin/runtime/dids/unmap", { didE164: unmapping.phone_number }); toast.success("Number unmapped"); setUnmapping(null); refreshInventory(); } catch (e) { toast.error("Couldn't unmap", { description: errorMessage(e) }); } }} />
    </div>
  );
}

const StepPanel = ({ title, state, onRetry, children, testId }) => (
  <div className="vl-card-soft p-4" data-testid={testId}>
    <div className="flex items-center gap-2 mb-2">
      <h3 className="text-[15px] font-semibold">{title}</h3>
      {state.status === "running" ? <Pill size="sm" icon={Loader2} className="[&_svg]:animate-spin">Working…</Pill> : null}
      {state.status === "done" ? <Pill size="sm" tone="success" icon={CheckCircle2}>Done</Pill> : null}
      {state.status === "error" ? <Pill size="sm" tone="danger" icon={AlertCircle}>Failed</Pill> : null}
    </div>
    {children}
    {state.status === "error" ? (
      <InlineNote tone="danger" icon={AlertCircle} className="mt-3" testId={`${testId}-error`}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span>{errorMessage(state.error)}</span>
          <Button size="sm" variant="outline" onClick={onRetry} data-testid={`${testId}-retry`}>
            <RefreshCw className="h-4 w-4" /> Retry this step
          </Button>
        </div>
      </InlineNote>
    ) : null}
  </div>
);
