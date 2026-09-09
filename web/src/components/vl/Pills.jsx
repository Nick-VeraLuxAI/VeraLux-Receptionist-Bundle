import React from "react";
import { CheckCircle2, AlertTriangle, AlertCircle, Circle, Lock, Clock } from "lucide-react";
import { cn } from "@/lib/utils";
import { billingLabel, billingTone, billingStateLabel, billingStateTone, serviceStatusLabel } from "@/lib/format";

const TONES = {
  success: "bg-vl-success-bg text-vl-success border-[#bfe3c9]",
  warning: "bg-vl-warning-bg text-vl-warning border-[#ebd6a8]",
  danger: "bg-vl-danger-bg text-vl-danger border-[#efc4c2]",
  gold: "bg-vl-gold-soft text-vl-gold-deep border-[#dcc493]",
  neutral: "bg-vl-warm text-vl-secondary border-vl-border",
  dark: "bg-vl-text text-white border-vl-text",
};

export const Pill = ({ tone = "neutral", icon: Icon, children, className, testId, size = "md", ...rest }) => (
  <span
    data-testid={testId}
    className={cn(
      "inline-flex items-center gap-1.5 rounded-[2px] border font-mono font-medium uppercase tracking-[0.04em] whitespace-nowrap",
      size === "sm" ? "px-2 py-1 text-[9px]" : "px-2.5 py-1 text-[10px]",
      TONES[tone] || TONES.neutral,
      className,
    )}
    {...rest}
  >
    {Icon ? <Icon className={size === "sm" ? "h-3 w-3" : "h-3.5 w-3.5"} aria-hidden="true" /> : null}
    {children}
  </span>
);

export const Dot = ({ tone = "success", className }) => (
  <span
    aria-hidden="true"
    className={cn("inline-block h-2 w-2 rounded-full", { success: "bg-vl-success", warning: "bg-vl-warning", danger: "bg-vl-danger", neutral: "bg-vl-muted", gold: "bg-vl-gold" }[tone], className)}
  />
);

/** Green Synced / Amber Changes not live / Red Needs attention - from real API fields. */
export const SyncPill = ({ sync, size = "md", className }) => {
  if (!sync) return null;
  const map = {
    synced: { tone: "success", icon: CheckCircle2 },
    not_live: { tone: "warning", icon: AlertTriangle },
    attention: { tone: "danger", icon: AlertCircle },
  };
  const m = map[sync.state] || map.not_live;
  return (
    <Pill tone={m.tone} icon={m.icon} size={size} className={className} testId="sync-status-pill" data-state={sync.state}>
      {sync.label}
    </Pill>
  );
};

export const OnlinePill = ({ ok = true, label, size = "md" }) => (
  <Pill tone={ok ? "success" : "danger"} icon={ok ? Circle : AlertCircle} size={size} testId="health-status-pill">
    {label || (ok ? "Online" : "Degraded")}
  </Pill>
);

export const BillingPill = ({ status, size = "md" }) => {
  const tone = billingTone(status);
  const Icon = tone === "success" ? CheckCircle2 : tone === "warning" ? AlertTriangle : tone === "danger" ? AlertCircle : tone === "gold" ? Clock : Circle;
  return (
    <Pill tone={tone} icon={Icon} size={size} testId="billing-status-pill">
      {billingLabel(status)}
    </Pill>
  );
};

export const ServicePill = ({ status, size = "md" }) => {
  const tone = billingTone(status);
  return (
    <Pill tone={tone} size={size} testId="service-status-pill">
      Service · {serviceStatusLabel(status)}
    </Pill>
  );
};

export const BillingStatePill = ({ state, size = "md" }) => {
  const tone = billingStateTone(state);
  const Icon = tone === "success" ? CheckCircle2 : tone === "warning" ? AlertTriangle : Circle;
  return (
    <Pill tone={tone} icon={Icon} size={size} testId="stripe-billing-state-pill">
      Billing · {billingStateLabel(state)}
    </Pill>
  );
};

export const LockedPill = ({ children = "Plan upgrade" }) => (
  <Pill tone="neutral" icon={Lock} size="sm">
    {children}
  </Pill>
);

export const StatusChip = ({ ok, okLabel = "OK", badLabel = "Issue" }) => (
  <Pill tone={ok ? "success" : "danger"} icon={ok ? CheckCircle2 : AlertCircle} size="sm">
    {ok ? okLabel : badLabel}
  </Pill>
);
