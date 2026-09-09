import React from "react";
import { Link, useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Plus, Building2, Search, ArrowRight, KeyRound, Hash, Pencil, CheckCircle2, AlertCircle, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { ConfirmDialog } from "@/components/vl/ConfirmDialog";
import { PageHeader, Card, Field, InlineNote } from "@/components/vl/Cards";
import { Pill } from "@/components/vl/Pills";
import { QueryBoundary, RowsSkeleton, EmptyState } from "@/components/vl/States";
import { useAdmin } from "../AdminApp";
import { errorMessage } from "@/lib/api";
import { fmtRelative, fmtDateTime } from "@/lib/format";
import { normalizeTenantUpsert } from "@/lib/controlPlaneAdapters";

export default function Tenants() {
  const { api, tenantsQ, tenantId, setTenantId } = useAdmin();
  const navigate = useNavigate();
  const [search, setSearch] = React.useState("");
  const [editing, setEditing] = React.useState(null); // null | {} | tenant
  const [creds, setCreds] = React.useState(null);

  const select = (t) => {
    setTenantId(t.id);
    navigate(`/admin/tenants/${t.id}`);
  };

  return (
    <div data-testid="admin-tenants-page">
      <PageHeader serif={false} eyebrow="Platform" title="Tenants" subtitle="Every business running a VeraLux receptionist. Select one to put it in context." actions={<Button onClick={() => setEditing({})} data-testid="admin-create-tenant-button"><Plus className="h-4 w-4" /> New tenant</Button>} />
      <Card padded={false}>
        <div className="flex items-center gap-3 p-4 border-b border-vl-border">
          <div className="relative flex-1 max-w-sm">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-vl-muted" aria-hidden="true" />
            <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search by name, id or number" className="pl-9 h-9" aria-label="Search tenants" data-testid="tenant-search" />
          </div>
          {tenantsQ.data ? <span className="vl-meta ml-auto">{tenantsQ.data.tenants.length} tenants</span> : null}
        </div>
        <QueryBoundary query={tenantsQ} skeleton={<RowsSkeleton rows={5} className="p-5" />}>
          {(d) => {
            const q = search.trim().toLowerCase();
            const rows = d.tenants.filter((t) => !q || t.name.toLowerCase().includes(q) || t.id.toLowerCase().includes(q) || (t.numbers || []).some((n) => n.includes(q)));
            if (!rows.length) return <EmptyState icon={Building2} title={q ? "No tenants match" : "No tenants yet"} description={q ? "Try a different search." : "Create the first tenant to get started."} action={!q ? <Button onClick={() => setEditing({})}>Create tenant</Button> : null} />;
            return (
              <div className="overflow-x-auto vl-scroll">
                <table className="w-full text-[13px] vl-table" data-testid="tenants-table">
                  <thead>
                    <tr className="text-left border-b border-vl-border">
                      <th className="py-2.5 px-4">Tenant</th>
                      <th className="py-2.5 pr-3">Numbers</th>
                      <th className="py-2.5 pr-3">Business number</th>
                      <th className="py-2.5 pr-3">Created</th>
                      <th className="py-2.5 pr-3">Updated</th>
                      <th className="py-2.5 pr-4"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((t) => (
                      <tr key={t.id} className={`border-b border-vl-border last:border-0 vl-row hover:bg-vl-soft ${t.id === tenantId ? "bg-vl-warm/60" : ""}`} data-testid="tenant-row">
                        <td className="py-2.5 px-4">
                          <button onClick={() => select(t)} className="text-left" data-testid={`tenant-open-${t.id}`}>
                            <div className="font-medium flex items-center gap-2">
                              {t.name}
                              {t.id === tenantId ? <Pill size="sm" tone="gold">In context</Pill> : null}
                            </div>
                            <div className="vl-meta">{t.id}</div>
                          </button>
                        </td>
                        <td className="py-2.5 pr-3 whitespace-nowrap">{(t.numbers || []).length ? t.numbers.join(", ") : <span className="vl-meta">none</span>}</td>
                        <td className="py-2.5 pr-3 whitespace-nowrap">{t.businessNumber || <span className="vl-meta">—</span>}</td>
                        <td className="py-2.5 pr-3 text-vl-muted whitespace-nowrap" title={fmtDateTime(t.createdAt)}>{fmtRelative(t.createdAt)}</td>
                        <td className="py-2.5 pr-3 text-vl-muted whitespace-nowrap" title={fmtDateTime(t.updatedAt)}>{fmtRelative(t.updatedAt)}</td>
                        <td className="py-2.5 pr-4 text-right whitespace-nowrap">
                          <Button variant="ghost" size="sm" onClick={() => setCreds(t)} data-testid="tenant-credentials-button">
                            <KeyRound className="h-4 w-4" /> Owner login
                          </Button>
                          <Button variant="ghost" size="sm" onClick={() => setEditing(t)} data-testid="tenant-edit-button">
                            <Pencil className="h-4 w-4" /> Edit
                          </Button>
                          <DeleteTenantControl
                            api={api}
                            tenant={t}
                            onDeleted={(deleted) => {
                              const remaining = ((tenantsQ.data && tenantsQ.data.tenants) || []).filter((x) => x.id !== deleted.id);
                              if (deleted.id === tenantId) setTenantId(remaining[0] ? remaining[0].id : null);
                              tenantsQ.refetch();
                            }}
                          />
                          <Button variant="ghost" size="sm" onClick={() => select(t)} data-testid="tenant-select-button">
                            Open <ArrowRight className="h-4 w-4" />
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          }}
        </QueryBoundary>
      </Card>
      {editing !== null ? <TenantSheet api={api} tenant={editing} onClose={() => setEditing(null)} onSaved={(t, created) => { tenantsQ.refetch(); if (created) { setTenantId(t.id); setCreds(t); } }} /> : null}
      {creds ? <CredentialsSheet api={api} tenant={creds} onClose={() => setCreds(null)} /> : null}
    </div>
  );
}

export const DeleteTenantControl = ({ api, tenant, onDeleted, variant = "outline", size = "sm" }) => {
  const [open, setOpen] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const protectedTenant = tenant.id === "default";
  const run = async () => {
    setBusy(true);
    try {
      await api.del(`/api/admin/tenants/${encodeURIComponent(tenant.id)}`);
      toast.success("Tenant deleted", { description: tenant.name || tenant.id });
      setOpen(false);
      onDeleted && onDeleted(tenant);
    } catch (e) {
      toast.error("Couldn't delete tenant", { description: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Button
        variant={variant}
        size={size}
        disabled={protectedTenant}
        title={protectedTenant ? "The default tenant cannot be deleted" : "Delete tenant"}
        onClick={() => setOpen(true)}
        className={protectedTenant ? "" : "text-vl-danger hover:text-vl-danger"}
        data-testid="tenant-delete-button"
      >
        <Trash2 className="h-4 w-4" /> Delete
      </Button>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title={`Delete ${tenant.name || tenant.id}?`}
        description={`This permanently removes ${tenant.id}, its numbers, calls, leads, workflows, and owner login. Published runtime config is unpublished. Type the tenant id to confirm.`}
        confirmLabel="Delete tenant"
        confirmText={tenant.id}
        destructive
        loading={busy}
        onConfirm={run}
        testId="delete-tenant-dialog"
      />
    </>
  );
};

const TENANT_ID_ALPHABET = "abcdefghijkmnopqrstuvwxyz23456789";

function generateTenantId() {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => TENANT_ID_ALPHABET[b % TENANT_ID_ALPHABET.length]).join("");
}

export const TenantSheet = ({ api, tenant, onClose, onSaved }) => {
  const isNew = !tenant.id;
  const [form, setForm] = React.useState({ id: tenant.id || generateTenantId(), name: tenant.name || "", numbers: (tenant.numbers || []).join("\n"), businessNumber: tenant.businessNumber || "" });
  const [busy, setBusy] = React.useState(false);
  const slugOk = /^[a-zA-Z0-9_-]{1,64}$/.test(form.id);
  const save = async () => {
    if (!slugOk) {
      toast.error("Tenant id must be letters, numbers, - or _ (max 64)");
      return;
    }
    setBusy(true);
    try {
      const raw = await api.post("/api/admin/tenants", { id: form.id.trim(), name: form.name.trim() || undefined, numbers: form.numbers, businessNumber: form.businessNumber.trim() || null });
      const { tenant, created } = normalizeTenantUpsert(raw);
      toast.success(created || isNew ? "Tenant created" : "Tenant updated", { description: created || isNew ? "Next: set the owner's portal login." : undefined });
      onSaved(tenant, created || isNew);
      onClose();
    } catch (e) {
      toast.error("Couldn't save tenant", { description: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Sheet open onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="w-full sm:max-w-lg overflow-y-auto bg-vl-canvas" data-testid="tenant-edit-sheet">
        <SheetHeader>
          <SheetTitle>{isNew ? "New tenant" : `Edit ${tenant.name}`}</SheetTitle>
          <SheetDescription>
            {isNew
              ? "The account id is a random code. The business name can change later without changing it."
              : "The account id stays fixed. Changing the business name does not rename it."}
          </SheetDescription>
        </SheetHeader>
        <div className="mt-5 space-y-4">
          <Field label="Account id" htmlFor="t-id" hint={isNew ? "Random letters and numbers. Used in URLs and records. Not derived from the business name." : "Permanent code. Calls, numbers, and settings stay attached to this id."} required>
            <div className="flex gap-2">
              <Input id="t-id" value={form.id} disabled readOnly className="bg-vl-soft font-mono" data-testid="tenant-id-input" />
              {isNew ? (
                <Button type="button" variant="outline" onClick={() => setForm((f) => ({ ...f, id: generateTenantId() }))} data-testid="tenant-id-regenerate">
                  New code
                </Button>
              ) : null}
            </div>
          </Field>
          <Field label="Business name" htmlFor="t-name">
            <Input id="t-name" value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} placeholder="Acme Salon" className="bg-white" data-testid="tenant-name-input" />
          </Field>
          <Field label="Receptionist numbers" htmlFor="t-numbers" hint="E.164, one per line or comma separated. Limited by the plan's maxPhoneNumbers.">
            <Textarea id="t-numbers" rows={3} value={form.numbers} onChange={(e) => setForm((f) => ({ ...f, numbers: e.target.value }))} placeholder="+15551234567" className="bg-white font-mono" data-testid="tenant-numbers-input" />
          </Field>
          <Field label="Business number (owner's own line)" htmlFor="t-biz">
            <Input id="t-biz" value={form.businessNumber} onChange={(e) => setForm((f) => ({ ...f, businessNumber: e.target.value }))} placeholder="+15557654321" className="bg-white font-mono" data-testid="tenant-business-number-input" />
          </Field>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button onClick={save} disabled={busy || !form.id} data-testid="tenant-save-button">
              {busy ? "Saving…" : isNew ? "Create tenant" : "Save changes"}
            </Button>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
};

export const CredentialsSheet = ({ api, tenant, onClose }) => {
  const qc = useQueryClient();
  const statusQ = useQuery({ queryKey: ["admin", "owner-portal-status", tenant.id], queryFn: () => api.get(`/api/admin/tenants/${tenant.id}/owner-portal-status`) });
  const [email, setEmail] = React.useState({ email: "", password: "" });
  const [passcode, setPasscode] = React.useState("");
  const [reset, setReset] = React.useState({ currentPassword: "", newPassword: "" });
  const [resetPc, setResetPc] = React.useState({ currentPasscode: "", newPasscode: "" });
  const [busy, setBusy] = React.useState("");
  const s = statusQ.data;
  const refresh = () => qc.invalidateQueries({ queryKey: ["admin", "owner-portal-status", tenant.id] });

  const run = async (key, fn, ok) => {
    setBusy(key);
    try {
      await fn();
      toast.success(ok);
      refresh();
    } catch (e) {
      toast.error("Request failed", { description: errorMessage(e) });
    } finally {
      setBusy("");
    }
  };

  return (
    <Sheet open onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="w-full sm:max-w-lg overflow-y-auto bg-vl-canvas" data-testid="tenant-credentials-sheet">
        <SheetHeader>
          <SheetTitle>Owner portal login · {tenant.name}</SheetTitle>
          <SheetDescription>How the business owner signs in to their customer portal.</SheetDescription>
        </SheetHeader>
        <div className="mt-5 space-y-5">
          <div className="flex flex-wrap gap-2" data-testid="owner-portal-status">
            <Pill tone={s && s.emailLoginSet ? "success" : "neutral"} icon={s && s.emailLoginSet ? CheckCircle2 : AlertCircle}>
              Email login {s ? (s.emailLoginSet ? `set${s.email ? ` · ${s.email}` : ""}` : "not set") : "…"}
            </Pill>
            <Pill tone={s && s.passcodeSet ? "success" : "neutral"} icon={s && s.passcodeSet ? CheckCircle2 : AlertCircle}>
              Phone passcode {s ? (s.passcodeSet ? "set" : "not set") : "…"}
            </Pill>
          </div>

          <div className="vl-card p-4 space-y-3">
            <div className="text-[13px] font-semibold inline-flex items-center gap-2">
              <KeyRound className="h-4 w-4 text-vl-gold-deep" aria-hidden="true" /> {s && s.emailLoginSet ? "Replace email login" : "Set email login"}
            </div>
            <Field label="Owner email" htmlFor="c-email" hint="Must be unique across tenants.">
              <Input id="c-email" type="email" value={email.email} onChange={(e) => setEmail((f) => ({ ...f, email: e.target.value }))} placeholder="owner@business.com" data-testid="owner-email-input" />
            </Field>
            <Field label="Password" htmlFor="c-pass" hint="Minimum 8 characters. Share it with the owner securely.">
              <Input id="c-pass" type="text" value={email.password} onChange={(e) => setEmail((f) => ({ ...f, password: e.target.value }))} data-testid="owner-password-input" />
            </Field>
            <Button size="sm" disabled={busy === "email" || !email.email || email.password.length < 8} onClick={() => run("email", () => api.post("/api/owner/set-portal-credentials", { tenantId: tenant.id, ...email }), "Owner email login saved")} data-testid="owner-credentials-save">
              Save email login
            </Button>
          </div>

          <div className="vl-card p-4 space-y-3">
            <div className="text-[13px] font-semibold inline-flex items-center gap-2">
              <Hash className="h-4 w-4 text-vl-gold-deep" aria-hidden="true" /> {s && s.passcodeSet ? "Replace phone passcode" : "Set phone passcode"}
            </div>
            <p className="vl-meta">Owner signs in with one of the tenant numbers ({(tenant.numbers || []).join(", ") || "none yet"}{tenant.businessNumber ? `, ${tenant.businessNumber}` : ""}) plus this passcode.</p>
            <Field label="Passcode" htmlFor="c-pc" hint="At least 4 characters">
              <Input id="c-pc" value={passcode} onChange={(e) => setPasscode(e.target.value)} data-testid="owner-passcode-input" />
            </Field>
            <Button size="sm" variant="outline" disabled={busy === "pc" || passcode.length < 4} onClick={() => run("pc", () => api.post("/api/owner/set-passcode", { tenantId: tenant.id, passcode }), "Passcode saved")} data-testid="owner-passcode-save">
              Save passcode
            </Button>
          </div>

          {s && (s.emailLoginSet || s.passcodeSet) ? (
            <details className="vl-card p-4">
              <summary className="cursor-pointer text-[13px] font-semibold">Admin-assisted reset (requires current secret)</summary>
              <div className="mt-3 space-y-4">
                {s.emailLoginSet ? (
                  <div className="grid gap-2 sm:grid-cols-[1fr_1fr_auto] items-end">
                    <Field label="Current password" htmlFor="r-cp">
                      <Input id="r-cp" type="password" value={reset.currentPassword} onChange={(e) => setReset((f) => ({ ...f, currentPassword: e.target.value }))} />
                    </Field>
                    <Field label="New password" htmlFor="r-np">
                      <Input id="r-np" type="text" value={reset.newPassword} onChange={(e) => setReset((f) => ({ ...f, newPassword: e.target.value }))} />
                    </Field>
                    <Button size="sm" variant="outline" disabled={busy === "rp" || !reset.currentPassword || reset.newPassword.length < 8} onClick={() => run("rp", () => api.post(`/api/admin/tenants/${tenant.id}/owner-portal-password/change`, reset), "Password changed")}>
                      Change
                    </Button>
                  </div>
                ) : null}
                {s.passcodeSet ? (
                  <div className="grid gap-2 sm:grid-cols-[1fr_1fr_auto] items-end">
                    <Field label="Current passcode" htmlFor="r-cc">
                      <Input id="r-cc" type="password" value={resetPc.currentPasscode} onChange={(e) => setResetPc((f) => ({ ...f, currentPasscode: e.target.value }))} />
                    </Field>
                    <Field label="New passcode" htmlFor="r-nc">
                      <Input id="r-nc" type="text" value={resetPc.newPasscode} onChange={(e) => setResetPc((f) => ({ ...f, newPasscode: e.target.value }))} />
                    </Field>
                    <Button size="sm" variant="outline" disabled={busy === "rc" || !resetPc.currentPasscode || resetPc.newPasscode.length < 4} onClick={() => run("rc", () => api.post(`/api/admin/tenants/${tenant.id}/owner-passcode/change`, resetPc), "Passcode changed")}>
                      Change
                    </Button>
                  </div>
                ) : null}
              </div>
            </details>
          ) : null}
          <InlineNote>There is no forgot-password flow. Owners who are locked out need a staff-assisted reset here.</InlineNote>
          <div className="vl-card p-4 space-y-2" data-testid="owner-portal-handoff">
            <div className="text-[13px] font-semibold">Owner portal handoff</div>
            <p className="vl-meta">Share this URL after you set credentials. The welcome banner shows when opened from here.</p>
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="outline"
                type="button"
                onClick={() => {
                  const url = `${window.location.origin}/portal?from=admin`;
                  navigator.clipboard.writeText(url).then(
                    () => toast.success("Portal URL copied"),
                    () => toast.error("Could not copy"),
                  );
                }}
                data-testid="copy-portal-url"
              >
                Copy portal URL
              </Button>
              <Button size="sm" variant="outline" type="button" asChild>
                <a href="/portal?from=admin" target="_blank" rel="noreferrer" data-testid="open-portal-handoff">
                  Open portal
                </a>
              </Button>
            </div>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
};
