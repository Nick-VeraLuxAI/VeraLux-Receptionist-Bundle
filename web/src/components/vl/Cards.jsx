import React from "react";
import { cn } from "@/lib/utils";

export const Card = ({ className, children, soft = false, padded = true, testId, ...rest }) => (
  <section data-testid={testId} className={cn(soft ? "vl-card-soft" : "vl-card", padded && "p-5", className)} {...rest}>
    {children}
  </section>
);

export const CardHeader = ({ title, subtitle, action, icon: Icon, className, testId }) => (
  <div className={cn("mb-4 flex items-start justify-between gap-3", className)} data-testid={testId}>
    <div className="flex items-center gap-2.5 min-w-0">
      {Icon ? <Icon className="h-[18px] w-[18px] text-vl-secondary shrink-0" aria-hidden="true" /> : null}
      <div className="min-w-0">
        <h2 className="vl-section-title truncate">{title}</h2>
        {subtitle ? <p className="vl-meta mt-0.5">{subtitle}</p> : null}
      </div>
    </div>
    {action ? <div className="shrink-0 flex items-center gap-2">{action}</div> : null}
  </div>
);

export const PageHeader = ({ eyebrow, title, subtitle, actions, className, serif = true, testId = "page-header" }) => (
  <div className={cn("mb-6 flex flex-col gap-4 md:flex-row md:items-end md:justify-between", className)} data-testid={testId}>
    <div className="min-w-0">
      {eyebrow ? <div className="vl-eyebrow mb-2">{eyebrow}</div> : null}
      <h1 className={cn("vl-page-title", !serif && "text-[32px] lg:text-[34px]")}>{title}</h1>
      {subtitle ? <p className="mt-2 text-[15px] text-vl-secondary max-w-2xl">{subtitle}</p> : null}
    </div>
    {actions ? <div className="flex flex-wrap items-center gap-2 shrink-0">{actions}</div> : null}
  </div>
);

export const KpiCard = ({ icon: Icon, label, value, hint, tone, testId = "kpi-card", className }) => (
  <div className={cn("vl-card p-5 flex items-center gap-4", className)} data-testid={testId}>
    <div className="vl-icon-circle">{Icon ? <Icon className="h-5 w-5" aria-hidden="true" /> : null}</div>
    <div className="min-w-0">
      <div className="vl-label">{label}</div>
      <div className="flex items-baseline gap-2 flex-wrap">
        <div className="vl-metric" data-testid={`${testId}-metric`}>
          {value}
        </div>
        {hint ? <div className={cn("text-[12px]", tone === "success" ? "text-vl-success" : tone === "danger" ? "text-vl-danger" : "text-vl-muted")}>{hint}</div> : null}
      </div>
    </div>
  </div>
);

export const Stat = ({ label, value, className, testId }) => (
  <div className={cn("min-w-0", className)} data-testid={testId}>
    <div className="vl-label">{label}</div>
    <div className="text-[15px] font-medium text-vl-text truncate">{value}</div>
  </div>
);

export const Field = ({ label, hint, children, htmlFor, className, required }) => (
  <div className={cn("space-y-1.5", className)}>
    {label ? (
      <label htmlFor={htmlFor} className="block font-mono text-[10px] font-semibold uppercase tracking-[0.08em] text-vl-secondary">
        {label}
        {required ? <span className="text-vl-danger"> *</span> : null}
      </label>
    ) : null}
    {children}
    {hint ? <p className="vl-meta">{hint}</p> : null}
  </div>
);

export const InlineNote = ({ tone = "neutral", icon: Icon, children, className, testId }) => {
  const tones = {
    neutral: "bg-vl-soft border-vl-border text-vl-secondary",
    warning: "bg-vl-warning-bg border-[#ebd6a8] text-vl-text",
    danger: "bg-vl-danger-bg border-[#efc4c2] text-vl-text",
    success: "bg-vl-success-bg border-[#bfe3c9] text-vl-text",
    gold: "bg-vl-gold-soft border-[#dcc493] text-vl-text",
  };
  return (
    <div className={cn("flex items-start gap-2.5 rounded-[3px] border px-3.5 py-3 text-[13px]", tones[tone], className)} data-testid={testId} role={tone === "danger" ? "alert" : undefined}>
      {Icon ? <Icon className={cn("h-4 w-4 mt-0.5 shrink-0", tone === "warning" ? "text-vl-warning" : tone === "danger" ? "text-vl-danger" : tone === "success" ? "text-vl-success" : "text-vl-secondary")} aria-hidden="true" /> : null}
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
};
