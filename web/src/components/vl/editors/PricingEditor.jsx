import React from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Plus, Trash2, Save, AlertTriangle, Tag } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Field, InlineNote } from "@/components/vl/Cards";
import { QueryBoundary, CardSkeleton, EmptyState } from "@/components/vl/States";
import { errorMessage } from "@/lib/api";

export const PricingEditor = ({ api, mode, tenantId, onSaved, upgradeHref }) => {
  const q = useQuery({ queryKey: [mode, "pricing", tenantId], queryFn: () => api.get("/api/admin/pricing"), enabled: !!tenantId });
  return (
    <QueryBoundary query={q} skeleton={<CardSkeleton lines={6} />} upgradeHref={upgradeHref}>
      {(data) => <PricingForm key={data.updatedAt || "init"} data={data} api={api} onSaved={onSaved} refetch={q.refetch} />}
    </QueryBoundary>
  );
};

const PricingForm = ({ data, api, onSaved, refetch }) => {
  const [items, setItems] = React.useState(() => (data.items || []).map((it, i) => ({ key: `${i}-${it.name}`, name: it.name || "", price: it.price ?? "", description: it.description || "" })));
  const [notes, setNotes] = React.useState(data.notes || "");
  const [saving, setSaving] = React.useState(false);
  const update = (i, patch) => setItems((r) => r.map((row, idx) => (idx === i ? { ...row, ...patch } : row)));

  const save = async () => {
    const payload = items.filter((it) => it.name.trim()).map((it) => ({ name: it.name.trim(), price: Number(it.price), description: it.description.trim() || undefined }));
    if (payload.some((p) => Number.isNaN(p.price))) {
      toast.error("Every service needs a numeric price");
      return;
    }
    setSaving(true);
    try {
      const res = await api.post("/api/admin/pricing", { items: payload, notes });
      toast.success("Services saved", { description: res.published ? "Your receptionist can quote the new list." : "Saved. Publish to make it live." });
      onSaved && onSaved(res);
      refetch();
    } catch (e) {
      toast.error("Couldn't save services", { description: errorMessage(e) });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-5" data-testid="pricing-editor">
      <InlineNote tone="warning" icon={AlertTriangle}>Saving replaces the full list. Remove a row here and it is removed from what your receptionist quotes.</InlineNote>
      {items.length === 0 ? <EmptyState compact icon={Tag} title="No services yet" description="Add the services and prices your receptionist is allowed to quote." /> : null}
      <div className="space-y-3">
        {items.map((it, i) => (
          <div key={it.key} className="vl-card-soft p-4 grid gap-3 md:grid-cols-[1.2fr_120px_1.6fr_auto]" data-testid="pricing-row">
            <Field label="Service" htmlFor={`n-${it.key}`}>
              <Input id={`n-${it.key}`} value={it.name} onChange={(e) => update(i, { name: e.target.value })} placeholder="Classic Haircut" className="bg-white" data-testid="pricing-name" />
            </Field>
            <Field label="Price (USD)" htmlFor={`p-${it.key}`}>
              <Input id={`p-${it.key}`} type="number" min="0" step="0.01" value={it.price} onChange={(e) => update(i, { price: e.target.value })} placeholder="35" className="bg-white" data-testid="pricing-price" />
            </Field>
            <Field label="Description" htmlFor={`d-${it.key}`}>
              <Input id={`d-${it.key}`} value={it.description} onChange={(e) => update(i, { description: e.target.value })} placeholder="Optional" className="bg-white" data-testid="pricing-description" />
            </Field>
            <div className="flex items-end">
              <Button type="button" variant="ghost" size="icon" onClick={() => setItems((r) => r.filter((_, idx) => idx !== i))} aria-label="Remove service" data-testid="pricing-remove">
                <Trash2 className="h-4 w-4 text-vl-danger" />
              </Button>
            </div>
          </div>
        ))}
      </div>
      <Field label="Notes for the receptionist" htmlFor="pricing-notes" hint="Tax, walk-in policy, deposits — anything that qualifies the prices.">
        <Textarea id="pricing-notes" rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} data-testid="pricing-notes" />
      </Field>
      <div className="flex items-center gap-2">
        <Button type="button" variant="outline" onClick={() => setItems((r) => [...r, { key: `new-${Date.now()}`, name: "", price: "", description: "" }])} data-testid="pricing-add">
          <Plus className="h-4 w-4" /> Add service
        </Button>
        <div className="ml-auto">
          <Button onClick={save} disabled={saving} data-testid="pricing-save-button">
            <Save className="h-4 w-4" /> {saving ? "Saving…" : "Save services"}
          </Button>
        </div>
      </div>
    </div>
  );
};
