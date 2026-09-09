import React from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { PageHeader, Card, CardHeader, Field } from "@/components/vl/Cards";
import { QueryBoundary, CardSkeleton } from "@/components/vl/States";
import { errorMessage } from "@/lib/api";
import { fmtDateTime } from "@/lib/format";
import { useAdmin } from "../AdminApp";

export default function OnCall() {
  const { api, tenantId } = useAdmin();
  const q = useQuery({ queryKey: ["oncall", tenantId], queryFn: () => api.get("/api/admin/oncall"), enabled: !!tenantId });
  const [rows, setRows] = React.useState([]);
  const [drillNumber, setDrillNumber] = React.useState("");
  React.useEffect(() => {
    if (q.data && q.data.rotation) {
      setRows(q.data.rotation.map((r) => ({ label: r.label, e164: r.e164, weekday: r.weekday ?? "", startHhmm: r.start_hhmm || "", endHhmm: r.end_hhmm || "", quietHours: !!r.quiet_hours })));
    }
  }, [q.data]);
  const save = async () => {
    try {
      await api.put("/api/admin/oncall/rotation", {
        rotation: rows.map((r) => ({
          ...r,
          weekday: r.weekday === "" ? undefined : Number(r.weekday),
        })),
      });
      toast.success("Rotation saved");
      q.refetch();
    } catch (e) {
      toast.error("Couldn't save rotation", { description: errorMessage(e) });
    }
  };
  const drill = async () => {
    try {
      const res = await api.post("/api/admin/oncall/drill", {
        e164: drillNumber || undefined,
      });
      toast.success(
        res.smsSent && res.voiceDialed
          ? "SMS and voice drill started"
          : "Drill recorded with a delivery failure",
      );
      q.refetch();
    } catch (e) {
      toast.error("Drill failed", { description: errorMessage(e) });
    }
  };
  return (
    <div data-testid="admin-oncall-page">
      <PageHeader serif={false} eyebrow="Selected tenant" title="On-call" subtitle="Static line, rotation, quiet hours, and drill mode." />
      <QueryBoundary query={q} skeleton={<CardSkeleton lines={6} />}>
        {(data) => (
          <div className="space-y-4">
            <Card>
              <CardHeader title="Resolved now" subtitle={`Source ${data.resolved && data.resolved.source} · timeout ${data.timeoutSecs}s`} />
              <div className="text-[14px]">{(data.resolved && data.resolved.e164) || data.staticE164 || "No on-call number"}</div>
              <div className="vl-meta mt-1">
                Last drill: {data.lastDrill ? `${fmtDateTime(data.lastDrill.created_at)} · ${data.lastDrill.status || (data.lastDrill.ok ? "answered" : "failed")}${data.lastDrill.latency_ms ? ` · ${data.lastDrill.latency_ms} ms` : ""}` : "never"}
              </div>
              <div className="mt-3 flex flex-wrap items-end gap-2">
                <Field label="Drill test number">
                  <Input value={drillNumber} onChange={(e) => setDrillNumber(e.target.value)} placeholder={data.staticE164 || "+15095550100"} />
                </Field>
                <Button onClick={drill} data-testid="oncall-drill">Run SMS + voice drill</Button>
              </div>
            </Card>
            <Card>
              <CardHeader title="Rotation" action={<Button size="sm" variant="outline" onClick={() => setRows((r) => [...r, { label: "Tech", e164: "", weekday: "", startHhmm: "17:00", endHhmm: "07:00", quietHours: false }])}>Add slot</Button>} />
              <div className="space-y-3">
                {rows.map((r, i) => (
                  <div key={i} className="grid gap-2 md:grid-cols-6 items-end">
                    <Field label="Label"><Input value={r.label} onChange={(e) => setRows((xs) => xs.map((x, j) => j === i ? { ...x, label: e.target.value } : x))} /></Field>
                    <Field label="E.164"><Input value={r.e164} onChange={(e) => setRows((xs) => xs.map((x, j) => j === i ? { ...x, e164: e.target.value } : x))} /></Field>
                    <Field label="Weekday 0-6"><Input value={r.weekday} onChange={(e) => setRows((xs) => xs.map((x, j) => j === i ? { ...x, weekday: e.target.value } : x))} /></Field>
                    <Field label="Start"><Input value={r.startHhmm} onChange={(e) => setRows((xs) => xs.map((x, j) => j === i ? { ...x, startHhmm: e.target.value } : x))} /></Field>
                    <Field label="End"><Input value={r.endHhmm} onChange={(e) => setRows((xs) => xs.map((x, j) => j === i ? { ...x, endHhmm: e.target.value } : x))} /></Field>
                    <div className="flex items-center gap-2 pb-2">
                      <Switch checked={r.quietHours} onCheckedChange={(v) => setRows((xs) => xs.map((x, j) => j === i ? { ...x, quietHours: v } : x))} />
                      <span className="text-[12px]">Quiet</span>
                    </div>
                  </div>
                ))}
              </div>
              <Button className="mt-4" onClick={save}>Save rotation</Button>
            </Card>
          </div>
        )}
      </QueryBoundary>
    </div>
  );
}
