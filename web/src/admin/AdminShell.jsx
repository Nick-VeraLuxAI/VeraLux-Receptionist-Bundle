import React from "react";
import { NavLink, Link, useLocation } from "react-router-dom";
import { LayoutDashboard, Building2, Hash, Layers, GitBranch, Phone, Users, BarChart3, Zap, CreditCard, ScrollText, KeyRound, Settings, Menu, ChevronDown, LogOut, Bot, Check, Activity, ShieldCheck, ClipboardCheck, Inbox, Siren, Sunrise, GraduationCap } from "lucide-react";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { BrandLockup } from "@/components/vl/Logo";
import { Pill, OnlinePill } from "@/components/vl/Pills";
import { useAdmin } from "./AdminApp";
import { initials } from "@/lib/format";
import { cn } from "@/lib/utils";

const NAV = [
  { group: "Platform", items: [
    { to: "/admin", label: "Overview", icon: LayoutDashboard, end: true, id: "overview" },
    { to: "/admin/tenants", label: "Tenants", icon: Building2, id: "tenants" },
    { to: "/admin/numbers", label: "Numbers", icon: Hash, id: "numbers", cap: "carrier" },
  ] },
  { group: "Selected tenant", items: [
    { to: "/admin/plans", label: "Plans & limits", icon: Layers, id: "plans" },
    { to: "/admin/receptionist", label: "Receptionist", icon: Bot, id: "receptionist" },
    { to: "/admin/pipeline", label: "Pipeline", icon: GitBranch, id: "pipeline" },
    { to: "/admin/rules", label: "Rules", icon: ShieldCheck, id: "rules" },
    { to: "/admin/cutover", label: "Cutover", icon: ClipboardCheck, id: "cutover" },
    { to: "/admin/approvals", label: "Approvals", icon: Inbox, id: "approvals" },
    { to: "/admin/on-call", label: "On-call", icon: Siren, id: "on-call" },
    { to: "/admin/digest", label: "Digest", icon: Sunrise, id: "digest" },
    { to: "/admin/qa", label: "Call QA", icon: GraduationCap, id: "qa" },
    { to: "/admin/calls", label: "Calls", icon: Phone, id: "calls" },
    { to: "/admin/leads", label: "Leads", icon: Users, id: "leads" },
    { to: "/admin/analytics", label: "Analytics", icon: BarChart3, id: "analytics" },
    { to: "/admin/workflows", label: "Workflows", icon: Zap, id: "workflows" },
    { to: "/admin/billing", label: "Billing", icon: CreditCard, id: "billing" },
  ] },
  { group: "Operations", items: [
    { to: "/admin/audit", label: "Audit", icon: ScrollText, id: "audit", cap: "audit" },
    { to: "/admin/api-keys", label: "API Keys", icon: KeyRound, id: "api-keys", cap: "keys" },
    { to: "/admin/settings", label: "Settings", icon: Settings, id: "settings" },
  ] },
];

const NavItems = ({ onNavigate }) => {
  const { caps } = useAdmin();
  return (
    <nav className="flex-1 overflow-y-auto px-3 py-2 space-y-4" aria-label="Platform navigation">
      {NAV.map((g) => {
        const items = g.items.filter((it) => !it.cap || caps[it.cap] !== false);
        if (!items.length) return null;
        return (
          <div key={g.group}>
            <div className="vl-eyebrow-dark px-3 mb-1.5">{g.group}</div>
            <ul className="space-y-0.5">
              {items.map((it) => (
                <li key={it.to}>
                  <NavLink to={it.to} end={it.end} onClick={onNavigate} data-testid={`admin-nav-${it.id}`} className={({ isActive }) => cn("group flex items-center gap-2.5 rounded-[2px] px-3 py-2 text-[13px] transition-colors", isActive ? "bg-vl-gold-soft text-vl-text font-medium shadow-[inset_2px_0_0_var(--vl-gold)]" : "text-vl-secondary hover:text-vl-text hover:bg-vl-soft")}>
                    {({ isActive }) => (
                      <>
                        <it.icon className={cn("h-4 w-4 shrink-0", isActive ? "text-vl-gold" : "text-vl-secondary group-hover:text-vl-text")} aria-hidden="true" />
                        <span className="truncate">{it.label}</span>
                      </>
                    )}
                  </NavLink>
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </nav>
  );
};

export const TenantSelector = ({ className }) => {
  const { tenants, tenantId, tenant, setTenantId, tenantsQ } = useAdmin();
  const [open, setOpen] = React.useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button className={cn("flex h-9 min-w-0 w-[150px] items-center gap-2 rounded-[2px] border border-vl-border-strong bg-white px-3 text-[13px] hover:border-vl-text sm:w-auto sm:min-w-[200px]", className)} aria-label="Select tenant" data-testid="admin-tenant-selector">
          <Building2 className="h-4 w-4 text-vl-gold shrink-0" aria-hidden="true" />
          <span className="truncate font-medium">{tenantsQ.isPending ? "Loading tenants…" : tenant ? tenant.name : tenants.length ? "Select a tenant" : "No tenants yet"}</span>
          {tenant ? <span className="vl-meta hidden md:inline truncate">{tenant.id}</span> : null}
          <ChevronDown className="ml-auto h-4 w-4 text-vl-muted shrink-0" aria-hidden="true" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-[320px] p-0" align="start">
        <Command>
          <CommandInput placeholder="Search tenants…" data-testid="admin-tenant-search" />
          <CommandList>
            <CommandEmpty>No tenant found.</CommandEmpty>
            <CommandGroup heading={`${tenants.length} tenant${tenants.length === 1 ? "" : "s"}`}>
              {tenants.map((t) => (
                <CommandItem key={t.id} value={`${t.name} ${t.id}`} onSelect={() => { setTenantId(t.id); setOpen(false); }} data-testid={`admin-tenant-option-${t.id}`}>
                  <div className="min-w-0 flex-1">
                    <div className="text-[13px] font-medium truncate">{t.name}</div>
                    <div className="vl-meta truncate">{t.id} · {(t.numbers || []).length} number{(t.numbers || []).length === 1 ? "" : "s"}</div>
                  </div>
                  {t.id === tenantId ? <Check className="h-4 w-4 text-vl-gold" aria-hidden="true" /> : null}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
        <div className="border-t border-vl-border p-2">
          <Button asChild variant="ghost" size="sm" className="w-full justify-start">
            <Link to="/admin/tenants" onClick={() => setOpen(false)}>
              <Building2 className="h-4 w-4" /> Manage tenants
            </Link>
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
};

const SidebarInner = ({ onNavigate }) => (
  <div className="flex h-full flex-col">
    <div className="px-5 pt-5 pb-4 border-b border-vl-border">
      <Link to="/admin" onClick={onNavigate} className="inline-flex" aria-label="VeraLux platform home">
        <BrandLockup variant="admin" />
      </Link>
    </div>
    <NavItems onNavigate={onNavigate} />
    <div className="m-3 rounded-[4px] border border-vl-border bg-vl-soft px-3 py-2.5 text-[12px] text-vl-secondary" data-testid="admin-internal-label">
      <div className="font-medium text-vl-text">Internal console</div>
      Staff only. Actions are recorded in the audit log.
    </div>
  </div>
);

export const AdminShell = ({ children }) => {
  const { logout, healthOk, healthLoading, health, tenant, account } = useAdmin();
  const accountEmail = (account && (account.sessionEmail || account.email)) || "";
  const [open, setOpen] = React.useState(false);
  const location = useLocation();
  React.useEffect(() => setOpen(false), [location.pathname]);
  return (
    <div className="vl-app-grid min-h-screen bg-vl-canvas" data-testid="admin-shell">
      <aside className="hidden lg:flex fixed inset-y-0 left-0 w-[250px] flex-col border-r border-vl-border bg-[rgba(251,250,247,0.96)]" data-testid="admin-sidebar">
        <SidebarInner />
      </aside>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="left" className="w-[280px] p-0 bg-white" data-testid="admin-mobile-drawer">
          <SidebarInner onNavigate={() => setOpen(false)} />
        </SheetContent>
      </Sheet>
      <div className="lg:pl-[250px] flex min-h-screen flex-col">
        <header className="vl-glass-bar sticky top-0 z-30 h-14 border-b border-vl-border" data-testid="admin-topbar">
          <div className="flex h-full items-center gap-3 px-4 sm:px-6">
            <Button variant="ghost" size="icon" className="lg:hidden" onClick={() => setOpen(true)} aria-label="Open navigation" data-testid="sidebar-mobile-open-button">
              <Menu className="h-5 w-5" />
            </Button>
            <Pill tone="dark" size="sm" className="hidden sm:inline-flex">
              VeraLux Platform
            </Pill>
            <TenantSelector />
            <div className="ml-auto flex items-center gap-2">
              <div className="hidden sm:block">
                {!healthLoading ? <OnlinePill ok={healthOk} label={healthOk ? "Runtime healthy" : health ? "Runtime degraded" : "Runtime unreachable"} size="sm" /> : <Pill size="sm" icon={Activity}>Checking…</Pill>}
              </div>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button className="flex items-center gap-2 rounded-full border border-vl-border bg-white pl-1 pr-2.5 py-1 hover:bg-vl-soft" data-testid="admin-account-menu" aria-label="Account menu">
                    <span className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-vl-text text-[11px] font-semibold text-white">{initials(accountEmail || "VL")}</span>
                    <ChevronDown className="h-4 w-4 text-vl-muted" aria-hidden="true" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-56">
                  <DropdownMenuLabel>
                    <div className="text-[13px] font-semibold">Staff session</div>
                    <div className="vl-meta truncate">{accountEmail || "Signed in"}</div>
                    <div className="vl-meta">{tenant ? `Working in ${tenant.name}` : "No tenant selected"}</div>
                  </DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem asChild>
                    <Link to="/admin/settings#account" data-testid="admin-account-credentials">
                      <KeyRound className="h-4 w-4" /> Sign-in credentials
                    </Link>
                  </DropdownMenuItem>
                  <DropdownMenuItem asChild>
                    <a href="/portal" target="_blank" rel="noreferrer">
                      <Building2 className="h-4 w-4" /> Open customer portal
                    </a>
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={logout} data-testid="admin-logout">
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
      </div>
    </div>
  );
};

/** Header strip that keeps the selected tenant obvious on tenant-scoped pages. */
export const TenantContextBar = ({ title, subtitle, actions }) => {
  const { tenant, tenantId, sync } = useAdmin();
  return (
    <div className="mb-5 flex flex-col gap-3 md:flex-row md:items-end md:justify-between" data-testid="tenant-context-bar">
      <div className="min-w-0">
        <div className="flex items-center gap-2 mb-1">
          <Pill tone="gold" size="sm" icon={Building2} testId="tenant-context-pill">
            {tenant ? tenant.name : tenantId || "No tenant selected"}
          </Pill>
          {tenant ? <span className="vl-meta">{tenant.id}</span> : null}
          {sync && sync.state === "not_live" ? <Pill size="sm" tone="warning">Runtime not synced</Pill> : null}
        </div>
        <h1 className="font-serif text-[29px] leading-tight tracking-[-0.02em]">{title}</h1>
        {subtitle ? <p className="mt-1 text-[13px] text-vl-secondary">{subtitle}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2 shrink-0">{actions}</div> : null}
    </div>
  );
};

export const NoTenant = () => (
  <div className="vl-card p-10 text-center" data-testid="no-tenant-state">
    <Building2 className="mx-auto h-8 w-8 text-vl-muted" aria-hidden="true" />
    <h2 className="mt-3 text-[16px] font-semibold">Select a tenant to continue</h2>
    <p className="mt-1 text-[13px] text-vl-secondary">Tenant-scoped screens need a tenant in context. Pick one from the selector above, or create one.</p>
    <Button asChild className="mt-4">
      <Link to="/admin/tenants">Go to tenants</Link>
    </Button>
  </div>
);
