import React from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Plus, Trash2, Wand2, UploadCloud, AlertTriangle, MessageCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Field, InlineNote } from "@/components/vl/Cards";
import { QueryBoundary, CardSkeleton, EmptyState } from "@/components/vl/States";
import { ApiError, errorMessage } from "@/lib/api";
import { toSuggestRequest, fromSuggestResponse } from "@/lib/controlPlaneAdapters";

export const QuickRepliesEditor = ({ api, mode, tenantId, onSaved, onPublished }) => {
  const q = useQuery({ queryKey: [mode, "quick-replies", tenantId], queryFn: () => api.get(`/api/admin/runtime/tenants/${tenantId}/quick-replies`), enabled: !!tenantId });
  return (
    <QueryBoundary query={q} skeleton={<CardSkeleton lines={6} />}>
      {(data) => <QuickRepliesForm key={data.lastRuntimePublishedAt || "init"} data={data} api={api} tenantId={tenantId} mode={mode} onSaved={onSaved} onPublished={onPublished} refetch={q.refetch} />}
    </QueryBoundary>
  );
};

const toRows = (items) => (items || []).map((it, i) => ({ key: `${it.id || i}-${i}`, id: it.id || "", match: (it.match || []).join(", "), reply: it.reply || "" }));

const QuickRepliesForm = ({ data, api, tenantId, mode, onSaved, onPublished, refetch }) => {
  const [rows, setRows] = React.useState(() => toRows(data.quickReplies));
  const [saving, setSaving] = React.useState(false);
  const [publishing, setPublishing] = React.useState(false);
  const [suggesting, setSuggesting] = React.useState(false);
  const [suggestions, setSuggestions] = React.useState(null);
  const missing = !!data.runtimeConfigMissing;

  const update = (i, patch) => setRows((r) => r.map((row, idx) => (idx === i ? { ...row, ...patch } : row)));
  const add = (item) => setRows((r) => [...r, { key: `new-${Date.now()}-${r.length}`, id: item?.id || "", match: item ? (item.match || []).join(", ") : "", reply: item?.reply || "" }]);
  const remove = (i) => setRows((r) => r.filter((_, idx) => idx !== i));

  const publishFirst = async () => {
    setPublishing(true);
    try {
      const res = await api.post(`/api/admin/runtime/tenants/${tenantId}/publish-from-tenant`);
      toast.success("Receptionist published", { description: "You can now save quick replies." });
      onPublished && onPublished(res);
      refetch();
    } catch (e) {
      toast.error("Publish failed", { description: errorMessage(e) });
      onPublished && onPublished(null, e);
    } finally {
      setPublishing(false);
    }
  };

  const suggest = async () => {
    setSuggesting(true);
    try {
      const raw = { maxIntents: 8 };
      try {
        const p = await api.get("/api/admin/prompts");
        raw.greetingText = p.greetingText;
        raw.systemPreamble = p.systemPreamble;
        raw.voicePrompt = p.voicePrompt;
        raw.policyPrompt = p.policyPrompt;
      } catch (e) {
        /* optional */
      }
      try {
        const pr = await api.get("/api/admin/pricing");
        raw.pricingItems = pr.items;
        raw.pricingNotes = pr.notes;
      } catch (e) {
        if (!(e instanceof ApiError && e.isFeatureGate)) throw e;
      }
      try {
        const fw = await api.get("/api/admin/forwarding-profiles");
        raw.forwardingLines = fw.profiles;
      } catch (e) {
        if (!(e instanceof ApiError && e.isFeatureGate)) throw e;
      }
      const res = await api.post("/api/admin/quick-replies/suggest", toSuggestRequest(raw));
      setSuggestions(fromSuggestResponse(res));
    } catch (e) {
      toast.error("Couldn't get suggestions", { description: errorMessage(e) });
    } finally {
      setSuggesting(false);
    }
  };

  const save = async () => {
    const payload = rows
      .filter((r) => r.match.trim() || r.reply.trim())
      .map((r) => ({ id: r.id.trim() || undefined, match: r.match.split(",").map((m) => m.trim()).filter(Boolean), reply: r.reply.trim() }));
    const bad = payload.find((p) => !p.match.length || !p.reply);
    if (bad) {
      toast.error("Each quick reply needs at least one phrase and a reply");
      return;
    }
    setSaving(true);
    try {
      const res = await api.put(`/api/admin/runtime/tenants/${tenantId}/quick-replies`, { quickReplies: payload });
      toast.success("Quick replies published", { description: "Your receptionist is using them now." });
      onSaved && onSaved(res);
      onPublished && onPublished(res);
      refetch();
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) toast.error("Publish your receptionist first", { description: errorMessage(e) });
      else toast.error("Couldn't save quick replies", { description: errorMessage(e) });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-5" data-testid="quick-replies-editor">
      {missing ? (
        <InlineNote tone="warning" icon={AlertTriangle} testId="runtime-missing-note">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="font-medium">Your receptionist has not been published yet</div>
              <div className="text-[12px] text-vl-secondary">Publish once to activate it, then quick replies can be saved.</div>
            </div>
            <Button size="sm" onClick={publishFirst} disabled={publishing} data-testid="publish-first-button">
              <UploadCloud className="h-4 w-4" /> {publishing ? "Publishing…" : "Publish now"}
            </Button>
          </div>
        </InlineNote>
      ) : (
        <InlineNote icon={MessageCircle}>Quick replies answer common questions instantly, before the AI has to think. Saving publishes them right away.</InlineNote>
      )}

      {rows.length === 0 ? (
        <EmptyState compact icon={MessageCircle} title="No quick replies yet" description="Add answers for questions like hours, parking or pricing, or let us suggest a starter set." />
      ) : null}

      <div className="space-y-3">
        {rows.map((r, i) => (
          <div key={r.key} className="vl-card-soft p-4 grid gap-3 md:grid-cols-[1fr_1.4fr_auto]" data-testid="quick-reply-row">
            <Field label="When callers say" htmlFor={`m-${r.key}`} hint="Comma-separated phrases">
              <Input id={`m-${r.key}`} value={r.match} onChange={(e) => update(i, { match: e.target.value })} placeholder="hours, open, close" className="bg-white" data-testid="quick-reply-match" />
            </Field>
            <Field label="Reply with" htmlFor={`r-${r.key}`}>
              <Textarea id={`r-${r.key}`} rows={2} value={r.reply} onChange={(e) => update(i, { reply: e.target.value })} placeholder="We're open 9 to 5 weekdays." className="bg-white" data-testid="quick-reply-reply" />
            </Field>
            <div className="flex md:flex-col items-end justify-between gap-2">
              {mode === "admin" ? <Input value={r.id} onChange={(e) => update(i, { id: e.target.value })} placeholder="id" className="h-8 w-[110px] bg-white text-[12px]" aria-label="Quick reply id" /> : <span className="vl-meta">{r.id ? `#${r.id}` : ""}</span>}
              <Button type="button" variant="ghost" size="icon" onClick={() => remove(i)} aria-label="Remove quick reply" data-testid="quick-reply-remove">
                <Trash2 className="h-4 w-4 text-vl-danger" />
              </Button>
            </div>
          </div>
        ))}
      </div>

      {suggestions ? (
        <div className="vl-card p-4 space-y-3" data-testid="quick-reply-suggestions">
          <div className="flex items-center justify-between">
            <div className="text-[13px] font-medium">Suggested quick replies</div>
            <div className="flex gap-2">
              <Button size="sm" variant="outline" onClick={() => setSuggestions(null)}>
                Dismiss
              </Button>
              <Button size="sm" onClick={() => { suggestions.forEach((s) => add(s)); setSuggestions(null); }} data-testid="add-all-suggestions">
                Add all
              </Button>
            </div>
          </div>
          <p className="vl-meta">Suggestions are drafts — nothing is saved until you publish.</p>
          <ul className="divide-y divide-vl-border">
            {suggestions.map((s, i) => (
              <li key={i} className="flex items-start justify-between gap-3 py-2.5">
                <div className="min-w-0">
                  <div className="text-[13px] font-medium truncate">{(s.match || []).join(", ")}</div>
                  <div className="text-[13px] text-vl-secondary">{s.reply}</div>
                </div>
                <Button size="sm" variant="ghost" onClick={() => { add(s); setSuggestions((list) => list.filter((_, idx) => idx !== i)); }} data-testid="add-suggestion">
                  <Plus className="h-4 w-4" /> Add
                </Button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="outline" onClick={() => add()} data-testid="quick-reply-add">
          <Plus className="h-4 w-4" /> Add quick reply
        </Button>
        <Button type="button" variant="outline" onClick={suggest} disabled={suggesting} data-testid="quick-reply-suggest">
          <Wand2 className="h-4 w-4" /> {suggesting ? "Thinking…" : "Suggest replies"}
        </Button>
        <div className="ml-auto">
          <Button onClick={save} disabled={saving || missing} data-testid="quick-reply-save-button">
            <UploadCloud className="h-4 w-4" /> {saving ? "Publishing…" : "Save & publish"}
          </Button>
        </div>
      </div>
    </div>
  );
};
