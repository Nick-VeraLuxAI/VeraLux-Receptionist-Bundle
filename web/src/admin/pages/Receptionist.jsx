import React from "react";
import { useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Sparkles, Mic2, Clock, PhoneForwarded, Tag, MessageCircle, Braces, UploadCloud, AlertTriangle } from "lucide-react";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardHeader, InlineNote } from "@/components/vl/Cards";
import { PublishBar } from "@/components/vl/PublishBar";
import { QueryBoundary, CardSkeleton } from "@/components/vl/States";
import { ConfirmDialog } from "@/components/vl/ConfirmDialog";
import { PromptsEditor } from "@/components/vl/editors/PromptsEditor";
import { VoiceEditor } from "@/components/vl/editors/VoiceEditor";
import { HoursEditor } from "@/components/vl/editors/HoursEditor";
import { ForwardingEditor } from "@/components/vl/editors/ForwardingEditor";
import { PricingEditor } from "@/components/vl/editors/PricingEditor";
import { QuickRepliesEditor } from "@/components/vl/editors/QuickRepliesEditor";
import { useAdmin } from "../AdminApp";
import { TenantContextBar, NoTenant } from "../AdminShell";
import { errorMessage } from "@/lib/api";
import { fmtDateTime } from "@/lib/format";

const TABS = [
  { id: "prompts", label: "Prompts", icon: Sparkles },
  { id: "voice", label: "Voice", icon: Mic2 },
  { id: "hours", label: "Hours", icon: Clock },
  { id: "forwarding", label: "Transfer lines", icon: PhoneForwarded },
  { id: "pricing", label: "Services", icon: Tag },
  { id: "quick-replies", label: "Quick replies", icon: MessageCircle },
  { id: "advanced", label: "Advanced", icon: Braces },
];

export default function Receptionist() {
  const { api, tenantId, sync, markSaved, markPublished } = useAdmin();
  const [params, setParams] = useSearchParams();
  const tab = TABS.some((t) => t.id === params.get("tab")) ? params.get("tab") : "prompts";
  const qc = useQueryClient();
  const onSaved = (res) => {
    markSaved(res);
    qc.invalidateQueries({ queryKey: ["admin", "runtime-config", tenantId] });
  };
  if (!tenantId) return <NoTenant />;
  return (
    <div data-testid="admin-receptionist-page">
      <TenantContextBar title="Receptionist setup" subtitle="Everything the receptionist knows and how it speaks. Config saves auto-publish when the runtime has been published before." />
      <PublishBar api={api} tenantId={tenantId} sync={sync} onPublished={markPublished} className="mb-4" label="Publish to runtime" />
      <Tabs value={tab} onValueChange={(t) => setParams({ tab: t })}>
        <TabsList className="mb-4 h-auto flex-wrap justify-start rounded-[4px] bg-vl-warm p-1" data-testid="admin-receptionist-tabs">
          {TABS.map((t) => (
            <TabsTrigger key={t.id} value={t.id} className="rounded-lg px-3 py-1.5 text-[13px] data-[state=active]:bg-white data-[state=active]:border data-[state=active]:border-vl-border" data-testid={`admin-receptionist-tab-${t.id}`}>
              <t.icon className="h-3.5 w-3.5 mr-1.5" aria-hidden="true" /> {t.label}
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContent value="prompts">
          <Card>
            <CardHeader title="Prompts" subtitle="greetingText · systemPreamble · policyPrompt · voicePrompt · schemaHint" />
            <PromptsEditor api={api} mode="admin" tenantId={tenantId} onSaved={onSaved} />
          </Card>
        </TabsContent>
        <TabsContent value="voice">
          <Card>
            <CardHeader title="Voice & TTS" subtitle="Provider endpoint fields appear only for superadmins." />
            <VoiceEditor api={api} mode="admin" tenantId={tenantId} onSaved={onSaved} />
          </Card>
        </TabsContent>
        <TabsContent value="hours">
          <Card>
            <CardHeader title="Business hours" />
            <HoursEditor api={api} mode="admin" tenantId={tenantId} onSaved={onSaved} />
          </Card>
        </TabsContent>
        <TabsContent value="forwarding">
          <Card>
            <CardHeader title="Transfer lines (forwarding profiles)" subtitle="Requires multiLocation. Locked state below means the plan does not include it." />
            <ForwardingEditor api={api} mode="admin" tenantId={tenantId} onSaved={onSaved} upgradeHref="/admin/plans" />
          </Card>
        </TabsContent>
        <TabsContent value="pricing">
          <Card>
            <CardHeader title="Services & pricing" subtitle="Requires crmIntegration." />
            <PricingEditor api={api} mode="admin" tenantId={tenantId} onSaved={onSaved} upgradeHref="/admin/plans" />
          </Card>
        </TabsContent>
        <TabsContent value="quick-replies">
          <Card>
            <CardHeader title="Quick replies" subtitle="Stored in the runtime config; PUT publishes immediately." />
            <QuickRepliesEditor api={api} mode="admin" tenantId={tenantId} onSaved={onSaved} onPublished={markPublished} />
          </Card>
        </TabsContent>
        <TabsContent value="advanced">
          <RuntimeConfig api={api} tenantId={tenantId} onPublished={markPublished} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

const RuntimeConfig = ({ api, tenantId, onPublished }) => {
  const q = useQuery({ queryKey: ["admin", "runtime-config", tenantId], queryFn: () => api.get(`/api/admin/runtime/tenants/${tenantId}/config`) });
  const [draft, setDraft] = React.useState(null);
  const [confirm, setConfirm] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  return (
    <Card testId="runtime-config-card">
      <CardHeader title="Raw runtime config (advanced)" subtitle="Exactly what the voice runtime reads. Prefer the tabs above; use this for diagnostics or emergency fixes." icon={Braces} />
      <QueryBoundary query={q} skeleton={<CardSkeleton lines={8} />}>
        {(d) => {
          const current = d.runtimeConfigMissing ? d.preview : d.config;
          const text = draft !== null ? draft : JSON.stringify(current, null, 2);
          return (
            <div className="space-y-3">
              {d.runtimeConfigMissing ? (
                <InlineNote tone="warning" icon={AlertTriangle} testId="runtime-missing-note">
                  This tenant has never been published. Showing the config that <em>would</em> be published from the tenant record.
                </InlineNote>
              ) : (
                <div className="vl-meta">Published {fmtDateTime(d.publishedAt)} · version {d.version}</div>
              )}
              <Textarea value={text} onChange={(e) => setDraft(e.target.value)} rows={22} className="font-mono text-[12px] bg-vl-soft" spellCheck={false} data-testid="runtime-config-editor" />
              <div className="flex flex-wrap items-center gap-2">
                <Button variant="outline" onClick={() => setDraft(null)} disabled={draft === null}>
                  Discard edits
                </Button>
                <Button variant="outline" onClick={() => { try { setDraft(JSON.stringify(JSON.parse(text), null, 2)); } catch (e) { toast.error("Invalid JSON"); } }}>
                  Format JSON
                </Button>
                <div className="ml-auto">
                  <Button onClick={() => { try { JSON.parse(text); setConfirm(true); } catch (e) { toast.error("Config is not valid JSON"); } }} disabled={draft === null} data-testid="runtime-config-publish-button">
                    <UploadCloud className="h-4 w-4" /> Publish raw config
                  </Button>
                </div>
              </div>
              <ConfirmDialog open={confirm} onOpenChange={setConfirm} title="Publish raw runtime config?" description="This bypasses the tenant record and writes directly to the runtime. The next publish-from-tenant will overwrite it." confirmLabel="Publish now" destructive loading={busy} onConfirm={async () => { setBusy(true); try { const r = await api.post(`/api/admin/runtime/tenants/${tenantId}/config`, { config: JSON.parse(text) }); toast.success("Raw config published"); setConfirm(false); setDraft(null); onPublished(r); q.refetch(); } catch (e) { toast.error("Publish failed", { description: errorMessage(e) }); onPublished(null, e); } finally { setBusy(false); } }} />
            </div>
          );
        }}
      </QueryBoundary>
    </Card>
  );
};
