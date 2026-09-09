import React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Plus, Trash2, Pencil, FlaskConical, Lock, Zap, ArrowRight, History, CheckCircle2, AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Card, CardHeader, Field, InlineNote } from "@/components/vl/Cards";
import { Pill } from "@/components/vl/Pills";
import { QueryBoundary, CardSkeleton, EmptyState } from "@/components/vl/States";
import { ConfirmDialog } from "@/components/vl/ConfirmDialog";
import { errorMessage } from "@/lib/api";
import { titleCase, fmtRelative, fmtDateTime } from "@/lib/format";
import {
  mergeWorkflowListPayload,
  workflowToUi,
  workflowWriteBody,
  fromWorkflowRuns,
  fromWorkflowTest,
  REAL_WORKFLOW_TRIGGERS,
  REAL_WORKFLOW_ACTIONS,
} from "@/lib/controlPlaneAdapters";
import { WorkflowGallery, TRIGGER_LABELS, STEP_LABELS } from "./WorkflowGallery";

const describeStep = (s) => {
  const type = s.type || s.action;
  switch (type) {
    case "send_sms":
      return `Text ${s.to === "caller" ? "the caller" : s.to || "a number"}: “${s.template || s.config?.message || "…"}”`;
    case "send_email":
      return `Email ${s.to || "owner"}: “${s.template || s.config?.subject || "…"}”`;
    case "store_lead":
      return `Store lead${s.tag || s.config?.tag ? ` tagged “${s.tag || s.config?.tag}”` : ""}`;
    case "fire_webhook":
    case "book_calendar":
      return `${type === "book_calendar" ? "Book via" : "Send to"} ${s.url || s.config?.url || "webhook URL"}`;
    case "ai_summarize":
      return "Summarize the call with AI";
    case "ai_extract":
      return "Extract structured fields with AI";
    case "page_on_call":
      return "Page the on-call rotation";
    case "send_digest":
      return "Send the morning digest";
    case "create_approval":
      return "Create an Approvals / Inbox item";
    case "write_fsm_job":
      return `Write a ${s.provider || s.config?.provider || "board"} job`;
    case "escalate_orphan":
      return "Escalate unanswered page and mark orphan";
    case "hold_booking":
      return "Hold the book and queue a callback";
    case "estimate_followup":
      return "Follow up on held estimates after 24h";
    case "noshow_alert":
      return "Alert the owner after a no-show window";
    default:
      return STEP_LABELS[type] || JSON.stringify(s);
  }
};

export const WorkflowsPanel = ({ api, mode, tenantId, upgradeHref }) => {
  const q = useQuery({
    queryKey: [mode, "workflows", tenantId],
    enabled: !!tenantId,
    queryFn: async () => {
      const workflowsRes = await api.get("/api/admin/workflows");
      let settingsRes = { ownerCanEdit: false };
      try {
        settingsRes = await api.get("/api/admin/workflows/settings");
      } catch (e) {
        /* settings may 403 when customWorkflows is off; list already gated */
      }
      return mergeWorkflowListPayload(workflowsRes, settingsRes);
    },
  });
  return (
    <QueryBoundary query={q} skeleton={<CardSkeleton lines={6} />} upgradeHref={upgradeHref}>
      {(data) => <WorkflowsList data={data} api={api} mode={mode} tenantId={tenantId} refetch={q.refetch} />}
    </QueryBoundary>
  );
};

const WorkflowsList = ({ data, api, mode, tenantId, refetch }) => {
  const qc = useQueryClient();
  const isAdmin = mode === "admin";
  const ownerCanEdit = !!(data.settings && data.settings.ownerCanEdit);
  const canEdit = isAdmin || ownerCanEdit;
  const [editing, setEditing] = React.useState(null); // null | {} (new) | workflow
  const [galleryOpen, setGalleryOpen] = React.useState(false);
  const [testing, setTesting] = React.useState(null);
  const [deleting, setDeleting] = React.useState(null);
  const [busy, setBusy] = React.useState(false);
  const [enablingId, setEnablingId] = React.useState(null);
  const templatesQ = useQuery({
    queryKey: [mode, "workflow-templates", tenantId],
    queryFn: () => api.get("/api/admin/workflow-templates"),
    enabled: !!tenantId,
  });
  const runsQ = useQuery({
    queryKey: [mode, "workflow-runs", tenantId],
    queryFn: async () => fromWorkflowRuns(await api.get("/api/admin/workflow-runs?today=1&limit=50")),
    enabled: !!tenantId,
  });

  const refreshAll = () => {
    refetch();
    qc.invalidateQueries({ queryKey: [mode, "workflow-runs", tenantId] });
    qc.invalidateQueries({ queryKey: [mode, "workflow-templates", tenantId] });
  };

  const enableTemplate = async (tpl, config = {}) => {
    setEnablingId(tpl.id);
    try {
      await api.post("/api/admin/workflows/from-template", {
        templateId: tpl.id,
        enabled: true,
        config,
      });
      toast.success(`${tpl.name} enabled`);
      setGalleryOpen(false);
      refreshAll();
    } catch (e) {
      toast.error("Couldn't enable template", { description: errorMessage(e) });
    } finally {
      setEnablingId(null);
    }
  };

  const toggle = async (wf, enabled) => {
    try {
      await api.put(`/api/admin/workflows/${wf.id}`, { enabled });
      toast.success(enabled ? "Workflow turned on" : "Workflow turned off");
      refetch();
    } catch (e) {
      toast.error("Couldn't update workflow", { description: errorMessage(e) });
    }
  };
  const remove = async () => {
    setBusy(true);
    try {
      await api.del(`/api/admin/workflows/${deleting.id}`);
      toast.success("Workflow deleted");
      setDeleting(null);
      refreshAll();
    } catch (e) {
      toast.error("Couldn't delete", { description: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };
  const setOwnerCanEdit = async (v) => {
    try {
      await api.patch("/api/admin/workflows/settings", { ownerCanEdit: v });
      toast.success(v ? "Owner can now edit workflows" : "Owner editing disabled");
      refetch();
    } catch (e) {
      toast.error("Couldn't update setting", { description: errorMessage(e) });
    }
  };

  const workflows = data.workflows || [];
  return (
    <div className="space-y-5" data-testid="workflows-panel">
      <div className="flex flex-wrap items-center gap-3">
        {isAdmin ? (
          <label className="inline-flex items-center gap-2 text-[13px]">
            <Switch checked={ownerCanEdit} onCheckedChange={setOwnerCanEdit} data-testid="owner-can-edit-switch" aria-label="Owner can edit workflows" /> Owner can edit workflows
          </label>
        ) : !ownerCanEdit ? (
          <InlineNote icon={Lock} className="flex-1">
            Workflows are managed by VeraLux for your account. You can review them and run tests, but edits go through your VeraLux contact.
          </InlineNote>
        ) : null}
        <div className="ml-auto">
          <Button onClick={() => setGalleryOpen(true)} data-testid="workflow-create-button">
            <Plus className="h-4 w-4" /> New workflow
          </Button>
        </div>
      </div>

      {workflows.length === 0 ? (
        <EmptyState icon={Zap} title="No workflows yet" description="Workflows run automatically after calls — like texting a caller you missed or alerting you about a hot lead." action={<Button onClick={() => setGalleryOpen(true)}>Browse templates</Button>} />
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {workflows.map((wf) => {
            const locked = !isAdmin && wf.adminLocked;
            return (
              <Card key={wf.id} testId="workflow-card" className="flex flex-col">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <h3 className="text-[15px] font-semibold truncate">{wf.name}</h3>
                      {wf.adminLocked ? (
                        <Pill tone="neutral" icon={Lock} size="sm">
                          Managed by VeraLux
                        </Pill>
                      ) : null}
                      {wf.templateId ? (
                        <Pill tone="gold" size="sm">
                          Template
                        </Pill>
                      ) : null}
                    </div>
                    <div className="vl-meta mt-0.5">Updated {fmtRelative(wf.updatedAt)}</div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Pill tone={wf.enabled ? "success" : "neutral"} icon={wf.enabled ? CheckCircle2 : AlertCircle} size="sm" testId="workflow-enabled-pill">
                      {wf.enabled ? "On" : "Off"}
                    </Pill>
                    <Switch checked={!!wf.enabled} disabled={!canEdit || locked} onCheckedChange={(v) => toggle(wf, v)} aria-label={`Toggle ${wf.name}`} data-testid="workflow-toggle" />
                  </div>
                </div>

                <div className="mt-4 vl-card-soft p-3.5 space-y-2.5">
                  <div className="flex items-center gap-2 text-[13px]">
                    <span className="vl-icon-circle !h-7 !w-7">
                      <Zap className="h-3.5 w-3.5" aria-hidden="true" />
                    </span>
                    <span className="font-medium">{TRIGGER_LABELS[wf.triggerType] || titleCase(wf.triggerType)}</span>
                    {wf.triggerConfig && Object.keys(wf.triggerConfig).length ? (
                      <span className="vl-meta truncate">
                        {Object.entries(wf.triggerConfig)
                          .map(([k, v]) => `${titleCase(k)}: ${Array.isArray(v) ? v.join(", ") : String(v)}`)
                          .join(" · ")}
                      </span>
                    ) : null}
                  </div>
                  <ol className="space-y-1.5 pl-1">
                    {(wf.steps || []).map((s, i) => (
                      <li key={i} className="flex items-start gap-2 text-[13px] text-vl-secondary">
                        <ArrowRight className="h-3.5 w-3.5 mt-0.5 text-vl-gold shrink-0" aria-hidden="true" />
                        <span>
                          <span className="font-medium text-vl-text">{STEP_LABELS[s.type] || titleCase(s.type)}</span> — {describeStep(s)}
                        </span>
                      </li>
                    ))}
                    {(wf.steps || []).length === 0 ? <li className="vl-meta">No steps yet</li> : null}
                  </ol>
                </div>

                <div className="mt-4 flex flex-wrap items-center gap-2">
                  <Button size="sm" variant="outline" onClick={() => setTesting(wf)} data-testid="workflow-test-button">
                    <FlaskConical className="h-4 w-4" /> Test run
                  </Button>
                  {canEdit && !locked ? (
                    <>
                      <Button size="sm" variant="outline" onClick={() => setEditing(workflowToUi(wf))} data-testid="workflow-edit-button">
                        <Pencil className="h-4 w-4" /> Edit
                      </Button>
                      <Button size="sm" variant="ghost" className="text-vl-danger hover:text-vl-danger" onClick={() => setDeleting(wf)} data-testid="workflow-delete-button">
                        <Trash2 className="h-4 w-4" /> Delete
                      </Button>
                    </>
                  ) : null}
                </div>
              </Card>
            );
          })}
        </div>
      )}

      <Card testId="workflow-runs">
        <CardHeader title="Recent runs" subtitle="Today" icon={History} />
        <QueryBoundary query={runsQ} compact emptyWhen={(d) => !(d.runs || []).length} empty={<EmptyState compact icon={History} title="No runs yet" description="Runs appear here once a workflow is triggered by a call." />}>
          {(d) => (
            <div className="overflow-x-auto vl-scroll">
              <table className="w-full text-[13px] vl-table">
                <thead>
                  <tr className="text-left border-b border-vl-border">
                    <th className="py-2 pr-3">Workflow</th>
                    <th className="py-2 pr-3">Trigger</th>
                    <th className="py-2 pr-3">Result</th>
                    <th className="py-2 pr-3">When</th>
                  </tr>
                </thead>
                <tbody>
                  {d.runs.map((r) => (
                    <tr key={r.id} className="border-b border-vl-border last:border-0 vl-row" data-testid="workflow-run-row">
                      <td className="py-2 pr-3 font-medium">{r.workflowName}</td>
                      <td className="py-2 pr-3 text-vl-secondary">{TRIGGER_LABELS[r.trigger] || titleCase(r.trigger)}</td>
                      <td className="py-2 pr-3">
                        <Pill size="sm" tone={r.status === "succeeded" ? "success" : r.status === "failed" ? "danger" : "neutral"} icon={r.status === "succeeded" ? CheckCircle2 : r.status === "failed" ? AlertCircle : FlaskConical}>
                          {r.status === "dry_run" ? "Test only" : titleCase(r.status)}
                        </Pill>
                        {r.status === "failed" ? <span className="ml-2 vl-meta">{(r.stepResults || []).find((s) => s.status === "failed")?.detail}</span> : null}
                      </td>
                      <td className="py-2 pr-3 text-vl-muted whitespace-nowrap">{fmtRelative(r.startedAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </QueryBoundary>
      </Card>

      <WorkflowGallery
        open={galleryOpen}
        templates={(templatesQ.data && templatesQ.data.templates) || []}
        installed={(templatesQ.data && templatesQ.data.installed) || {}}
        canEdit={canEdit}
        enablingId={enablingId}
        loading={templatesQ.isPending}
        onClose={() => setGalleryOpen(false)}
        onEnable={enableTemplate}
        onScratch={() => {
          setGalleryOpen(false);
          setEditing({});
        }}
      />
      {editing !== null ? <WorkflowSheet api={api} isAdmin={isAdmin} workflow={editing} triggerTypes={data.triggerTypes || Object.keys(TRIGGER_LABELS)} stepTypes={data.stepTypes || Object.keys(STEP_LABELS)} onClose={() => setEditing(null)} onSaved={refreshAll} /> : null}
      {testing ? <TestDialog api={api} workflow={testing} onClose={() => setTesting(null)} onRan={refreshAll} /> : null}
      <ConfirmDialog open={!!deleting} onOpenChange={(o) => !o && setDeleting(null)} title={`Delete “${deleting?.name}”?`} description="This workflow will stop running immediately. This cannot be undone." confirmLabel="Delete workflow" destructive onConfirm={remove} loading={busy} />
    </div>
  );
};

const emptyStep = (type) => ({
  type,
  action: type,
  ...(type === "send_sms" || type === "send_email"
    ? { to: type === "send_email" ? "owner" : "caller", template: "" }
    : type === "store_lead"
      ? { tag: "" }
      : type === "fire_webhook"
        ? { url: "" }
        : {}),
});

const WorkflowSheet = ({ api, isAdmin, workflow, triggerTypes, stepTypes, onClose, onSaved }) => {
  const isNew = !workflow.id;
  const [form, setForm] = React.useState({
    name: workflow.name || "",
    triggerType: workflow.triggerType || triggerTypes[0] || REAL_WORKFLOW_TRIGGERS[0],
    triggerConfig: JSON.stringify(workflow.triggerConfig || {}, null, 2),
    steps: (workflow.steps || []).map((s) => ({ ...s })),
    enabled: workflow.enabled ?? true,
    adminLocked: workflow.adminLocked ?? false,
  });
  const [saving, setSaving] = React.useState(false);
  const setStep = (i, patch) => setForm((f) => ({ ...f, steps: f.steps.map((s, idx) => (idx === i ? { ...s, ...patch } : s)) }));

  const save = async () => {
    let triggerConfig;
    try {
      triggerConfig = form.triggerConfig.trim() ? JSON.parse(form.triggerConfig) : {};
    } catch (e) {
      toast.error("Trigger options must be valid JSON");
      return;
    }
    if (!form.name.trim()) {
      toast.error("Give the workflow a name");
      return;
    }
    setSaving(true);
    try {
      const body = workflowWriteBody({
        name: form.name.trim(),
        triggerType: form.triggerType,
        triggerConfig,
        steps: form.steps,
        enabled: form.enabled,
        adminLocked: isAdmin ? form.adminLocked : undefined,
      });
      if (isNew) await api.post("/api/admin/workflows", body);
      else await api.put(`/api/admin/workflows/${workflow.id}`, body);
      toast.success(isNew ? "Workflow created" : "Workflow saved");
      onSaved();
      onClose();
    } catch (e) {
      toast.error("Couldn't save workflow", { description: errorMessage(e) });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Sheet open onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="w-full sm:max-w-xl overflow-y-auto bg-vl-canvas" data-testid="workflow-sheet">
        <SheetHeader>
          <SheetTitle className="vl-serif text-[26px]">{isNew ? "New workflow" : "Edit workflow"}</SheetTitle>
          <SheetDescription>Describe when it runs and what it should do. Only step types supported by your receptionist are offered.</SheetDescription>
        </SheetHeader>
        <div className="mt-5 space-y-4">
          <Field label="Name" htmlFor="wf-name" required>
            <Input id="wf-name" value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} className="bg-white" data-testid="workflow-name-input" />
          </Field>
          <Field label="Runs when" htmlFor="wf-trigger">
            <Select value={form.triggerType} onValueChange={(v) => setForm((f) => ({ ...f, triggerType: v }))}>
              <SelectTrigger id="wf-trigger" className="bg-white" data-testid="workflow-trigger-select">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {triggerTypes.map((t) => (
                  <SelectItem key={t} value={t}>
                    {TRIGGER_LABELS[t] || titleCase(t)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label="Trigger options (JSON)" htmlFor="wf-tc" hint='e.g. {"afterHoursOnly": true}'>
            <Textarea id="wf-tc" rows={3} value={form.triggerConfig} onChange={(e) => setForm((f) => ({ ...f, triggerConfig: e.target.value }))} className="bg-white font-mono text-[12px]" data-testid="workflow-trigger-config" />
          </Field>

          <div className="space-y-2">
            <div className="text-[13px] font-medium">Steps</div>
            {form.steps.map((s, i) => (
              <div key={i} className="vl-card p-3 space-y-2" data-testid="workflow-step">
                <div className="flex items-center gap-2">
                  <Select value={s.type} onValueChange={(v) => setStep(i, emptyStep(v))}>
                    <SelectTrigger className="h-9 w-[180px]" aria-label="Step type">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {stepTypes.map((t) => (
                        <SelectItem key={t} value={t}>
                          {STEP_LABELS[t] || titleCase(t)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Button type="button" variant="ghost" size="icon" className="ml-auto" onClick={() => setForm((f) => ({ ...f, steps: f.steps.filter((_, idx) => idx !== i) }))} aria-label="Remove step">
                    <Trash2 className="h-4 w-4 text-vl-danger" />
                  </Button>
                </div>
                {s.type === "send_sms" || s.type === "send_email" ? (
                  <div className="grid gap-2 sm:grid-cols-[140px_1fr]">
                    <Input value={s.to || ""} onChange={(e) => setStep(i, { to: e.target.value })} placeholder={s.type === "send_email" ? "owner or email" : "caller or +1…"} aria-label="Send to" />
                    <Input value={s.template || ""} onChange={(e) => setStep(i, { template: e.target.value })} placeholder="Message text" aria-label="Message" />
                  </div>
                ) : s.type === "store_lead" ? (
                  <Input value={s.tag || ""} onChange={(e) => setStep(i, { tag: e.target.value })} placeholder="Tag name" aria-label="Tag" />
                ) : s.type === "fire_webhook" || s.type === "book_calendar" ? (
                  <Input value={s.url || ""} onChange={(e) => setStep(i, { url: e.target.value })} placeholder="https://…" aria-label="Webhook URL" />
                ) : s.type === "write_fsm_job" ? (
                  <Input value={s.provider || s.config?.provider || ""} onChange={(e) => setStep(i, { provider: e.target.value })} placeholder="jobber or housecall_pro" aria-label="FSM provider" />
                ) : (
                  <p className="vl-meta">This step uses server defaults (no extra fields).</p>
                )}
              </div>
            ))}
            <Button type="button" variant="outline" size="sm" onClick={() => setForm((f) => ({ ...f, steps: [...f.steps, emptyStep(stepTypes[0])] }))} data-testid="workflow-add-step">
              <Plus className="h-4 w-4" /> Add step
            </Button>
          </div>

          <div className="flex flex-wrap gap-5">
            <label className="inline-flex items-center gap-2 text-[13px]">
              <Switch checked={form.enabled} onCheckedChange={(v) => setForm((f) => ({ ...f, enabled: v }))} /> Enabled
            </label>
            {isAdmin ? (
              <label className="inline-flex items-center gap-2 text-[13px]">
                <Switch checked={form.adminLocked} onCheckedChange={(v) => setForm((f) => ({ ...f, adminLocked: v }))} data-testid="workflow-admin-locked" /> Lock from owner edits
              </label>
            ) : null}
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button onClick={save} disabled={saving} data-testid="workflow-save-button">
              {saving ? "Saving…" : isNew ? "Create workflow" : "Save changes"}
            </Button>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
};

const TestDialog = ({ api, workflow, onClose, onRan }) => {
  const [result, setResult] = React.useState(null);
  const [busy, setBusy] = React.useState(false);
  const run = async () => {
    setBusy(true);
    try {
      const r = fromWorkflowTest(await api.post(`/api/admin/workflows/${workflow.id}/test`, {}));
      setResult(r);
      onRan && onRan();
    } catch (e) {
      toast.error("Test failed", { description: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };
  React.useEffect(() => {
    run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg" data-testid="workflow-test-dialog">
        <DialogHeader>
          <DialogTitle>Test run: {workflow.name}</DialogTitle>
          <DialogDescription>Dry run with sample data.</DialogDescription>
        </DialogHeader>
        <InlineNote tone="gold" icon={FlaskConical} testId="dry-run-note">
          <span className="font-medium">Test only — no production action.</span> Nothing was sent to callers or your team.
        </InlineNote>
        {busy && !result ? <CardSkeleton lines={4} /> : null}
        {result ? (
          <div className="space-y-3 text-[13px]">
            <div className="flex items-center gap-2">
              <Pill tone={result.matched ? "success" : "neutral"} icon={result.matched ? CheckCircle2 : AlertCircle}>
                {result.matched ? "Trigger would fire" : "Trigger would not fire"}
              </Pill>
              {!result.enabled ? <Pill tone="neutral">Workflow is off</Pill> : null}
            </div>
            <p className="text-vl-secondary">{result.reason}</p>
            <div className="vl-card-soft p-3 space-y-2">
              <div className="vl-eyebrow-dark">Steps preview</div>
              {(result.steps || []).map((s, i) => (
                <div key={i} className="flex items-start gap-2">
                  <ArrowRight className="h-3.5 w-3.5 mt-0.5 text-vl-gold shrink-0" aria-hidden="true" />
                  <div>
                    <div className="font-medium">{STEP_LABELS[s.type] || titleCase(s.type)}</div>
                    {s.rendered ? <div className="text-vl-secondary">“{s.rendered}”</div> : null}
                  </div>
                </div>
              ))}
            </div>
            {result.sample ? <div className="vl-meta">Sample caller {result.sample.callerId} · {result.run ? fmtDateTime(result.run.startedAt) : ""}</div> : null}
          </div>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={run} disabled={busy}>
            Run again
          </Button>
          <Button onClick={onClose}>Done</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
};
