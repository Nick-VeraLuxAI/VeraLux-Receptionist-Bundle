import React from "react";
import { CheckCircle2, Lock, Sparkles, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Pill } from "@/components/vl/Pills";
import { Field } from "@/components/vl/Cards";
import { titleCase } from "@/lib/format";

const TRIGGER_LABELS = {
  call_ended: "When a call ends",
  after_hours_call: "When a call arrives after hours",
  keyword_detected: "When a keyword is heard",
  missed_call: "When a call is missed",
  scheduled: "On a schedule",
  booking_succeeded: "After a successful book",
  qa_flagged: "When Call QA flags a risk",
  job_completed: "When a job is marked complete",
};

const STEP_LABELS = {
  send_email: "Send email",
  send_sms: "Send SMS",
  fire_webhook: "Call webhook",
  ai_summarize: "AI summarize",
  ai_extract: "AI extract",
  store_lead: "Store lead",
  book_calendar: "Book calendar",
  page_on_call: "Page on-call",
  send_digest: "Send morning digest",
  create_approval: "Create inbox item",
  write_fsm_job: "Write FSM job",
  escalate_orphan: "Escalate orphan",
  hold_booking: "Hold booking",
  estimate_followup: "Estimate follow-up",
  noshow_alert: "No-show alert",
};

export { TRIGGER_LABELS, STEP_LABELS };

export const WorkflowGallery = ({
  open,
  templates = [],
  installed = {},
  canEdit,
  enablingId,
  loading,
  onClose,
  onEnable,
  onScratch,
}) => {
  const [selected, setSelected] = React.useState(null);
  const [config, setConfig] = React.useState({});

  React.useEffect(() => {
    if (!open) {
      setSelected(null);
      setConfig({});
    }
  }, [open]);

  const defaults = templates.filter((t) => t.defaultEnabled || t.category === "default");
  const gallery = templates.filter((t) => !(t.defaultEnabled || t.category === "default"));

  const startEnable = (tpl) => {
    if (!canEdit) return;
    const next = {};
    for (const field of tpl.configFields || []) {
      if (field.defaultValue !== undefined) next[field.key] = field.defaultValue;
    }
    if ((tpl.configFields || []).some((f) => f.required || f.type !== "boolean")) {
      setSelected(tpl);
      setConfig(next);
      return;
    }
    onEnable(tpl, next);
  };

  const confirmEnable = () => {
    if (!selected) return;
    onEnable(selected, config);
    setSelected(null);
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-4xl max-h-[88vh] overflow-y-auto bg-vl-canvas" data-testid="workflow-gallery">
        <DialogHeader>
          <DialogTitle className="vl-serif text-[26px]">Workflow templates</DialogTitle>
          <DialogDescription>
            Enable a VeraLux-managed template onto this tenant. Defaults 1–4 are on for new receptionist installs.
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <p className="vl-meta">Loading templates…</p>
        ) : (
          <>
            <GallerySection
              eyebrow="Default on"
              title="New receptionist pack"
              items={defaults}
              installed={installed}
              canEdit={canEdit}
              enablingId={enablingId}
              onEnable={startEnable}
            />
            <GallerySection
              eyebrow="Gallery"
              title="Off until you enable"
              items={gallery}
              installed={installed}
              canEdit={canEdit}
              enablingId={enablingId}
              onEnable={startEnable}
            />
          </>
        )}

        <div className="flex flex-wrap items-center justify-between gap-2 pt-2">
          {!canEdit ? (
            <p className="vl-meta inline-flex items-center gap-1.5">
              <Lock className="h-3.5 w-3.5" /> Review only — ask VeraLux to enable a template, or turn on Owner can edit.
            </p>
          ) : (
            <Button type="button" variant="ghost" size="sm" onClick={onScratch} data-testid="workflow-scratch-button">
              Start from scratch
            </Button>
          )}
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
        </div>

        {selected ? (
          <div className="mt-4 vl-card p-4 space-y-3" data-testid="workflow-template-config">
            <div className="text-[15px] font-semibold">Configure “{selected.name}”</div>
            {(selected.configFields || []).map((field) => (
              <Field key={field.key} label={field.label} hint={field.hint} required={field.required} htmlFor={`tpl-${field.key}`}>
                {field.type === "boolean" ? (
                  <label className="inline-flex items-center gap-2 text-[13px]">
                    <Switch
                      checked={!!config[field.key]}
                      onCheckedChange={(v) => setConfig((c) => ({ ...c, [field.key]: v }))}
                    />
                    {field.label}
                  </label>
                ) : field.type === "textarea" || field.type === "keywords" ? (
                  <Textarea
                    id={`tpl-${field.key}`}
                    rows={3}
                    value={Array.isArray(config[field.key]) ? config[field.key].join(", ") : config[field.key] || ""}
                    onChange={(e) => setConfig((c) => ({ ...c, [field.key]: e.target.value }))}
                    placeholder={field.placeholder}
                    className="bg-white"
                  />
                ) : (
                  <Input
                    id={`tpl-${field.key}`}
                    type={field.type === "number" ? "number" : "text"}
                    value={config[field.key] ?? ""}
                    onChange={(e) => setConfig((c) => ({ ...c, [field.key]: e.target.value }))}
                    placeholder={field.placeholder}
                    className="bg-white"
                  />
                )}
              </Field>
            ))}
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setSelected(null)}>
                Back
              </Button>
              <Button onClick={confirmEnable} disabled={enablingId === selected.id} data-testid="workflow-template-confirm">
                {enablingId === selected.id ? "Enabling…" : "Enable template"}
              </Button>
            </div>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
};

const GallerySection = ({ eyebrow, title, items, installed, canEdit, enablingId, onEnable }) => (
  <div className="space-y-3">
    <div>
      <div className="vl-eyebrow-dark">{eyebrow}</div>
      <div className="text-[15px] font-semibold">{title}</div>
    </div>
    <div className="grid gap-3 md:grid-cols-2">
      {items.map((tpl) => {
        const onTenant = Boolean(installed[tpl.id]);
        return (
          <article key={tpl.id} className="vl-card-soft p-3.5 space-y-2" data-testid="workflow-template-card" data-template-id={tpl.id}>
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <h3 className="text-[14px] font-semibold leading-snug">{tpl.name}</h3>
                <p className="vl-meta mt-0.5">{TRIGGER_LABELS[tpl.trigger?.type] || titleCase(tpl.trigger?.type)}</p>
              </div>
              {tpl.defaultEnabled ? (
                <Pill tone="gold" size="sm" icon={Sparkles}>
                  Default on
                </Pill>
              ) : (
                <Pill tone="neutral" size="sm">
                  Off
                </Pill>
              )}
            </div>
            <p className="text-[13px] text-vl-secondary">{tpl.description}</p>
            <ol className="space-y-1">
              {(tpl.steps || []).map((s, i) => (
                <li key={i} className="flex items-center gap-1.5 text-[12px] text-vl-secondary">
                  <Zap className="h-3 w-3 text-vl-gold shrink-0" aria-hidden="true" />
                  {STEP_LABELS[s.action] || titleCase(s.action)}
                </li>
              ))}
            </ol>
            <div className="pt-1">
              {onTenant ? (
                <Pill tone="success" size="sm" icon={CheckCircle2} testId="template-installed-pill">
                  On this tenant
                </Pill>
              ) : canEdit ? (
                <Button
                  size="sm"
                  onClick={() => onEnable(tpl)}
                  disabled={enablingId === tpl.id}
                  data-testid="workflow-enable-template"
                >
                  {enablingId === tpl.id ? "Enabling…" : "Enable"}
                </Button>
              ) : (
                <Pill tone="neutral" size="sm" icon={Lock}>
                  VeraLux-managed
                </Pill>
              )}
            </div>
          </article>
        );
      })}
    </div>
  </div>
);
