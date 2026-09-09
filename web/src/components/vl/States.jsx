import React from "react";
import { Lock, ShieldAlert, RefreshCw, Inbox, AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ApiError, errorMessage } from "@/lib/api";
import { FEATURE_LABELS } from "@/lib/format";
import { cn } from "@/lib/utils";

export const RowsSkeleton = ({ rows = 4, className }) => (
  <div className={cn("space-y-3", className)} data-testid="loading-skeleton" aria-busy="true">
    {Array.from({ length: rows }).map((_, i) => (
      <div key={i} className="flex items-center gap-3">
        <Skeleton className="h-9 w-9 rounded-full bg-vl-warm" />
        <div className="flex-1 space-y-2">
          <Skeleton className="h-3.5 w-2/3 bg-vl-warm" />
          <Skeleton className="h-3 w-1/3 bg-vl-warm" />
        </div>
      </div>
    ))}
  </div>
);

export const CardSkeleton = ({ className, lines = 3 }) => (
  <div className={cn("vl-card p-5 space-y-3", className)} data-testid="loading-skeleton" aria-busy="true">
    <Skeleton className="h-4 w-1/3 bg-vl-warm" />
    {Array.from({ length: lines }).map((_, i) => (
      <Skeleton key={i} className="h-3.5 w-full bg-vl-warm" />
    ))}
  </div>
);

export const KpiSkeleton = ({ count = 4 }) => (
  <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4" data-testid="loading-skeleton">
    {Array.from({ length: count }).map((_, i) => (
      <div key={i} className="vl-card p-5 flex items-center gap-4">
        <Skeleton className="h-11 w-11 rounded-full bg-vl-warm" />
        <div className="flex-1 space-y-2">
          <Skeleton className="h-3 w-1/2 bg-vl-warm" />
          <Skeleton className="h-7 w-1/3 bg-vl-warm" />
        </div>
      </div>
    ))}
  </div>
);

export const EmptyState = ({ icon: Icon = Inbox, title, description, action, className, testId = "empty-state", compact = false }) => (
  <div className={cn("flex flex-col items-center justify-center text-center", compact ? "py-8 px-4" : "py-14 px-6", className)} data-testid={testId}>
    <div className="vl-icon-circle mb-4">
      <Icon className="h-5 w-5" aria-hidden="true" />
    </div>
    <h3 className="text-[16px] font-semibold text-vl-text">{title}</h3>
    {description ? <p className="mt-1.5 max-w-md text-[13px] text-vl-secondary">{description}</p> : null}
    {action ? <div className="mt-5">{action}</div> : null}
  </div>
);

export const ErrorState = ({ error, onRetry, title = "We couldn't load this", className, compact }) => (
  <div className={cn("flex flex-col items-center justify-center text-center", compact ? "py-8 px-4" : "py-14 px-6", className)} data-testid="error-state" role="alert">
    <div className="mb-4 inline-flex h-11 w-11 items-center justify-center rounded-full bg-vl-danger-bg text-vl-danger">
      <AlertCircle className="h-5 w-5" aria-hidden="true" />
    </div>
    <h3 className="text-[16px] font-semibold text-vl-text">{title}</h3>
    <p className="mt-1.5 max-w-md text-[13px] text-vl-secondary">{errorMessage(error)}</p>
    {onRetry ? (
      <Button variant="outline" size="sm" className="mt-5" onClick={onRetry} data-testid="retry-button">
        <RefreshCw className="h-4 w-4" /> Try again
      </Button>
    ) : null}
  </div>
);

export const LockedState = ({ feature, onUpgrade, upgradeHref, description, className, compact }) => {
  const label = FEATURE_LABELS[feature] || "This feature";
  return (
    <div className={cn("flex flex-col items-center justify-center text-center", compact ? "py-8 px-4" : "py-14 px-6", className)} data-testid="locked-state">
      <div className="mb-4 inline-flex h-11 w-11 items-center justify-center rounded-full bg-vl-warm text-vl-secondary">
        <Lock className="h-5 w-5" aria-hidden="true" />
      </div>
      <h3 className="text-[16px] font-semibold text-vl-text">{label} is not included in your plan</h3>
      <p className="mt-1.5 max-w-md text-[13px] text-vl-secondary">{description || `Upgrade your plan to unlock ${label.toLowerCase()} for your receptionist.`}</p>
      {onUpgrade || upgradeHref ? (
        <Button className="mt-5" onClick={onUpgrade} asChild={!!upgradeHref} data-testid="upgrade-cta">
          {upgradeHref ? <a href={upgradeHref}>Manage plan</a> : "Manage plan"}
        </Button>
      ) : null}
    </div>
  );
};

export const StaffOnlyState = ({ className, compact, description }) => (
  <div className={cn("flex flex-col items-center justify-center text-center", compact ? "py-8 px-4" : "py-14 px-6", className)} data-testid="staff-only-state">
    <div className="mb-4 inline-flex h-11 w-11 items-center justify-center rounded-full bg-vl-warm text-vl-secondary">
      <ShieldAlert className="h-5 w-5" aria-hidden="true" />
    </div>
    <h3 className="text-[16px] font-semibold text-vl-text">Restricted to VeraLux superadmins</h3>
    <p className="mt-1.5 max-w-md text-[13px] text-vl-secondary">{description || "Your account can view tenant operations but this area touches shared infrastructure. Ask a superadmin if you need a change here."}</p>
  </div>
);

/**
 * Wraps a react-query result and renders the right state.
 * children: (data) => ReactNode
 */
export const QueryBoundary = ({ query, skeleton, children, upgradeHref, onUpgrade, compact, emptyWhen, empty }) => {
  if (query.isPending) return skeleton || <RowsSkeleton />;
  if (query.isError) {
    const e = query.error;
    if (e instanceof ApiError && e.isFeatureGate) return <LockedState feature={e.feature} upgradeHref={upgradeHref} onUpgrade={onUpgrade} compact={compact} />;
    if (e instanceof ApiError && e.isStaffOnly) return <StaffOnlyState compact={compact} />;
    if (e instanceof ApiError && e.isUnauthorized) return null;
    return <ErrorState error={e} onRetry={() => query.refetch()} compact={compact} />;
  }
  if (emptyWhen && emptyWhen(query.data)) return empty || <EmptyState title="Nothing here yet" compact={compact} />;
  return children(query.data);
};
