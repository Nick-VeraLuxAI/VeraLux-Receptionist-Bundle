import React from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Bot, Sparkles, Mic2, Clock, MessageCircle, ArrowRight, Scissors, PhoneForwarded, Play, Square, Loader2 } from "lucide-react";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { PageHeader, Card, CardHeader, Stat } from "@/components/vl/Cards";
import { Pill, SyncPill, OnlinePill, Dot } from "@/components/vl/Pills";
import { VoiceMark } from "@/components/vl/Logo";
import { PublishBar } from "@/components/vl/PublishBar";
import { CardSkeleton } from "@/components/vl/States";
import { PromptsEditor } from "@/components/vl/editors/PromptsEditor";
import { VoiceEditor, useVoicePreview } from "@/components/vl/editors/VoiceEditor";
import { HoursEditor } from "@/components/vl/editors/HoursEditor";
import { QuickRepliesEditor } from "@/components/vl/editors/QuickRepliesEditor";
import { usePortal } from "../PortalApp";
import { fmtDateTime, titleCase } from "@/lib/format";

const TABS = [
  { id: "overview", label: "Overview", icon: Bot },
  { id: "personality", label: "Personality", icon: Sparkles },
  { id: "voice", label: "Voice", icon: Mic2 },
  { id: "hours", label: "Business Hours", icon: Clock },
  { id: "quick-replies", label: "Quick Replies", icon: MessageCircle },
];

export default function Receptionist() {
  const { api, tenantId, sync, markSaved, markPublished, has } = usePortal();
  const [params, setParams] = useSearchParams();
  const tab = TABS.some((t) => t.id === params.get("tab")) ? params.get("tab") : "overview";
  const setTab = (t) => setParams({ tab: t });
  const qc = useQueryClient();
  const promptsQ = useQuery({ queryKey: ["portal", "prompts", tenantId], queryFn: () => api.get("/api/admin/prompts") });
  const playbookQ = useQuery({ queryKey: ["portal", "shop-playbook", tenantId], queryFn: () => api.get("/api/admin/shop-playbook") });
  const hoursReadOnly = playbookQ.data ? !playbookQ.data.ownerCanEdit : true;

  const onSaved = (res) => {
    markSaved(res);
    qc.invalidateQueries({ queryKey: ["portal", "prompts", tenantId] });
    qc.invalidateQueries({ queryKey: ["portal", "tts", tenantId] });
    qc.invalidateQueries({ queryKey: ["portal", "hours", tenantId] });
  };

  return (
    <div data-testid="portal-receptionist-page">
      <PageHeader eyebrow="My receptionist" title="Receptionist Studio" subtitle="Shape how your receptionist greets, speaks and answers. Publish when you're happy." actions={<PublishBar compact api={api} tenantId={tenantId} sync={sync} onPublished={markPublished} />} />
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="mb-5 h-auto flex-wrap justify-start rounded-full bg-vl-warm p-1" data-testid="receptionist-tabs">
          {TABS.map((t) => (
            <TabsTrigger key={t.id} value={t.id} className="rounded-full px-4 py-2 text-[13px] data-[state=active]:bg-white data-[state=active]:border data-[state=active]:border-vl-border data-[state=active]:shadow-xs" data-testid={`receptionist-tab-${t.id}`}>
              <t.icon className="h-3.5 w-3.5 mr-1.5" aria-hidden="true" /> {t.label}
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContent value="overview">
          <StudioOverview onGo={setTab} greeting={promptsQ.data && promptsQ.data.greetingText} />
        </TabsContent>
        <TabsContent value="personality">
          <Card>
            <CardHeader title="Personality" subtitle="Written in plain language — your receptionist follows it on every call." />
            <PromptsEditor api={api} mode="portal" tenantId={tenantId} onSaved={onSaved} />
          </Card>
        </TabsContent>
        <TabsContent value="voice">
          <Card>
            <CardHeader title="Voice" subtitle="How your receptionist sounds." />
            <VoiceEditor api={api} mode="portal" tenantId={tenantId} onSaved={onSaved} greeting={promptsQ.data && promptsQ.data.greetingText} />
          </Card>
        </TabsContent>
        <TabsContent value="hours">
          <Card>
            <CardHeader title="Business hours" subtitle="Your receptionist answers differently when you're closed." />
            <HoursEditor api={api} mode="portal" tenantId={tenantId} onSaved={onSaved} readOnly={hoursReadOnly} />
          </Card>
        </TabsContent>
        <TabsContent value="quick-replies">
          <Card>
            <CardHeader title="Quick replies" subtitle="Instant answers to your most common questions." />
            <QuickRepliesEditor api={api} mode="portal" tenantId={tenantId} onSaved={markSaved} onPublished={markPublished} />
          </Card>
        </TabsContent>
      </Tabs>
      {has("crmIntegration") || has("multiLocation") ? (
        <div className="mt-5 grid gap-3 sm:grid-cols-2">
          {has("crmIntegration") ? <Shortcut to="/portal/services" icon={Scissors} title="Services & prices" sub="What your receptionist can quote" /> : null}
          {has("multiLocation") ? <Shortcut to="/portal/transfer-lines" icon={PhoneForwarded} title="Transfer lines" sub="Who callers can be handed to" /> : null}
        </div>
      ) : null}
    </div>
  );
}

const Shortcut = ({ to, icon: Icon, title, sub }) => (
  <Link to={to} className="vl-card p-4 flex items-center gap-3 hover:border-vl-border-strong transition-colors" data-testid="studio-shortcut">
    <span className="vl-icon-circle !h-10 !w-10">
      <Icon className="h-4 w-4" aria-hidden="true" />
    </span>
    <div className="min-w-0 flex-1">
      <div className="text-[14px] font-medium">{title}</div>
      <div className="vl-meta">{sub}</div>
    </div>
    <ArrowRight className="h-4 w-4 text-vl-muted" aria-hidden="true" />
  </Link>
);

const StudioOverview = ({ onGo, greeting }) => {
  const { api, tenantId, sync, healthOk, healthLoading, health } = usePortal();
  const ttsQ = useQuery({ queryKey: ["portal", "tts", tenantId], queryFn: () => api.get("/api/tts/config") });
  const hoursQ = useQuery({ queryKey: ["portal", "hours", tenantId], queryFn: () => api.get("/api/owner/business-hours") });
  const qrQ = useQuery({ queryKey: ["portal", "quick-replies", tenantId], queryFn: () => api.get(`/api/admin/runtime/tenants/${tenantId}/quick-replies`) });
  const preview = useVoicePreview(api);
  const tts = ttsQ.data;
  const hrs = hoursQ.data;
  if (ttsQ.isPending || hoursQ.isPending) return <CardSkeleton lines={6} />;
  const name = tts ? (tts.defaultVoiceMode === "cloned" && tts.clonedVoice ? tts.clonedVoice.label : tts.voiceLabel) || "Your receptionist" : "Your receptionist";
  return (
    <div className="grid gap-4 lg:grid-cols-12" data-testid="studio-overview">
      <Card className="lg:col-span-7">
        <div className="flex items-center gap-4">
          <VoiceMark size={72} animate={preview.state === "playing"} />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-3 flex-wrap">
              <div className="vl-serif text-[30px] leading-none">{name}</div>
              {!healthLoading ? <OnlinePill ok={healthOk} label={healthOk ? "Online" : health ? "Degraded" : "Unreachable"} size="sm" /> : null}
            </div>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {tts && tts.preset ? <Pill size="sm">{titleCase(tts.preset)} tone</Pill> : null}
              {tts ? <Pill size="sm">{tts.defaultVoiceMode === "cloned" ? "Cloned voice" : "Preset voice"}</Pill> : null}
              {tts && tts.language ? <Pill size="sm">{tts.language}</Pill> : null}
              {tts && tts.rate ? <Pill size="sm">{Number(tts.rate).toFixed(2)}x speed</Pill> : null}
            </div>
          </div>
          {preview.state === "playing" ? (
            <Button variant="outline" onClick={preview.stop} data-testid="studio-hear-voice">
              <Square className="h-4 w-4" /> Stop
            </Button>
          ) : (
            <Button variant="outline" onClick={() => preview.play()} disabled={preview.state === "pending"} data-testid="studio-hear-voice">
              {preview.state === "pending" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />} Hear voice
            </Button>
          )}
        </div>
        <div className="mt-5 vl-card-soft p-4">
          <div className="vl-eyebrow-dark mb-1.5">Greeting</div>
          <p className="text-[15px] italic text-vl-secondary">{greeting ? `“${greeting}”` : "No greeting set yet."}</p>
        </div>
        <div className="mt-5 grid grid-cols-2 sm:grid-cols-3 gap-4">
          <div>
            <div className="vl-label">Business hours</div>
            <div className="mt-1 flex items-center gap-2 text-[14px] font-medium">
              <Dot tone={hrs && hrs.openNow ? "success" : "neutral"} /> {hrs ? (hrs.openNow ? "Open now" : "Closed now") : "—"}
            </div>
            <div className="vl-meta">{hrs && hrs.summary ? hrs.summary.text : ""}</div>
          </div>
          <div>
            <div className="vl-label">Publish state</div>
            <div className="mt-1">
              <SyncPill sync={sync} size="sm" />
            </div>
            <div className="vl-meta">{sync.lastPublishedAt ? fmtDateTime(sync.lastPublishedAt) : "Never published"}</div>
          </div>
          <Stat label="Quick replies" value={qrQ.data ? (qrQ.data.runtimeConfigMissing ? "Not published" : `${(qrQ.data.quickReplies || []).length} active`) : "…"} />
        </div>
      </Card>
      <div className="lg:col-span-5 grid gap-3">
        {TABS.slice(1).map((t) => (
          <button key={t.id} onClick={() => onGo(t.id)} className="vl-card p-4 flex items-center gap-3 text-left hover:border-vl-border-strong transition-colors" data-testid={`studio-go-${t.id}`}>
            <span className="vl-icon-circle !h-10 !w-10">
              <t.icon className="h-4 w-4" aria-hidden="true" />
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-[14px] font-medium">{t.label}</div>
              <div className="vl-meta">{{ personality: "Greeting, style, rules and voice direction", voice: "Voice, tone preset, language and speed", hours: "Weekly schedule and after-hours message", "quick-replies": "Instant answers for common questions" }[t.id]}</div>
            </div>
            <ArrowRight className="h-4 w-4 text-vl-muted" aria-hidden="true" />
          </button>
        ))}
      </div>
    </div>
  );
};
