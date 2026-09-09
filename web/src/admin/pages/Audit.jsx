import React from "react";
import { useQuery } from "@tanstack/react-query";
import { ScrollText, Search, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { PageHeader, Card } from "@/components/vl/Cards";
import { Pill } from "@/components/vl/Pills";
import { QueryBoundary, RowsSkeleton, EmptyState, StaffOnlyState } from "@/components/vl/States";
import { useAdmin } from "../AdminApp";
import { fmtDateTime, fmtRelative } from "@/lib/format";

export default function Audit() {
  const { api, caps } = useAdmin();
  const [limit, setLimit] = React.useState("100");
  const [search, setSearch] = React.useState("");
  const q = useQuery({ queryKey: ["admin", "audit", limit], queryFn: () => api.get(`/api/admin/audit?limit=${limit}`), enabled: caps.audit !== false });

  if (caps.audit === false) {
    return (
      <div data-testid="admin-audit-page">
        <PageHeader serif={false} eyebrow="Operations" title="Audit log" />
        <Card>
          <StaffOnlyState description="The audit trail is visible to superadmins only." />
        </Card>
      </div>
    );
  }
  return (
    <div data-testid="admin-audit-page">
      <PageHeader serif={false} eyebrow="Operations" title="Audit log" subtitle="Who did what, when, and to which tenant. Newest first." actions={<Button variant="outline" size="sm" onClick={() => q.refetch()}><RefreshCw className="h-4 w-4" /> Refresh</Button>} />
      <Card padded={false}>
        <div className="flex flex-wrap items-center gap-3 p-4 border-b border-vl-border">
          <div className="relative flex-1 min-w-[220px] max-w-md">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-vl-muted" aria-hidden="true" />
            <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Filter by actor, action or tenant" className="pl-9 h-9" aria-label="Filter audit entries" data-testid="audit-search" />
          </div>
          <Select value={limit} onValueChange={setLimit}>
            <SelectTrigger className="w-[140px] h-9" data-testid="audit-limit">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {["50", "100", "200"].map((l) => (
                <SelectItem key={l} value={l}>
                  Last {l}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <QueryBoundary query={q} skeleton={<RowsSkeleton rows={8} className="p-5" />}>
          {(d) => {
            const s = search.trim().toLowerCase();
            const rows = (d.entries || []).filter((e) => !s || [e.actor, e.action, e.tenantId, JSON.stringify(e.details || {})].join(" ").toLowerCase().includes(s));
            if (!rows.length) return <EmptyState icon={ScrollText} title="No matching entries" description={s ? "Try a different filter." : "No operator actions recorded yet."} />;
            return (
              <div className="overflow-x-auto vl-scroll">
                <table className="w-full text-[13px] vl-table" data-testid="audit-table">
                  <thead>
                    <tr className="text-left border-b border-vl-border">
                      <th className="py-2 px-4">When</th>
                      <th className="py-2 pr-3">Actor</th>
                      <th className="py-2 pr-3">Action</th>
                      <th className="py-2 pr-3">Tenant</th>
                      <th className="py-2 pr-4">Details</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((e) => (
                      <tr key={e.id} className="border-b border-vl-border last:border-0 vl-row" data-testid="audit-row">
                        <td className="py-2 px-4 whitespace-nowrap text-vl-secondary" title={fmtDateTime(e.at)}>{fmtRelative(e.at)}</td>
                        <td className="py-2 pr-3 whitespace-nowrap">
                          <div className="font-medium">{e.actor}</div>
                          <div className="vl-meta">{e.actorRole}</div>
                        </td>
                        <td className="py-2 pr-3 whitespace-nowrap"><code className="rounded bg-vl-warm px-1.5 py-0.5 text-[12px]">{e.action}</code></td>
                        <td className="py-2 pr-3 whitespace-nowrap">{e.tenantId ? <Pill size="sm" tone="gold">{e.tenantId}</Pill> : <span className="vl-meta">platform</span>}</td>
                        <td className="py-2 pr-4 text-vl-secondary max-w-[420px] truncate font-mono text-[12px]">{e.details ? JSON.stringify(e.details) : ""}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          }}
        </QueryBoundary>
      </Card>
    </div>
  );
}
