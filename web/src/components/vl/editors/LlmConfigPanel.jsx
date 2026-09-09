import React from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Save, KeyRound, CheckCircle2, FlaskConical, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Field, InlineNote } from "@/components/vl/Cards";
import { Pill } from "@/components/vl/Pills";
import { QueryBoundary, CardSkeleton } from "@/components/vl/States";
import { errorMessage } from "@/lib/api";
import { cn } from "@/lib/utils";
import { fromLlmConfig, toLlmConfigSave, TENANT_LLM_PROVIDERS } from "@/lib/controlPlaneAdapters";

export const LlmConfigPanel = ({ api, mode, tenantId, onSaved }) => {
  const base = mode === "portal" ? "/api/owner/llm-config" : `/api/admin/tenants/${tenantId}/llm-config`;
  const q = useQuery({ queryKey: [mode, "llm", tenantId], queryFn: () => api.get(base), enabled: !!tenantId });
  return (
    <QueryBoundary query={q} skeleton={<CardSkeleton lines={5} />}>
      {(data) => {
        const mapped = fromLlmConfig(data);
        return <LlmForm key={`${mapped.mode}-${mapped.tenantProvider}-${mapped.hasApiKey}`} data={mapped} api={api} mode={mode} base={base} onSaved={onSaved} refetch={q.refetch} />;
      }}
    </QueryBoundary>
  );
};

const LlmForm = ({ data, api, mode, base, onSaved, refetch }) => {
  const [form, setForm] = React.useState({ mode: data.mode || "platform", tenantProvider: data.tenantProvider || "openai", tenantModel: data.tenantModel || "" });
  const [apiKey, setApiKey] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  const [testing, setTesting] = React.useState(false);
  const [testResult, setTestResult] = React.useState(null);

  const save = async () => {
    setSaving(true);
    try {
      const res = await api.post(base, toLlmConfigSave({ ...form, apiKey }));
      toast.success("AI model settings saved");
      setApiKey("");
      onSaved && onSaved(res);
      refetch();
    } catch (e) {
      toast.error("Couldn't save", { description: errorMessage(e) });
    } finally {
      setSaving(false);
    }
  };
  const test = async () => {
    if (!apiKey) {
      toast.error("Enter an API key to test");
      return;
    }
    setTesting(true);
    setTestResult(null);
    try {
      const r = await api.post(`${base}/test`, { apiKey, model: form.tenantModel || undefined, tenantProvider: form.tenantProvider });
      setTestResult(r);
    } catch (e) {
      setTestResult({ ok: false, message: errorMessage(e) });
    } finally {
      setTesting(false);
    }
  };
  const removeKey = async () => {
    try {
      if (mode === "portal") await api.post("/api/owner/llm-config/api-key", toLlmConfigSave({ mode: "tenant", removeApiKey: true, tenantProvider: form.tenantProvider, tenantModel: form.tenantModel }));
      else await api.post(base, toLlmConfigSave({ mode: "platform" }));
      toast.success("API key removed");
      refetch();
    } catch (e) {
      toast.error("Couldn't remove key", { description: errorMessage(e) });
    }
  };

  return (
    <div className="space-y-4" data-testid="llm-config-panel">
      <div className="grid gap-2 sm:grid-cols-2" role="radiogroup" aria-label="AI model source">
        {[
          ["platform", "VeraLux managed", `Recommended. Uses the on-prem ${data.platformModel || "Qwen3.5-27B"} model. No API keys needed.`],
          ["tenant", "Bring your own provider", "Use your own OpenAI, Anthropic, Gemini, Groq, or xAI key."],
        ].map(([id, label, hint]) => (
          <button key={id} type="button" role="radio" aria-checked={form.mode === id} onClick={() => setForm((f) => ({ ...f, mode: id }))} className={cn("rounded-[4px] border px-3.5 py-3 text-left transition-colors bg-white", form.mode === id ? "border-vl-gold" : "border-vl-border hover:bg-vl-soft")} data-testid={`llm-mode-${id}`}>
            <div className="text-[13px] font-medium">{label}</div>
            <div className="vl-meta">{hint}</div>
          </button>
        ))}
      </div>

      {form.mode === "tenant" ? (
        <div className="vl-card-soft p-4 space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Provider" htmlFor="llm-prov">
              <Select value={form.tenantProvider} onValueChange={(v) => {
                const next = TENANT_LLM_PROVIDERS.find((p) => p.id === v);
                setForm((f) => ({ ...f, tenantProvider: v, tenantModel: next && (!f.tenantModel || TENANT_LLM_PROVIDERS.some((p) => p.defaultModel === f.tenantModel)) ? next.defaultModel : f.tenantModel }));
              }}>
                <SelectTrigger id="llm-prov" className="bg-white" data-testid="llm-provider">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {TENANT_LLM_PROVIDERS.map((p) => (
                    <SelectItem key={p.id} value={p.id}>{p.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field label="Model" htmlFor="llm-model" hint={form.tenantProvider === "groq" ? "Groq Cloud API — they host the model. Use openai/gpt-oss-120b or openai/gpt-oss-20b." : "Leave blank for the provider default."}>
              <Input id="llm-model" value={form.tenantModel} onChange={(e) => setForm((f) => ({ ...f, tenantModel: e.target.value }))} placeholder={TENANT_LLM_PROVIDERS.find((p) => p.id === form.tenantProvider)?.defaultModel || "model id"} className="bg-white" data-testid="llm-model" />
            </Field>
          </div>
          <Field label="API key" htmlFor="llm-key" hint="Keys are stored securely and never shown again.">
            <div className="flex flex-wrap items-center gap-2">
              <Input id="llm-key" type="password" autoComplete="off" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder={data.hasApiKey ? "Enter a new key to replace" : "sk-…"} className="bg-white flex-1 min-w-[200px]" data-testid="llm-api-key" />
              <Button type="button" variant="outline" onClick={test} disabled={testing} data-testid="llm-test-button">
                <FlaskConical className="h-4 w-4" /> {testing ? "Testing…" : "Test key"}
              </Button>
              {data.hasApiKey ? (
                <>
                  <Pill tone="success" icon={CheckCircle2} testId="llm-key-set-pill">
                    Key set
                  </Pill>
                  <Button type="button" variant="ghost" size="sm" className="text-vl-danger hover:text-vl-danger" onClick={removeKey} data-testid="llm-remove-key">
                    <Trash2 className="h-4 w-4" /> Remove
                  </Button>
                </>
              ) : (
                <Pill tone="neutral" icon={KeyRound}>
                  No key
                </Pill>
              )}
            </div>
          </Field>
          {testResult ? (
            <InlineNote tone={testResult.ok ? "success" : "danger"} icon={testResult.ok ? CheckCircle2 : FlaskConical} testId="llm-test-result">
              {testResult.ok ? `Key works${testResult.model ? ` with ${testResult.model}` : ""}.` : testResult.message || `Provider returned ${testResult.status}.`}
            </InlineNote>
          ) : null}
        </div>
      ) : (
        <InlineNote>Your receptionist runs on the on-prem Qwen3.5-27B model. No API keys needed.</InlineNote>
      )}

      <div className="flex justify-end">
        <Button onClick={save} disabled={saving} data-testid="llm-save-button">
          <Save className="h-4 w-4" /> {saving ? "Saving…" : "Save model settings"}
        </Button>
      </div>
    </div>
  );
};
