import React from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Save, ChevronDown, MessageSquareQuote, Sparkles, ShieldCheck, Mic2, Braces } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Field } from "@/components/vl/Cards";
import { QueryBoundary, CardSkeleton } from "@/components/vl/States";
import { errorMessage } from "@/lib/api";

const SECTIONS = [
  { key: "greetingText", label: "Greeting / first response", icon: MessageSquareQuote, hint: "The very first thing callers hear. Keep it short and warm.", rows: 3 },
  { key: "systemPreamble", label: "Personality & instructions", icon: Sparkles, hint: "Who your receptionist is, how it sounds, and what it helps with.", rows: 6 },
  { key: "policyPrompt", label: "Rules & boundaries", icon: ShieldCheck, hint: "What it must never do or promise. Escalation rules go here.", rows: 5 },
  { key: "voicePrompt", label: "Voice direction", icon: Mic2, hint: "Pacing, tone and delivery guidance for spoken responses.", rows: 3 },
];

export const PromptsEditor = ({ api, mode, tenantId, onSaved }) => {
  const q = useQuery({ queryKey: [mode, "prompts", tenantId], queryFn: () => api.get("/api/admin/prompts"), enabled: !!tenantId });
  return (
    <QueryBoundary query={q} skeleton={<CardSkeleton lines={8} />}>
      {(data) => <PromptsForm key={data.updatedAt || "init"} data={data} api={api} mode={mode} onSaved={onSaved} refetch={q.refetch} />}
    </QueryBoundary>
  );
};

const PromptsForm = ({ data, api, mode, onSaved, refetch }) => {
  const [form, setForm] = React.useState({ greetingText: data.greetingText || "", systemPreamble: data.systemPreamble || "", policyPrompt: data.policyPrompt || "", voicePrompt: data.voicePrompt || "", schemaHint: data.schemaHint || "" });
  const [advanced, setAdvanced] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const dirty = Object.keys(form).some((k) => (form[k] || "") !== (data[k] || ""));

  const save = async () => {
    setSaving(true);
    try {
      const res = await api.post("/api/admin/prompts", form);
      toast.success("Personality saved", { description: res.published ? "Your receptionist is live with the new personality." : "Saved. Publish to make it live." });
      onSaved && onSaved(res);
      refetch();
    } catch (e) {
      toast.error("Couldn't save", { description: errorMessage(e) });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-5" data-testid="prompts-editor">
      {SECTIONS.map((s) => (
        <div key={s.key} className="vl-card-soft p-4">
          <Field
            htmlFor={`p-${s.key}`}
            label={
              <span className="inline-flex items-center gap-2">
                <s.icon className="h-4 w-4 text-vl-gold-deep" aria-hidden="true" /> {s.label}
                {mode === "admin" ? <code className="ml-1 rounded bg-vl-warm px-1.5 py-0.5 text-[11px] text-vl-muted">{s.key}</code> : null}
              </span>
            }
            hint={s.hint}
          >
            <Textarea id={`p-${s.key}`} rows={s.rows} value={form[s.key]} onChange={(e) => setForm((f) => ({ ...f, [s.key]: e.target.value }))} className="bg-white" data-testid={`prompt-${s.key}`} />
          </Field>
        </div>
      ))}

      <div className="vl-card-soft">
        <button type="button" className="flex w-full items-center justify-between px-4 py-3 text-left text-[13px] font-medium" onClick={() => setAdvanced((v) => !v)} aria-expanded={advanced} data-testid="prompts-advanced-toggle">
          <span className="inline-flex items-center gap-2">
            <Braces className="h-4 w-4 text-vl-secondary" aria-hidden="true" /> Advanced prompt settings
          </span>
          <ChevronDown className={`h-4 w-4 text-vl-muted transition-transform ${advanced ? "rotate-180" : ""}`} aria-hidden="true" />
        </button>
        {advanced ? (
          <div className="border-t border-vl-border px-4 py-4">
            <Field htmlFor="p-schemaHint" label={<span>Information to capture {mode === "admin" ? <code className="ml-1 rounded bg-vl-warm px-1.5 py-0.5 text-[11px] text-vl-muted">schemaHint</code> : null}</span>} hint="Tell the receptionist which details to collect from callers (name, service, preferred time, callback number).">
              <Textarea id="p-schemaHint" rows={3} value={form.schemaHint} onChange={(e) => setForm((f) => ({ ...f, schemaHint: e.target.value }))} className="bg-white" data-testid="prompt-schemaHint" />
            </Field>
          </div>
        ) : null}
      </div>

      <div className="flex items-center justify-end gap-3">
        {dirty ? <span className="vl-meta">Unsaved changes</span> : null}
        <Button onClick={save} disabled={saving || !dirty} data-testid="prompts-save-button">
          <Save className="h-4 w-4" /> {saving ? "Saving…" : "Save personality"}
        </Button>
      </div>
    </div>
  );
};
