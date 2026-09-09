import React from "react";
import { cn } from "@/lib/utils";
import { fmtNumber, pct } from "@/lib/format";

export const UsageBar = ({ label, used, limit, unit = "", testId = "plan-usage-progress", className, warnAt = 80 }) => {
  const p = pct(used, limit);
  const tone = p >= 100 ? "bg-vl-danger" : p >= warnAt ? "bg-vl-warning" : "bg-vl-gold";
  return (
    <div className={cn("space-y-1.5", className)} data-testid={testId}>
      <div className="flex items-baseline justify-between gap-3 text-[13px]">
        <span className="text-vl-secondary">{label}</span>
        <span className="text-vl-text font-medium">
          {fmtNumber(used)}
          {unit} <span className="text-vl-muted font-normal">/ {limit ? `${fmtNumber(limit)}${unit}` : "—"}</span>
        </span>
      </div>
      <div className="flex items-center gap-3">
        <div className="h-2 flex-1 rounded-full bg-vl-warm overflow-hidden" role="progressbar" aria-valuenow={p} aria-valuemin={0} aria-valuemax={100} aria-label={label}>
          <div className={cn("h-full rounded-full transition-[width] duration-300", tone)} style={{ width: `${p}%` }} />
        </div>
        <span className="w-9 text-right text-[12px] text-vl-muted">{p}%</span>
      </div>
    </div>
  );
};

/** Renders usage vs limits from GET .../usage response. */
export const UsageList = ({ usage, limits, keys, className }) => {
  const rows = keys || [
    { label: "Minutes used", used: usage?.minutesUsed, limit: limits?.includedMonthlyMinutes },
    { label: "Calls this month", used: usage?.callsThisMonth, limit: limits?.maxMonthlyCalls },
    { label: "Concurrent now", used: usage?.concurrentCallsNow, limit: limits?.maxConcurrentCalls },
    { label: "Phone numbers", used: usage?.phoneNumbers, limit: limits?.maxPhoneNumbers },
  ];
  return (
    <div className={cn("space-y-4", className)}>
      {rows.map((r) => (
        <UsageBar key={r.label} {...r} />
      ))}
    </div>
  );
};
