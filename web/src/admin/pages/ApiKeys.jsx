import React from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { KeyRound, Plus, Copy, Trash2, AlertTriangle, CheckCircle2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { PageHeader, Card, Field, InlineNote } from "@/components/vl/Cards";
import { Pill } from "@/components/vl/Pills";
import { QueryBoundary, RowsSkeleton, EmptyState, StaffOnlyState } from "@/components/vl/States";
import { ConfirmDialog } from "@/components/vl/ConfirmDialog";
import { useAdmin } from "../AdminApp";
import { errorMessage } from "@/lib/api";
import { fmtDateTime, fmtRelative } from "@/lib/format";

export default function ApiKeys() {
  const { api, caps } = useAdmin();
  const q = useQuery({ queryKey: ["admin", "api-keys"], queryFn: () => api.get("/api/admin/auth/keys"), enabled: caps.keys !== false });
  const [creating, setCreating] = React.useState(false);
  const [created, setCreated] = React.useState(null);
  const [revoking, setRevoking] = React.useState(null);
  const [busy, setBusy] = React.useState(false);
  const [form, setForm] = React.useState({ name: "", role: "tenant-viewer", tenants: "" });

  if (caps.keys === false) {
    return (
      <div data-testid="admin-api-keys-page">
        <PageHeader serif={false} eyebrow="Operations" title="API keys" />
        <Card>
          <StaffOnlyState description="Admin API keys grant platform access and can only be managed by superadmins." />
        </Card>
      </div>
    );
  }

  const create = async () => {
    setBusy(true);
    try {
      const body = { name: form.name.trim(), role: form.role };
      if (form.role !== "superadmin" && form.tenants.trim()) body.tenants = form.tenants.split(",").map((t) => t.trim()).filter(Boolean);
      const r = await api.post("/api/admin/auth/keys", body);
      setCreated(r);
      setCreating(false);
      setForm({ name: "", role: "tenant-viewer", tenants: "" });
      q.refetch();
    } catch (e) {
      toast.error("Couldn't create key", { description: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };
  const revoke = async () => {
    setBusy(true);
    try {
      await api.del(`/api/admin/auth/keys/${revoking.id}`);
      toast.success("Key revoked");
      setRevoking(null);
      q.refetch();
    } catch (e) {
      toast.error("Couldn't revoke", { description: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div data-testid="admin-api-keys-page">
      <PageHeader serif={false} eyebrow="Operations" title="API keys" subtitle="Machine credentials for the control plane (X-Admin-Key). Tokens are shown once at creation." actions={<Button onClick={() => setCreating(true)} data-testid="api-key-create-button"><Plus className="h-4 w-4" /> New key</Button>} />
      <Card padded={false}>
        <QueryBoundary query={q} skeleton={<RowsSkeleton rows={4} className="p-5" />} emptyWhen={(d) => !(d.keys || []).length} empty={<EmptyState icon={KeyRound} title="No API keys" description="Create one for CI, integrations or scripts." action={<Button onClick={() => setCreating(true)}>Create key</Button>} />}>
          {(d) => (
            <table className="w-full text-[13px] vl-table" data-testid="api-keys-table">
              <thead>
                <tr className="text-left border-b border-vl-border">
                  <th className="py-2.5 px-4">Name</th>
                  <th className="py-2.5 pr-3">Prefix</th>
                  <th className="py-2.5 pr-3">Role</th>
                  <th className="py-2.5 pr-3">Scope</th>
                  <th className="py-2.5 pr-3">Created</th>
                  <th className="py-2.5 pr-3">Last used</th>
                  <th className="py-2.5 pr-4"></th>
                </tr>
              </thead>
              <tbody>
                {d.keys.map((k) => (
                  <tr key={k.id} className="border-b border-vl-border last:border-0 vl-row" data-testid="api-key-row">
                    <td className="py-2.5 px-4 font-medium">{k.name}</td>
                    <td className="py-2.5 pr-3 font-mono text-vl-secondary">{k.prefix}…</td>
                    <td className="py-2.5 pr-3"><Pill size="sm" tone={k.role === "superadmin" ? "dark" : "neutral"}>{k.role}</Pill></td>
                    <td className="py-2.5 pr-3 text-vl-secondary">{k.tenants ? k.tenants.join(", ") : "All tenants"}</td>
                    <td className="py-2.5 pr-3 text-vl-muted whitespace-nowrap" title={fmtDateTime(k.createdAt)}>{fmtRelative(k.createdAt)}</td>
                    <td className="py-2.5 pr-3 text-vl-muted whitespace-nowrap">{k.lastUsedAt ? fmtRelative(k.lastUsedAt) : "Never"}</td>
                    <td className="py-2.5 pr-4 text-right">
                      <Button variant="ghost" size="sm" className="text-vl-danger hover:text-vl-danger" onClick={() => setRevoking(k)} data-testid="api-key-revoke-button">
                        <Trash2 className="h-4 w-4" /> Revoke
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </QueryBoundary>
      </Card>

      <Dialog open={creating} onOpenChange={setCreating}>
        <DialogContent data-testid="api-key-create-dialog">
          <DialogHeader>
            <DialogTitle>Create API key</DialogTitle>
            <DialogDescription>Give it a descriptive name so it can be identified in the audit log.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <Field label="Name" htmlFor="k-name" required>
              <Input id="k-name" value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} placeholder="CI smoke tests" data-testid="api-key-name-input" />
            </Field>
            <Field label="Role" htmlFor="k-role">
              <Select value={form.role} onValueChange={(v) => setForm((f) => ({ ...f, role: v }))}>
                <SelectTrigger id="k-role" data-testid="api-key-role">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="tenant-viewer">tenant-viewer (read-only)</SelectItem>
                  <SelectItem value="tenant-admin">tenant-admin</SelectItem>
                  <SelectItem value="superadmin">superadmin</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            {form.role !== "superadmin" ? (
              <Field label="Tenant scope" htmlFor="k-tenants" hint="Comma-separated tenant ids. Leave empty for no tenant access.">
                <Input id="k-tenants" value={form.tenants} onChange={(e) => setForm((f) => ({ ...f, tenants: e.target.value }))} placeholder="roosevelt-barber, acme-salon" data-testid="api-key-tenants" />
              </Field>
            ) : (
              <InlineNote tone="warning" icon={AlertTriangle}>Superadmin keys can manage every tenant and the carrier account.</InlineNote>
            )}
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setCreating(false)}>
                Cancel
              </Button>
              <Button onClick={create} disabled={busy || !form.name.trim()} data-testid="api-key-create-submit">
                {busy ? "Creating…" : "Create key"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={!!created} onOpenChange={(o) => !o && setCreated(null)}>
        <DialogContent data-testid="api-key-created-dialog">
          <DialogHeader>
            <DialogTitle>Copy your new key</DialogTitle>
            <DialogDescription>This is the only time the full token is shown.</DialogDescription>
          </DialogHeader>
          {created ? (
            <div className="space-y-3">
              <InlineNote tone="warning" icon={AlertTriangle}>{created.warning || "Store it somewhere safe now. It cannot be retrieved later."}</InlineNote>
              <div className="flex items-center gap-2 rounded-[4px] border border-vl-border bg-vl-soft p-3">
                <code className="flex-1 break-all text-[12px]" data-testid="api-key-token">{created.token}</code>
                <Button size="sm" onClick={() => { navigator.clipboard && navigator.clipboard.writeText(created.token); toast.success("Token copied"); }} data-testid="api-key-copy-button">
                  <Copy className="h-4 w-4" /> Copy
                </Button>
              </div>
              <div className="flex items-center gap-2 text-[13px]">
                <CheckCircle2 className="h-4 w-4 text-vl-success" aria-hidden="true" /> {created.key.name} · <Pill size="sm">{created.key.role}</Pill>
              </div>
              <div className="flex justify-end">
                <Button onClick={() => setCreated(null)} data-testid="api-key-created-done">I've saved it</Button>
              </div>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>

      <ConfirmDialog open={!!revoking} onOpenChange={(o) => !o && setRevoking(null)} title={`Revoke “${revoking && revoking.name}”?`} description="Anything using this key will stop working immediately. This cannot be undone." confirmLabel="Revoke key" destructive onConfirm={revoke} loading={busy} />
    </div>
  );
}
