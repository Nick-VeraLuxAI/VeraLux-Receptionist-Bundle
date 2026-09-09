import React from "react";
import { Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  AudioLines,
  BookOpen,
  CheckCircle2,
  ChevronDown,
  Cloud,
  CloudCog,
  Cpu,
  ExternalLink,
  Globe,
  Mic2,
  Orbit,
  Phone,
  RefreshCw,
  Rocket,
  Save,
  Server,
  Sparkles,
  TrainFront,
  Trash2,
  AlertTriangle,
  Zap,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Card, CardHeader, Field, InlineNote, Stat } from "@/components/vl/Cards";
import { Pill } from "@/components/vl/Pills";
import { QueryBoundary, CardSkeleton } from "@/components/vl/States";
import { ConfirmDialog } from "@/components/vl/ConfirmDialog";
import { useAdmin } from "../AdminApp";
import { TenantContextBar, NoTenant } from "../AdminShell";
import { errorMessage } from "@/lib/api";
import { fmtDateTime, fmtMoney, fmtNumber } from "@/lib/format";
import { cn } from "@/lib/utils";

const moneyMin = (c) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 4, maximumFractionDigits: 4 }).format((Number(c) || 0) / 100);

const SLOT_KEY = { host: "hostSku", telco: "telcoSku", stt: "sttSku", llm: "llmSku", tts: "ttsSku" };

const FAMILY_OF = {
  kokoro: "onprem_tts",
};

const FAMILIES = {
  render: { name: "Render", hint: "Paid web + Postgres + Redis. Free spin-down is blocked.", icon: Cloud },
  railway: { name: "Railway", hint: "One project per tenant on Hobby or Pro.", icon: TrainFront },
  aws: { name: "AWS", hint: "Fargate + RDS + Redis. HTTP ALB DNS until you attach ACM.", icon: CloudCog },
  telnyx: { name: "Telnyx", hint: "Inbound PSTN is required on every pipeline.", icon: Phone },
  openai: { name: "OpenAI", hint: "GPT-4o, 4.1, 5, and o4 on the public API.", icon: Sparkles },
  deepgram: { name: "Deepgram", hint: "Nova-2 cloud speech-to-text.", icon: AudioLines },
  whisper: { name: "On-prem Whisper", hint: "Self-hosted HTTP. $0 API line.", icon: Server },
  anthropic: { name: "Anthropic", hint: "Haiku 4.5, Sonnet 4.5, and Opus 4.6.", icon: BookOpen },
  google: { name: "Google", hint: "Gemini 2.5 via your own key.", icon: Globe },
  groq: { name: "Groq", hint: "Cloud API at api.groq.com — they host GPT-OSS; we call it with your key. Not a local Llama box.", icon: Zap },
  xai: { name: "xAI", hint: "Grok 3 and 4 via your own key.", icon: Orbit },
  platform: { name: "On-prem Qwen", hint: "VeraLux managed Qwen 3.5 27B (GPTQ Int4). $0 API line.", icon: Cpu },
  onprem: { name: "On-prem", hint: "This hub. GPU STT, LLM, and TTS stay here. $0 host line.", icon: Server },
  elevenlabs: { name: "ElevenLabs", hint: "Flash TTS for the assistant voice.", icon: Mic2 },
  onprem_tts: { name: "Kokoro", hint: "On-prem TTS. The only local voice engine. $0 API line.", icon: Server },
};

function familyId(component) {
  return FAMILY_OF[component.provider] || component.provider;
}

function skuChipLabel(label, familyName) {
  const stripped = String(label || "")
    .replace(new RegExp(familyName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"), "")
    .replace(/\(on-prem\)/i, "")
    .trim();
  return stripped || label;
}

function groupFamilies(components) {
  const order = [];
  const map = new Map();
  for (const c of components || []) {
    const id = familyId(c);
    if (!map.has(id)) {
      map.set(id, []);
      order.push(id);
    }
    map.get(id).push(c);
  }
  return order.map((id) => ({ id, meta: FAMILIES[id] || { name: id, hint: "", icon: Server }, skus: map.get(id) }));
}

function deriveMinutes(calls, avg) {
  return Math.max(1, Math.round(Number(calls || 0) * Number(avg || 0)));
}

function catalogHasSku(components, sku) {
  return (components || []).some((c) => c.sku === sku);
}

const KOKORO_TTS_SKU = "tts:kokoro_http";

function isSelectableComponent(c) {
  if (!c || c.slot !== "tts") return true;
  if (c.hostOk) return true;
  return c.sku === KOKORO_TTS_SKU;
}

function coerceSku(components, slot, sku, fallback) {
  let next = sku;
  if (slot === "tts" && next && next !== KOKORO_TTS_SKU && !(components || []).some((c) => c.sku === next && c.hostOk)) {
    next = KOKORO_TTS_SKU;
  }
  if (catalogHasSku(components, next)) return next;
  const first = (components || []).find((c) => c.slot === slot);
  return (first && first.sku) || fallback;
}

function fmtMs(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return "—";
  if (n >= 1000) return `${(n / 1000).toFixed(1)}s`;
  return `${Math.round(n)}ms`;
}

export default function Pipeline() {
  const { api, tenantId } = useAdmin();
  if (!tenantId) return <NoTenant />;
  return <PipelineBody api={api} tenantId={tenantId} />;
}

const PipelineBody = ({ api, tenantId }) => {
  const qc = useQueryClient();
  const catalogQ = useQuery({ queryKey: ["admin", "pipeline-catalog"], queryFn: () => api.get("/api/admin/pipeline/catalog") });
  const pipelineQ = useQuery({
    queryKey: ["admin", "pipeline", tenantId],
    queryFn: () => api.get(`/api/admin/tenants/${tenantId}/pipeline`),
    refetchInterval: (q) => {
      const s = q.state.data && q.state.data.deployment && q.state.data.deployment.status;
      const js = q.state.data && q.state.data.job && q.state.data.job.status;
      return s === "pending" || s === "provisioning" || js === "running" || js === "pending" ? 4000 : false;
    },
  });
  const [form, setForm] = React.useState(null);
  const [estimate, setEstimate] = React.useState(null);
  const [freshness, setFreshness] = React.useState(null);
  const [busy, setBusy] = React.useState(false);
  const [teardownOpen, setTeardownOpen] = React.useState(false);
  const [advancedOpen, setAdvancedOpen] = React.useState(false);

  React.useEffect(() => {
    if (form || !pipelineQ.isFetched || !catalogQ.isFetched) return;
    const p = (pipelineQ.data && pipelineQ.data.pipeline) || {};
    const a = p.assumptions || {};
    const calls = Number(a.assumedMonthlyCalls) > 0 ? Number(a.assumedMonthlyCalls) : 200;
    const minutes = Number(a.assumedMonthlyMinutes) > 0 ? Number(a.assumedMonthlyMinutes) : 500;
    const avg = Number(a.avgMinutesPerCall) > 0 ? Number(a.avgMinutesPerCall) : Math.round((minutes / calls) * 10) / 10;
    const components = ((catalogQ.data && catalogQ.data.components) || []).filter(isSelectableComponent);
    setForm({
      hostSku: coerceSku(components, "host", p.hostSku, "onprem:hub"),
      sttSku: coerceSku(components, "stt", p.sttSku, "openai:whisper-1"),
      llmSku: coerceSku(components, "llm", p.llmSku, "openai:gpt-4o-mini"),
      ttsSku: coerceSku(components, "tts", p.ttsSku, KOKORO_TTS_SKU),
      telcoSku: coerceSku(components, "telco", p.telcoSku, "telnyx:inbound"),
      assumedMonthlyCalls: calls,
      avgMinutesPerCall: avg || 2.5,
      assumedMonthlyMinutes: minutes,
      callerTalkRatio: a.callerTalkRatio || 0.55,
      llmInputTokensPerMin: a.llmInputTokensPerMin || 1200,
      llmOutputTokensPerMin: a.llmOutputTokensPerMin || 400,
      ttsCharsPerMin: a.ttsCharsPerMin || 750,
      retailMarginBps: a.retailMarginBps || 4000,
      replyTokensPerTurn: a.replyTokensPerTurn || 80,
    });
    if (p.lastEstimate) setEstimate(p.lastEstimate);
  }, [pipelineQ.isFetched, pipelineQ.data, form, catalogQ.isFetched, catalogQ.data]);

  const estimatePayload = (next) => ({
    ...next,
    assumedMonthlyMinutes: next.assumedMonthlyMinutes || deriveMinutes(next.assumedMonthlyCalls, next.avgMinutesPerCall),
    assistantTalkRatio: Math.round((1 - Number(next.callerTalkRatio || 0.55)) * 100) / 100,
  });

  const estimateReq = React.useCallback(async (next) => {
    if (!next) return;
    try {
      const r = await api.post("/api/admin/pipeline/estimate", estimatePayload(next));
      setEstimate(r.estimate);
      setFreshness(r.freshness);
    } catch (e) {
      toast.error("Couldn't estimate", { description: errorMessage(e) });
    }
  }, [api]);

  React.useEffect(() => {
    if (!form) return;
    const t = setTimeout(() => estimateReq(form), 200);
    return () => clearTimeout(t);
  }, [form, estimateReq]);

  const slotOptions = (slot) => ((catalogQ.data && catalogQ.data.components) || []).filter((c) => c.slot === slot && isSelectableComponent(c));

  const save = async () => {
    setBusy(true);
    try {
      await api.put(`/api/admin/tenants/${tenantId}/pipeline`, estimatePayload(form));
      toast.success("Pipeline saved");
      qc.invalidateQueries({ queryKey: ["admin", "pipeline", tenantId] });
    } catch (e) {
      toast.error("Couldn't save", { description: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };

  const apply = async (copyRetail) => {
    setBusy(true);
    try {
      await api.put(`/api/admin/tenants/${tenantId}/pipeline`, estimatePayload(form));
      const r = await api.post(`/api/admin/tenants/${tenantId}/pipeline/apply`, { copyRetailToOverage: copyRetail });
      qc.invalidateQueries({ queryKey: ["admin", "pipeline", tenantId] });
      if (r && r.remoteApplyError) {
        toast.error("Hub applied; remote stack failed", { description: r.remoteApplyError });
      } else if (r && r.remoteApplied) {
        toast.success(copyRetail ? "Applied on hub and remote; retail copied to overage" : "Applied on hub and remote stack");
      } else {
        toast.success(copyRetail ? "Applied and copied retail rate to plan overage" : "Applied to receptionist config");
      }
    } catch (e) {
      toast.error("Couldn't apply", { description: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };

  const refreshPrices = async () => {
    setBusy(true);
    try {
      await api.post("/api/admin/pipeline/pricing/refresh", {});
      await catalogQ.refetch();
      await estimateReq(form);
      toast.success("Price refresh started");
    } catch (e) {
      toast.error("Refresh failed", { description: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };

  const provision = async () => {
    setBusy(true);
    try {
      await api.put(`/api/admin/tenants/${tenantId}/pipeline`, estimatePayload(form));
      const r = await api.post(`/api/admin/tenants/${tenantId}/deployments`, { hostSku: form.hostSku });
      toast.success("Provision started", { description: r.deploymentId });
      qc.invalidateQueries({ queryKey: ["admin", "pipeline", tenantId] });
    } catch (e) {
      toast.error("Couldn't provision", { description: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };

  const patchForm = (patch) => setForm((f) => ({ ...f, ...patch }));

  const setCalls = (calls) => {
    setForm((f) => ({
      ...f,
      assumedMonthlyCalls: calls,
      assumedMonthlyMinutes: deriveMinutes(calls, f.avgMinutesPerCall),
    }));
  };

  const setAvgMinutes = (avg) => {
    setForm((f) => ({
      ...f,
      avgMinutesPerCall: avg,
      assumedMonthlyMinutes: deriveMinutes(f.assumedMonthlyCalls, avg),
    }));
  };

  const setTotalMinutes = (minutes) => {
    setForm((f) => {
      const calls = f.assumedMonthlyCalls || 1;
      return {
        ...f,
        assumedMonthlyMinutes: minutes,
        avgMinutesPerCall: Math.max(0.5, Math.round((minutes / calls) * 10) / 10),
      };
    });
  };

  const selectSku = (slot, sku) => patchForm({ [SLOT_KEY[slot]]: sku });

  const deployment = pipelineQ.data && pipelineQ.data.deployment;
  const job = pipelineQ.data && pipelineQ.data.job;
  const hostComp = slotOptions("host").find((c) => c.sku === (form && form.hostSku));
  const creds = (catalogQ.data && catalogQ.data.hostCredentials) || {};
  const onPremHost = Boolean(hostComp && hostComp.provider === "onprem");
  const hostHasKeys = Boolean(hostComp && (
    (hostComp.hostProvider === "render" && creds.renderConfigured) ||
    (hostComp.hostProvider === "railway" && creds.railwayConfigured) ||
    (hostComp.hostProvider === "aws" && creds.awsConfigured)
  ));
  const canProvision = Boolean(form && hostComp && hostComp.paidHostRequired && hostHasKeys);
  const stale = Boolean((freshness && freshness.stale) || (catalogQ.data && catalogQ.data.freshness && catalogQ.data.freshness.stale) || (catalogQ.data && catalogQ.data.refreshEnabled === false));

  return (
    <div data-testid="admin-pipeline-page">
      <TenantContextBar title="Pipeline" subtitle="Estimates are list-price COGS plus suggested retail — not invoices. This hub already takes calls. Spin up is only for an isolated paid cloud stack." />
      <QueryBoundary query={catalogQ} skeleton={<CardSkeleton lines={8} />}>
        {() =>
          form ? (
            <>
              <div className="sticky top-0 z-10 mb-4 rounded-[4px] border border-vl-border bg-white p-4 shadow-sm" data-testid="pipeline-estimate-strip">
                <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
                  <div>
                    <div className="vl-label">Monthly COGS</div>
                    <div className="vl-metric text-[26px]" data-testid="pipeline-monthly-cogs">{estimate ? fmtMoney(estimate.monthlyCogsCents) : "—"}</div>
                  </div>
                  <div>
                    <div className="vl-label">Monthly retail</div>
                    <div className="vl-metric text-[26px]" data-testid="pipeline-monthly-retail">{estimate ? fmtMoney(estimate.monthlyRetailCents) : "—"}</div>
                  </div>
                  <Stat label="COGS / min" value={estimate ? moneyMin(estimate.cogsPerMinuteCents) : "—"} />
                  <Stat label="Retail / min" value={estimate ? moneyMin(estimate.retailPerMinuteCents) : "—"} />
                  <div data-testid="pipeline-latency">
                    <div className="vl-label">Est. reply start</div>
                    <div className="vl-metric text-[26px]">{estimate && estimate.latency ? fmtMs(estimate.latency.firstAudioMs) : "—"}</div>
                  </div>
                </div>
                <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                  <div className="vl-meta">
                    {fmtNumber(form.assumedMonthlyCalls)} calls × {form.avgMinutesPerCall} min = {fmtNumber(form.assumedMonthlyMinutes)} minutes
                    {" · "}Prices as of {fmtDateTime((estimate && estimate.rateCardAsOf) || (catalogQ.data && catalogQ.data.rateCard && catalogQ.data.rateCard.asOf))}
                  </div>
                  <Button variant="outline" size="sm" onClick={refreshPrices} disabled={busy} data-testid="pipeline-refresh-prices"><RefreshCw className="h-3.5 w-3.5" /> Refresh now</Button>
                </div>
                {stale ? (
                  <InlineNote className="mt-3" tone="warning" icon={AlertTriangle} testId="pipeline-stale-banner">
                    {catalogQ.data && catalogQ.data.refreshEnabled === false ? "Price refresh is disabled (air-gap). Showing last committed card." : "One or more price feeds are stale. Totals still use the last good card."}
                  </InlineNote>
                ) : null}
                <div className="mt-3 flex flex-wrap gap-1.5" data-testid="pipeline-source-chips">
                  {Object.entries((freshness && freshness.sources) || (catalogQ.data && catalogQ.data.freshness && catalogQ.data.freshness.sources) || {}).map(([name, s]) => (
                    <Pill key={name} size="sm" tone={s && s.ok && !s.stale ? "success" : "warning"} icon={s && s.ok && !s.stale ? CheckCircle2 : AlertTriangle}>{name}</Pill>
                  ))}
                </div>
              </div>

              <div className="grid gap-4 xl:grid-cols-12">
                <div className="xl:col-span-7 space-y-4" data-testid="pipeline-pickers">
                  <SlotCards
                    title="Host"
                    subtitle="This hub, or a paid cloud stack. Free cloud tiers spin down and cannot take calls."
                    slot="host"
                    families={groupFamilies(slotOptions("host"))}
                    selectedSku={form.hostSku}
                    onSelect={selectSku}
                    required={false}
                  />
                  <SlotCards
                    title="Telco"
                    subtitle="Inbound PSTN is always on."
                    slot="telco"
                    families={groupFamilies(slotOptions("telco"))}
                    selectedSku={form.telcoSku}
                    onSelect={selectSku}
                    required
                  />
                  <SlotCards
                    title="Speech to text"
                    subtitle="Frontier APIs for a GPU-less stack, or on-prem Whisper."
                    slot="stt"
                    families={groupFamilies(slotOptions("stt"))}
                    selectedSku={form.sttSku}
                    onSelect={selectSku}
                  />
                  <SlotCards
                    title="Language model"
                    subtitle="Only models we can call with a public BYOK key. Groq is their cloud API — not a box you host."
                    slot="llm"
                    families={groupFamilies(slotOptions("llm"))}
                    selectedSku={form.llmSku}
                    onSelect={selectSku}
                    wide
                  />
                  <SlotCards
                    title="Voice"
                    subtitle="Cloud TTS, or Kokoro on-prem. Kokoro is the only local engine."
                    slot="tts"
                    families={groupFamilies(slotOptions("tts"))}
                    selectedSku={form.ttsSku}
                    onSelect={selectSku}
                  />

                  <Card>
                    <div className="flex flex-wrap gap-2">
                      <Button onClick={save} disabled={busy} data-testid="pipeline-save"><Save className="h-4 w-4" /> Save draft</Button>
                      <Button variant="outline" onClick={() => apply(false)} disabled={busy} data-testid="pipeline-apply">Apply to receptionist</Button>
                      <Button variant="outline" onClick={() => apply(true)} disabled={busy} data-testid="pipeline-copy-retail">Copy retail to overage</Button>
                    </div>
                    <InlineNote className="mt-3">Fine-tune voice in Receptionist and API keys in Settings. This page composes the stack and the month.</InlineNote>
                  </Card>
                </div>

                <div className="xl:col-span-5 space-y-4 xl:sticky xl:top-4 self-start">
                  <Card testId="pipeline-assumptions">
                    <CardHeader title="Monthly estimator" subtitle="Adjust the shop’s month. Not billed automatically." />
                    <Field label={`Calls per month (${fmtNumber(form.assumedMonthlyCalls)})`}>
                      <Slider value={[form.assumedMonthlyCalls]} min={20} max={5000} step={10} onValueChange={([v]) => setCalls(v)} data-testid="pipeline-calls" />
                    </Field>
                    <Field className="mt-4" label={`Average minutes per call (${form.avgMinutesPerCall})`}>
                      <Slider value={[form.avgMinutesPerCall]} min={0.5} max={20} step={0.5} onValueChange={([v]) => setAvgMinutes(v)} data-testid="pipeline-avg-minutes" />
                    </Field>
                    <Field className="mt-4" label={`Minutes used this month (${fmtNumber(form.assumedMonthlyMinutes)})`}>
                      <Slider value={[form.assumedMonthlyMinutes]} min={50} max={20000} step={25} onValueChange={([v]) => setTotalMinutes(v)} data-testid="pipeline-minutes" />
                    </Field>
                    <Field className="mt-4" label={`Caller talk share (${Math.round(form.callerTalkRatio * 100)}%)`}>
                      <Slider value={[form.callerTalkRatio]} min={0.2} max={0.8} step={0.05} onValueChange={([v]) => patchForm({ callerTalkRatio: v })} data-testid="pipeline-talk-ratio" />
                    </Field>
                    <Field className="mt-4" label={`Retail margin (${Math.round(form.retailMarginBps / 100)}%)`}>
                      <Slider value={[form.retailMarginBps]} min={0} max={10000} step={100} onValueChange={([v]) => patchForm({ retailMarginBps: v })} data-testid="pipeline-margin" />
                    </Field>

                    <div className="mt-5 rounded-[3px] border border-vl-border bg-vl-soft p-3.5">
                      <div className="flex items-end justify-between gap-3">
                        <div>
                          <div className="vl-label">This month at {fmtNumber(form.assumedMonthlyMinutes)} minutes</div>
                          <div className="mt-1 text-[22px] font-semibold tracking-[-0.02em]">{estimate ? fmtMoney(estimate.monthlyCogsCents) : "—"} <span className="text-[13px] font-normal text-vl-secondary">COGS</span></div>
                        </div>
                        <div className="text-right">
                          <div className="vl-label">Suggested retail</div>
                          <div className="mt-1 text-[22px] font-semibold tracking-[-0.02em]">{estimate ? fmtMoney(estimate.monthlyRetailCents) : "—"}</div>
                        </div>
                      </div>
                    </div>

                    {estimate && estimate.latency ? (
                      <div className="mt-4 rounded-[3px] border border-vl-border p-3.5" data-testid="pipeline-latency-card">
                        <div className="flex items-end justify-between gap-3">
                          <div>
                            <div className="vl-label">Typical reply start</div>
                            <div className="mt-1 text-[22px] font-semibold tracking-[-0.02em]">{fmtMs(estimate.latency.firstAudioMs)}</div>
                          </div>
                          <div className="text-right vl-meta">
                            Full reply gen {fmtMs(estimate.latency.fullReplyMs)}
                          </div>
                        </div>
                        <div className="mt-3 flex h-2 overflow-hidden rounded-[2px] bg-vl-soft" aria-hidden="true">
                          {[
                            { key: "stt", v: estimate.latency.sttMs, cls: "bg-vl-gold" },
                            { key: "llm", v: estimate.latency.llmMs, cls: "bg-vl-text" },
                            { key: "tts", v: estimate.latency.ttsMs, cls: "bg-vl-gold-deep" },
                            { key: "path", v: estimate.latency.overheadMs, cls: "bg-vl-border" },
                          ].map((part) => (
                            <div
                              key={part.key}
                              className={part.cls}
                              style={{ width: `${Math.max(4, Math.round((part.v / Math.max(1, estimate.latency.firstAudioMs)) * 100))}%` }}
                            />
                          ))}
                        </div>
                        <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 vl-meta">
                          <span>STT {fmtMs(estimate.latency.sttMs)}</span>
                          <span>LLM {fmtMs(estimate.latency.llmMs)}</span>
                          <span>TTS {fmtMs(estimate.latency.ttsMs)}</span>
                          <span>Path {fmtMs(estimate.latency.overheadMs)}</span>
                        </div>
                        <p className="mt-2 text-[11px] text-vl-secondary">From end of caller speech to first assistant audio. Typical list speeds, not an SLA.</p>
                      </div>
                    ) : null}

                    <div className="mt-4 space-y-2" data-testid="pipeline-line-items">
                      {(estimate && estimate.lineItems || []).map((item) => (
                        <div key={item.slot} className="flex items-center justify-between gap-3 border-b border-vl-border py-1.5 text-[13px]">
                          <span className="min-w-0 truncate">
                            {item.label}
                            {item.stale ? " · stale" : ""}
                            {item.overridden ? " · override" : ""}
                          </span>
                          <span className="shrink-0 text-right">
                            <span className="block">{fmtMoney((item.centsPerMinute || 0) * form.assumedMonthlyMinutes)}/mo</span>
                            <span className="vl-meta">{moneyMin(item.centsPerMinute)}/min</span>
                          </span>
                        </div>
                      ))}
                    </div>

                    <Collapsible open={advancedOpen} onOpenChange={setAdvancedOpen} className="mt-4">
                      <CollapsibleTrigger className="flex items-center gap-1 text-[12px] text-vl-secondary" data-testid="pipeline-advanced-toggle">
                        <ChevronDown className={cn("h-3.5 w-3.5 transition-transform", advancedOpen && "rotate-180")} />
                        Talk-model details
                      </CollapsibleTrigger>
                      <CollapsibleContent className="mt-3 space-y-3">
                        <Field label={`LLM input tokens / min (${form.llmInputTokensPerMin})`}>
                          <Slider value={[form.llmInputTokensPerMin]} min={100} max={8000} step={50} onValueChange={([v]) => patchForm({ llmInputTokensPerMin: v })} data-testid="pipeline-llm-in" />
                        </Field>
                        <Field label={`LLM output tokens / min (${form.llmOutputTokensPerMin})`}>
                          <Slider value={[form.llmOutputTokensPerMin]} min={50} max={4000} step={25} onValueChange={([v]) => patchForm({ llmOutputTokensPerMin: v })} data-testid="pipeline-llm-out" />
                        </Field>
                        <Field label={`TTS characters / min (${form.ttsCharsPerMin})`}>
                          <Slider value={[form.ttsCharsPerMin]} min={100} max={4000} step={50} onValueChange={([v]) => patchForm({ ttsCharsPerMin: v })} data-testid="pipeline-tts-chars" />
                        </Field>
                        <Field label={`Reply tokens / turn (${form.replyTokensPerTurn || 80})`}>
                          <Slider value={[form.replyTokensPerTurn || 80]} min={20} max={400} step={10} onValueChange={([v]) => patchForm({ replyTokensPerTurn: v })} data-testid="pipeline-reply-tokens" />
                        </Field>
                      </CollapsibleContent>
                    </Collapsible>
                  </Card>
                </div>
              </div>

              <Card className="mt-4" testId="pipeline-deployment">
                <CardHeader title="Provision" subtitle={onPremHost ? "This hub is already running. Spin up is only for an isolated paid cloud stack." : "Isolated paid stack only. Ready means health probes passed — skipped inject/health/Telnyx steps are a failure, not a success."} />
                {deployment ? (
                  <div className="space-y-2">
                    <Stat label="Status" value={deployment.status} />
                    <Stat label="Host" value={`${deployment.host || "—"}${deployment.region ? ` · ${deployment.region}` : ""}`} />
                    <Stat label="Last job step" value={(job && job.step) || "—"} />
                    <div data-testid="pipeline-job-steps" className="space-y-1">
                      {((job && job.steps) || []).map((s, i) => (
                        <div key={`${(s && s.step) || i}-${i}`} className="flex items-center justify-between gap-2 border-b border-vl-border py-1 text-[12px]">
                          <span>{(s && s.step) || "—"}</span>
                          <span className={s && s.ok ? "text-vl-secondary" : "text-vl-gold-deep"}>{s && s.ok ? "ok" : "failed"}</span>
                        </div>
                      ))}
                    </div>
                    <Stat label="Control" value={deployment.controlUrl || "—"} />
                    <Stat label="Runtime" value={deployment.runtimeUrl || "—"} />
                    <Stat label="Webhook" value={(deployment.handles && deployment.handles.webhookUrl) || "—"} />
                    <Stat label="Telnyx connection" value={(deployment.handles && deployment.handles.telnyxConnectionId) || "—"} />
                    {deployment.status === "ready" && deployment.controlUrl ? (
                      <a className="text-[13px] text-vl-gold inline-flex items-center gap-1" href={deployment.controlUrl} target="_blank" rel="noreferrer" data-testid="pipeline-open-control">
                        Open control <ExternalLink className="h-3 w-3" />
                      </a>
                    ) : null}
                    {deployment.status === "ready" && deployment.handles && deployment.handles.needsNumber ? (
                      <InlineNote tone="warning" icon={AlertTriangle} testId="pipeline-assign-number">
                        Telnyx connection is ready. Assign a DID to this connection so inbound calls reach {deployment.handles.webhookUrl || "the runtime webhook"}.
                      </InlineNote>
                    ) : null}
                    {deployment.lastError ? <InlineNote tone="warning" icon={AlertTriangle}>{deployment.lastError}</InlineNote> : null}
                    {job && job.errorRedacted ? <InlineNote tone="warning" icon={AlertTriangle}>{job.errorRedacted}</InlineNote> : null}
                    <Button variant="outline" onClick={() => setTeardownOpen(true)} disabled={busy} data-testid="pipeline-teardown"><Trash2 className="h-4 w-4" /> Teardown</Button>
                  </div>
                ) : onPremHost ? (
                  <InlineNote testId="pipeline-onprem-host">This tenant stays on this hub. Pick Render, Railway, or AWS if you need a separate paid stack.</InlineNote>
                ) : (
                  <div className="space-y-3">
                    <InlineNote>Requires a paid host SKU and host API credentials in Settings. Free host plans are blocked.</InlineNote>
                    {!hostHasKeys && hostComp ? <InlineNote tone="warning" icon={AlertTriangle} testId="pipeline-missing-host-keys">Missing {hostComp.hostProvider} credentials. Add them in Settings before provisioning.</InlineNote> : null}
                    <Button onClick={provision} disabled={busy || !canProvision} data-testid="pipeline-provision"><Rocket className="h-4 w-4" /> Spin up</Button>
                  </div>
                )}
                <div className="mt-3 flex gap-3 text-[13px]">
                  <Link className="text-vl-gold" to="/admin/receptionist?tab=voice">Voice editor</Link>
                  <Link className="text-vl-gold" to="/admin/settings">LLM & host credentials</Link>
                  <Link className="text-vl-gold" to="/admin/billing">Billing</Link>
                </div>
              </Card>
              <ConfirmDialog open={teardownOpen} onOpenChange={setTeardownOpen} title="Tear down this stack?" description="Deletes the isolated host resources for this tenant." confirmLabel="Teardown" destructive onConfirm={async () => {
                if (!deployment) return;
                setBusy(true);
                try {
                  await api.del(`/api/admin/tenants/${tenantId}/deployments/${deployment.id}`);
                  toast.success("Teardown requested");
                  qc.invalidateQueries({ queryKey: ["admin", "pipeline", tenantId] });
                  setTeardownOpen(false);
                } catch (e) {
                  toast.error("Teardown failed", { description: errorMessage(e) });
                } finally {
                  setBusy(false);
                }
              }} />
            </>
          ) : (
            <CardSkeleton lines={6} />
          )
        }
      </QueryBoundary>
    </div>
  );
};

const SlotCards = ({ title, subtitle, slot, families, selectedSku, onSelect, required, wide }) => (
  <Card testId={`pipeline-${slot}`}>
    <CardHeader title={title} subtitle={subtitle} />
    <div className={cn("grid gap-3", wide ? "grid-cols-1 sm:grid-cols-2" : "sm:grid-cols-2")} role="radiogroup" aria-label={title} data-testid={`pipeline-${slot}-cards`}>
      {families.map((family) => {
        const selected = family.skus.some((s) => s.sku === selectedSku);
        const Icon = family.meta.icon || Server;
        return (
          <button
            key={family.id}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => onSelect(slot, selected ? selectedSku : family.skus[0].sku)}
            className={cn("rounded-[4px] border bg-white p-4 text-left transition-colors", selected ? "border-vl-gold shadow-[inset_0_0_0_1px_var(--vl-gold)]" : "border-vl-border hover:bg-vl-soft")}
            data-testid={`pipeline-${slot}-${family.id}`}
          >
            <div className="flex items-start justify-between gap-2">
              <div className="flex items-center gap-2 min-w-0">
                <Icon className={cn("h-4 w-4 shrink-0", selected ? "text-vl-gold-deep" : "text-vl-secondary")} aria-hidden="true" />
                <div className="text-[14px] font-medium truncate">{family.meta.name}</div>
              </div>
              {required ? <Pill size="sm" tone="gold">Required</Pill> : selected ? <Pill size="sm" tone="gold" icon={CheckCircle2}>Selected</Pill> : null}
            </div>
            <p className="mt-1.5 text-[12px] text-vl-secondary leading-snug">{family.meta.hint}</p>
            {family.skus.length > 1 || family.skus.some((s) => s.shortLabel) ? (
              <div className="mt-3 flex flex-wrap gap-1.5" onClick={(e) => e.stopPropagation()}>
                {family.skus.map((sku) => (
                  <button
                    key={sku.sku}
                    type="button"
                    onClick={() => onSelect(slot, sku.sku)}
                    className={cn("rounded-[2px] border px-2 py-1 font-mono text-[10px] uppercase tracking-[0.04em]", sku.sku === selectedSku ? "border-vl-text bg-vl-text text-white" : "border-vl-border bg-vl-soft text-vl-secondary hover:text-vl-text")}
                    data-testid={`pipeline-sku-${sku.sku}`}
                  >
                    {sku.shortLabel || skuChipLabel(sku.label, family.meta.name)}
                  </button>
                ))}
              </div>
            ) : (
              <div className="mt-2 vl-meta">{family.skus[0].label}</div>
            )}
          </button>
        );
      })}
    </div>
  </Card>
);
