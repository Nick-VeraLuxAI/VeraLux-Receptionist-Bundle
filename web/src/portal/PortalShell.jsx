import React from "react";
import { NavLink, Link, useLocation } from "react-router-dom";
import { Home, Phone, Users, Bot, Clock, Scissors, PhoneForwarded, MessageCircle, Zap, BarChart3, CreditCard, Settings, Menu, Bell, ChevronDown, LogOut, LifeBuoy, Lock, ShieldCheck, ClipboardCheck, Inbox, Siren, Sunrise, GraduationCap } from "lucide-react";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { BrandLockup } from "@/components/vl/Logo";
import { OnlinePill, SyncPill } from "@/components/vl/Pills";
import { useBranding } from "@/lib/branding";
import { usePortal } from "./PortalApp";
import { initials } from "@/lib/format";
import { cn } from "@/lib/utils";

const NAV = [
  { group: null, items: [
    { to: "/portal", label: "Overview", icon: Home, end: true, id: "overview" },
    { to: "/portal/calls", label: "Calls", icon: Phone, id: "calls" },
    { to: "/portal/leads", label: "Leads", icon: Users, id: "leads" },
  ] },
  { group: "My receptionist", items: [
    { to: "/portal/receptionist", label: "My Receptionist", icon: Bot, id: "receptionist" },
    { to: "/portal/hours", label: "Hours", icon: Clock, id: "hours" },
    { to: "/portal/rules", label: "Shop rules", icon: ShieldCheck, id: "rules" },
    { to: "/portal/cutover", label: "Go-live", icon: ClipboardCheck, id: "cutover" },
    { to: "/portal/approvals", label: "Inbox", icon: Inbox, id: "approvals" },
    { to: "/portal/on-call", label: "On-call", icon: Siren, id: "on-call" },
    { to: "/portal/digest", label: "Last night", icon: Sunrise, id: "digest" },
    { to: "/portal/qa", label: "Coaching", icon: GraduationCap, id: "qa" },
    { to: "/portal/services", label: "Services", icon: Scissors, id: "services", gate: "crmIntegration" },
    { to: "/portal/transfer-lines", label: "Transfer Lines", icon: PhoneForwarded, id: "transfer-lines", gate: "multiLocation" },
    { to: "/portal/quick-replies", label: "Quick Replies", icon: MessageCircle, id: "quick-replies" },
    { to: "/portal/workflows", label: "Workflows", icon: Zap, id: "workflows", gate: "customWorkflows" },
  ] },
  { group: "Insights", items: [{ to: "/portal/analytics", label: "Analytics", icon: BarChart3, id: "analytics", gate: "advancedAnalytics" }] },
  { group: "Account", items: [
    { to: "/portal/billing", label: "Plan & Billing", icon: CreditCard, id: "billing" },
    { to: "/portal/settings", label: "Settings", icon: Settings, id: "settings" },
  ] },
];

const NavItems = ({ onNavigate }) => {
  const { has } = usePortal();
  return (
    <nav className="flex-1 overflow-y-auto px-3 py-2 space-y-5" aria-label="Portal navigation">
      {NAV.map((g, gi) => {
        const items = g.items;
        if (!items.length) return null;
        return (
          <div key={gi}>
            {g.group ? <div className="vl-eyebrow-dark px-3 mb-2">{g.group}</div> : null}
            <ul className="space-y-0.5">
              {items.map((it) => {
                // Feature gates come from the tenant's plan limits (and are re-enforced by the API's 403).
                // Gated items stay visible but visibly locked so owners know the feature exists.
                const locked = !!it.gate && has(it.gate) === false;
                return (
                  <li key={it.to}>
                    <NavLink
                      to={it.to}
                      end={it.end}
                      onClick={onNavigate}
                      data-testid={`portal-nav-${it.id}`}
                      data-locked={locked ? "true" : undefined}
                      title={locked ? `${it.label} is not included in your current plan` : undefined}
                      className={({ isActive }) =>
                        cn(
                          "group flex items-center gap-3 rounded-[2px] px-3 py-2 text-[14px] transition-colors",
                          isActive ? "bg-vl-gold-soft text-vl-text font-medium shadow-[inset_2px_0_0_var(--vl-gold)]" : "text-vl-secondary hover:text-vl-text hover:bg-vl-soft",
                          locked && !isActive && "text-vl-muted",
                        )
                      }
                    >
                      {({ isActive }) => (
                        <>
                          <it.icon className={cn("h-[18px] w-[18px] shrink-0", isActive ? "text-vl-gold" : locked ? "text-vl-muted" : "text-vl-secondary group-hover:text-vl-text")} aria-hidden="true" />
                          <span className="truncate">{it.label}</span>
                          {locked ? (
                            <>
                              <Lock className="ml-auto h-3.5 w-3.5 text-vl-muted" aria-hidden="true" data-testid={`portal-nav-${it.id}-lock`} />
                              <span className="sr-only">(not included in your plan)</span>
                            </>
                          ) : null}
                        </>
                      )}
                    </NavLink>
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
    </nav>
  );
};

const HelpCard = () => (
  <div className="m-3 rounded-[4px] border border-vl-border bg-vl-warm p-4" data-testid="portal-help-card">
    <div className="text-[13px] font-semibold">Need help?</div>
    <p className="mt-0.5 text-[12px] text-vl-secondary">Visit our help center or contact support.</p>
    <Button asChild variant="outline" size="sm" className="mt-3 w-full bg-white">
      <a href="mailto:support@veralux.ai" data-testid="portal-get-support">
        <LifeBuoy className="h-4 w-4" /> Get Support
      </a>
    </Button>
  </div>
);

const SidebarInner = ({ onNavigate }) => (
  <div className="flex h-full flex-col">
    <div className="px-5 pt-5 pb-4">
      <Link to="/portal" onClick={onNavigate} className="inline-flex" aria-label="VeraLux portal home">
        <BrandLockup variant="portal" />
      </Link>
    </div>
    <NavItems onNavigate={onNavigate} />
    <HelpCard />
  </div>
);

export const PortalShell = ({ children }) => {
  const { tenant, logout, sync, healthOk, healthLoading, health } = usePortal();
  const brand = useBranding();
  const [open, setOpen] = React.useState(false);
  const location = useLocation();
  React.useEffect(() => setOpen(false), [location.pathname]);
  const attention = sync.state !== "synced" || !healthOk;

  return (
    <div className="vl-app-grid min-h-screen bg-vl-canvas" data-testid="portal-shell">
      <aside className="hidden lg:flex fixed inset-y-0 left-0 w-[240px] flex-col border-r border-vl-border bg-[rgba(251,250,247,0.96)]" data-testid="portal-sidebar">
        <SidebarInner />
      </aside>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="left" className="w-[280px] p-0 bg-white" data-testid="portal-mobile-drawer">
          <SidebarInner onNavigate={() => setOpen(false)} />
        </SheetContent>
      </Sheet>

      <div className="lg:pl-[240px] flex min-h-screen flex-col">
        <header className="vl-glass-bar sticky top-0 z-30 h-16 border-b border-vl-border" data-testid="portal-topbar">
          <div className="flex h-full items-center gap-3 px-4 sm:px-6">
            <Button variant="ghost" size="icon" className="lg:hidden" onClick={() => setOpen(true)} aria-label="Open navigation" data-testid="sidebar-mobile-open-button">
              <Menu className="h-5 w-5" />
            </Button>
            <div className="min-w-0">
              <div className="text-[15px] font-semibold truncate" data-testid="portal-business-name">
                {tenant.name}
              </div>
              <div className="vl-meta -mt-0.5">Your AI receptionist</div>
            </div>
            <div className="ml-auto flex items-center gap-2">
              <div className="hidden md:flex items-center gap-2">
                {!healthLoading ? <OnlinePill ok={healthOk} label={healthOk ? "Online" : health ? "Degraded" : "Unreachable"} size="sm" /> : null}
                <SyncPill sync={sync} size="sm" />
              </div>
              <Link to="/portal/calls?filter=missed" className="relative inline-flex h-9 w-9 items-center justify-center rounded-full hover:bg-vl-warm" aria-label="Attention items" data-testid="portal-notifications">
                <Bell className="h-[18px] w-[18px] text-vl-secondary" />
                {attention ? <span className="absolute right-2 top-2 h-2 w-2 rounded-full bg-vl-gold" aria-hidden="true" /> : null}
              </Link>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button className="flex items-center gap-2 rounded-full border border-vl-border bg-white pl-1 pr-2.5 py-1 hover:bg-vl-soft" data-testid="portal-account-menu" aria-label="Account menu">
                    <span className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-vl-warm text-[11px] font-semibold text-vl-text">{initials(tenant.name)}</span>
                    <span className="hidden sm:block max-w-[160px] truncate text-[13px] font-medium">{tenant.name}</span>
                    <ChevronDown className="h-4 w-4 text-vl-muted" aria-hidden="true" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-56">
                  <DropdownMenuLabel>
                    <div className="text-[13px] font-semibold">{tenant.name}</div>
                    <div className="vl-meta">{(tenant.numbers || []).join(", ") || "No number assigned"}</div>
                  </DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem asChild>
                    <Link to="/portal/settings" data-testid="portal-account-settings">
                      <Settings className="h-4 w-4" /> Sign-in & settings
                    </Link>
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={logout} data-testid="portal-logout">
                    <LogOut className="h-4 w-4" /> Sign out
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>
        </header>
        <main className="flex-1 px-4 sm:px-6 lg:px-8 py-6 max-w-[1440px] w-full mx-auto vl-fade-up" key={location.pathname}>
          {children}
        </main>
        {brand.portal.footerHtml ? (
          <footer
            className="vl-brand-footer mx-4 border-t border-vl-border px-4 py-4 text-center font-mono text-[9px] uppercase tracking-[0.08em] text-vl-muted sm:mx-6 lg:mx-8"
            dangerouslySetInnerHTML={{ __html: brand.portal.footerHtml }}
          />
        ) : null}
      </div>
    </div>
  );
};
