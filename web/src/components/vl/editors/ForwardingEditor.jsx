import React from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Plus, Trash2, Save, AlertTriangle, PhoneForwarded } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field, InlineNote } from "@/components/vl/Cards";
import { QueryBoundary, CardSkeleton, EmptyState } from "@/components/vl/States";
import { errorMessage } from "@/lib/api";
import { isE164 } from "@/lib/format";
import { cn } from "@/lib/utils";

export const ForwardingEditor = ({ api, mode, tenantId, onSaved, upgradeHref, maxLocations }) => {
  const q = useQuery({ queryKey: [mode, "forwarding", tenantId], queryFn: () => api.get("/api/admin/forwarding-profiles"), enabled: !!tenantId });
  return (
    <QueryBoundary query={q} skeleton={<CardSkeleton lines={5} />} upgradeHref={upgradeHref}>
      {(data) => <ForwardingForm key={data.updatedAt || "init"} data={data} api={api} mode={mode} onSaved={onSaved} refetch={q.refetch} maxLocations={maxLocations} />}
    </QueryBoundary>
  );
};

const ForwardingForm = ({ data, api, mode, onSaved, refetch, maxLocations }) => {
  const [rows, setRows] = React.useState(() => (data.profiles || []).map((p, i) => ({ key: `${p.id || i}`, id: p.id || "", name: p.name || "", number: p.number || "", role: p.role || "" })));
  const [saving, setSaving] = React.useState(false);
  const update = (i, patch) => setRows((r) => r.map((row, idx) => (idx === i ? { ...row, ...patch } : row)));
  const invalid = rows.filter((r) => r.number.trim() && !isE164(r.number));

  const save = async () => {
    if (invalid.length) {
      toast.error("Fix phone numbers first", { description: "Use E.164 format like +15551234567." });
      return;
    }
    const payload = rows.filter((r) => r.name.trim()).map((r) => ({ id: r.id.trim() || undefined, name: r.name.trim(), number: r.number.trim() || undefined, role: r.role.trim() || undefined }));
    setSaving(true);
    try {
      const res = await api.post("/api/admin/forwarding-profiles", { profiles: payload });
      toast.success("Transfer lines saved", { description: res.published ? "Your receptionist can transfer to them now." : "Saved. Publish to make them live." });
      onSaved && onSaved(res);
      refetch();
    } catch (e) {
      toast.error("Couldn't save transfer lines", { description: errorMessage(e) });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-5" data-testid="forwarding-editor">
      <InlineNote tone="warning" icon={AlertTriangle}>
        Saving replaces the full list. Numbers must be in international format (+1…).{maxLocations ? ` Your plan allows up to ${maxLocations} transfer line${maxLocations === 1 ? "" : "s"}.` : ""}
      </InlineNote>
      {rows.length === 0 ? <EmptyState compact icon={PhoneForwarded} title="No transfer lines yet" description="Add the people or desks your receptionist can hand a caller to." /> : null}
      <div className="space-y-3">
        {rows.map((r, i) => {
          const bad = r.number.trim() && !isE164(r.number);
          return (
            <div key={r.key} className="vl-card-soft p-4 grid gap-3 md:grid-cols-[1.2fr_1fr_1fr_auto]" data-testid="forwarding-row">
              <Field label="Name" htmlFor={`fn-${r.key}`}>
                <Input id={`fn-${r.key}`} value={r.name} onChange={(e) => update(i, { name: e.target.value })} placeholder="Front desk" className="bg-white" data-testid="forwarding-name" />
              </Field>
              <Field label="Phone number" htmlFor={`fp-${r.key}`} hint={bad ? "Must look like +15551234567" : undefined}>
                <Input id={`fp-${r.key}`} value={r.number} onChange={(e) => update(i, { number: e.target.value })} placeholder="+15551234567" className={cn("bg-white", bad && "border-vl-danger")} aria-invalid={!!bad} data-testid="forwarding-number" />
              </Field>
              <Field label="Role" htmlFor={`fr-${r.key}`}>
                <Input id={`fr-${r.key}`} value={r.role} onChange={(e) => update(i, { role: e.target.value })} placeholder="owner, staff, emergency" className="bg-white" data-testid="forwarding-role" />
              </Field>
              <div className="flex items-end">
                <Button type="button" variant="ghost" size="icon" onClick={() => setRows((rr) => rr.filter((_, idx) => idx !== i))} aria-label="Remove transfer line" data-testid="forwarding-remove">
                  <Trash2 className="h-4 w-4 text-vl-danger" />
                </Button>
              </div>
            </div>
          );
        })}
      </div>
      <div className="flex items-center gap-2">
        <Button type="button" variant="outline" onClick={() => setRows((r) => [...r, { key: `new-${Date.now()}`, id: "", name: "", number: "", role: "" }])} data-testid="forwarding-add">
          <Plus className="h-4 w-4" /> Add transfer line
        </Button>
        <div className="ml-auto">
          <Button onClick={save} disabled={saving} data-testid="forwarding-save-button">
            <Save className="h-4 w-4" /> {saving ? "Saving…" : "Save transfer lines"}
          </Button>
        </div>
      </div>
    </div>
  );
};
