import React from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Save, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Card, CardHeader, Field, InlineNote } from "@/components/vl/Cards";
import { QueryBoundary, CardSkeleton } from "@/components/vl/States";
import { errorMessage } from "@/lib/api";

const VERTICALS = ["general", "plumbing", "hvac", "garage", "restoration"];

export function RulesForm({ api, tenantId, readOnly, canGrantEdit, onSaved }) {
  const q = useQuery({
    queryKey: ["shop-playbook", tenantId],
    queryFn: () => api.get("/api/admin/shop-playbook"),
    enabled: !!tenantId,
  });
  return (
    <QueryBoundary query={q} skeleton={<CardSkeleton lines={8} />}>
      {(data) => (
        <RulesInner
          key={`${data.version}-${data.ownerCanEdit}`}
          data={data}
          api={api}
          tenantId={tenantId}
          readOnly={readOnly && !data.ownerCanEdit}
          canGrantEdit={canGrantEdit}
          onSaved={onSaved}
          refetch={q.refetch}
        />
      )}
    </QueryBoundary>
  );
}

const csv = (xs) => (xs || []).join(", ");
const fromCsv = (s) =>
  String(s || "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);

const RulesInner = ({ data, api, readOnly, canGrantEdit, onSaved, refetch }) => {
  const p = data.playbook || {};
  const [form, setForm] = React.useState({
    vertical: p.vertical || "general",
    zips: csv(p.serviceArea && p.serviceArea.zips),
    cities: csv(p.serviceArea && p.serviceArea.cities),
    radiusMiles: (p.serviceArea && p.serviceArea.radiusMiles) || "",
    hubZip: (p.serviceArea && p.serviceArea.hubZip) || "",
    afterHoursFeeCents: p.afterHoursFeeCents || 0,
    refuseServices: csv(p.refuseServices),
    quoteHoldCents: p.quoteHoldCents || 250000,
    emergencyKeywords: csv(p.emergencyKeywords),
    membershipNames: csv(p.membershipNames),
    onCallE164: p.onCallE164 || "",
    onCallTimeoutSecs: p.onCallTimeoutSecs || 75,
    humanOverflowE164: p.humanOverflowE164 || "",
    digestSmsE164: (p.digest && p.digest.smsE164) || "",
    digestEmails: csv(p.digest && p.digest.emails),
    stormMode: !!(p.stormMode && p.stormMode.enabled),
    stormNote: (p.stormMode && p.stormMode.note) || "",
    stormParallelAnswerCap: (p.stormMode && p.stormMode.parallelAnswerCap) || 2,
    stormExpiresAt: p.stormMode && p.stormMode.expiresAt ? p.stormMode.expiresAt.slice(0, 16) : "",
  });
  const [busy, setBusy] = React.useState(false);
  const locked = readOnly;
  const save = async () => {
    setBusy(true);
    try {
      const res = await api.put("/api/admin/shop-playbook", {
        playbook: {
          vertical: form.vertical,
          serviceArea: {
            zips: fromCsv(form.zips),
            cities: fromCsv(form.cities),
            radiusMiles: form.radiusMiles ? Number(form.radiusMiles) : undefined,
            hubZip: form.hubZip || undefined,
          },
          afterHoursFeeCents: Number(form.afterHoursFeeCents) || 0,
          refuseServices: fromCsv(form.refuseServices),
          quoteHoldCents: Number(form.quoteHoldCents) || 0,
          emergencyKeywords: fromCsv(form.emergencyKeywords),
          membershipNames: fromCsv(form.membershipNames),
          onCallE164: form.onCallE164 || undefined,
          onCallTimeoutSecs: Number(form.onCallTimeoutSecs) || 75,
          humanOverflowE164: form.humanOverflowE164 || undefined,
          digest: {
            smsE164: form.digestSmsE164 || undefined,
            emails: fromCsv(form.digestEmails),
          },
          stormMode: {
            enabled: form.stormMode,
            note: form.stormNote,
            parallelAnswerCap: Number(form.stormParallelAnswerCap) || 2,
            expiresAt: form.stormExpiresAt ? new Date(form.stormExpiresAt).toISOString() : undefined,
          },
        },
      });
      toast.success("Shop rules saved", { description: res.published ? "Published to the live receptionist." : "Saved." });
      onSaved && onSaved(res);
      refetch();
    } catch (e) {
      toast.error("Couldn't save rules", { description: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };
  const grant = async (v) => {
    try {
      await api.patch("/api/admin/shop-playbook/permissions", { ownerCanEdit: v });
      toast.success(v ? "Owner can edit shop law" : "Owner is view-only again");
      refetch();
    } catch (e) {
      toast.error("Couldn't update owner edit flag", { description: errorMessage(e) });
    }
  };
  return (
    <div className="space-y-4" data-testid="rules-form">
      {locked ? (
        <InlineNote testId="rules-readonly">Shop law is read-only for the owner. VeraLux staff publish changes.</InlineNote>
      ) : null}
      <Card>
        <CardHeader title="Shop law" icon={ShieldCheck} subtitle={`Version ${data.version || 1}${data.nightDeskLive ? " · live" : ""}`} />
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Trade overlay">
            <Select value={form.vertical} onValueChange={(v) => setForm((f) => ({ ...f, vertical: v }))} disabled={locked}>
              <SelectTrigger data-testid="rules-vertical"><SelectValue /></SelectTrigger>
              <SelectContent>
                {VERTICALS.map((v) => (
                  <SelectItem key={v} value={v}>{v}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label="Quote-hold threshold (cents)" hint="Holds booking above this amount">
            <Input type="number" value={form.quoteHoldCents} disabled={locked} onChange={(e) => setForm((f) => ({ ...f, quoteHoldCents: e.target.value }))} data-testid="rules-quote-hold" />
          </Field>
          <Field label="Service zips" hint="Comma-separated 5-digit zips">
            <Input value={form.zips} disabled={locked} onChange={(e) => setForm((f) => ({ ...f, zips: e.target.value }))} data-testid="rules-zips" />
          </Field>
          <Field label="Service cities">
            <Input value={form.cities} disabled={locked} onChange={(e) => setForm((f) => ({ ...f, cities: e.target.value }))} />
          </Field>
          <Field label="Radius (miles)" hint="Optional; evaluator clients can supply measured distance">
            <Input type="number" value={form.radiusMiles} disabled={locked} onChange={(e) => setForm((f) => ({ ...f, radiusMiles: e.target.value }))} />
          </Field>
          <Field label="Hub zip">
            <Input value={form.hubZip} disabled={locked} onChange={(e) => setForm((f) => ({ ...f, hubZip: e.target.value }))} placeholder="99201" />
          </Field>
          <Field label="After-hours fee (cents)">
            <Input type="number" value={form.afterHoursFeeCents} disabled={locked} onChange={(e) => setForm((f) => ({ ...f, afterHoursFeeCents: e.target.value }))} />
          </Field>
          <Field label="On-call E.164">
            <Input value={form.onCallE164} disabled={locked} onChange={(e) => setForm((f) => ({ ...f, onCallE164: e.target.value }))} data-testid="rules-oncall" placeholder="+15095550100" />
          </Field>
          <Field label="Page timeout (seconds)" hint="60–90 typical">
            <Input type="number" value={form.onCallTimeoutSecs} disabled={locked} onChange={(e) => setForm((f) => ({ ...f, onCallTimeoutSecs: e.target.value }))} />
          </Field>
          <Field label="Human overflow E.164">
            <Input value={form.humanOverflowE164} disabled={locked} onChange={(e) => setForm((f) => ({ ...f, humanOverflowE164: e.target.value }))} />
          </Field>
          <Field label="We don't do" hint="Comma-separated refuse list" className="md:col-span-2">
            <Textarea rows={2} value={form.refuseServices} disabled={locked} onChange={(e) => setForm((f) => ({ ...f, refuseServices: e.target.value }))} data-testid="rules-refuse" />
          </Field>
          <Field label="Emergency keywords" className="md:col-span-2">
            <Textarea rows={2} value={form.emergencyKeywords} disabled={locked} onChange={(e) => setForm((f) => ({ ...f, emergencyKeywords: e.target.value }))} />
          </Field>
          <Field label="Membership names (no prices)" className="md:col-span-2">
            <Input value={form.membershipNames} disabled={locked} onChange={(e) => setForm((f) => ({ ...f, membershipNames: e.target.value }))} />
          </Field>
          <Field label="7am digest SMS">
            <Input value={form.digestSmsE164} disabled={locked} onChange={(e) => setForm((f) => ({ ...f, digestSmsE164: e.target.value }))} placeholder="+15095550100" />
          </Field>
          <Field label="7am digest emails" hint="Comma-separated">
            <Input value={form.digestEmails} disabled={locked} onChange={(e) => setForm((f) => ({ ...f, digestEmails: e.target.value }))} />
          </Field>
        </div>
        <div className="mt-4 flex items-center gap-3">
          <Switch checked={form.stormMode} disabled={locked} onCheckedChange={(v) => setForm((f) => ({ ...f, stormMode: v }))} data-testid="rules-storm" />
          <span className="text-[13px]">Storm / surge mode (hold new books)</span>
        </div>
        {form.stormMode ? (
          <div className="mt-3 grid gap-3 md:grid-cols-3">
            <Field label="Storm note">
              <Input value={form.stormNote} disabled={locked} onChange={(e) => setForm((f) => ({ ...f, stormNote: e.target.value }))} />
            </Field>
            <Field label="Parallel answer cap">
              <Input type="number" min="1" value={form.stormParallelAnswerCap} disabled={locked} onChange={(e) => setForm((f) => ({ ...f, stormParallelAnswerCap: e.target.value }))} />
            </Field>
            <Field label="Expires">
              <Input type="datetime-local" value={form.stormExpiresAt} disabled={locked} onChange={(e) => setForm((f) => ({ ...f, stormExpiresAt: e.target.value }))} />
            </Field>
          </div>
        ) : null}
        <div className="mt-5 flex justify-end gap-2">
          {canGrantEdit ? (
            <Button variant="outline" onClick={() => grant(!data.ownerCanEdit)}>
              {data.ownerCanEdit ? "Revoke owner edit" : "Allow owner edit"}
            </Button>
          ) : null}
          <Button onClick={save} disabled={busy || locked} data-testid="rules-save">
            <Save className="h-4 w-4" /> {busy ? "Saving…" : "Save rules"}
          </Button>
        </div>
      </Card>
    </div>
  );
};
