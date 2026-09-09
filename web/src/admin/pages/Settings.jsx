import React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Cpu, ShieldCheck, Cloud, Server, Stethoscope, Gauge, Mic, PhoneCall, Save, RefreshCw, AlertTriangle, CheckCircle2, Lock, KeyRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { PageHeader, Card, CardHeader, Field, InlineNote, Stat } from "@/components/vl/Cards";
import { Pill, StatusChip } from "@/components/vl/Pills";
import { QueryBoundary, CardSkeleton, StaffOnlyState } from "@/components/vl/States";
import { ConfirmDialog } from "@/components/vl/ConfirmDialog";
import { LlmConfigPanel } from "@/components/vl/editors/LlmConfigPanel";
import { useAdmin } from "../AdminApp";
import { TenantContextBar } from "../AdminShell";
import { adminStore } from "@/lib/session";
import { ApiError, errorMessage } from "@/lib/api";
import { fmtDateTime, fmtRelative, titleCase } from "@/lib/format";
import { fromAdminHealth, fromRuntimeHealth, isServiceStatusOk } from "@/lib/controlPlaneAdapters";

export default function Settings() {
  const { api, tenantId, tenant, account, accountQ } = useAdmin();
  return (
    <div data-testid="admin-settings-page" className="space-y-5">
      <PageHeader serif={false} eyebrow="Operations" title="Settings" subtitle="Platform-wide configuration first, then diagnostics for the selected tenant. Superadmin-only areas lock automatically." />

      <StaffSignInCard api={api} account={account} accountQ={accountQ} />

      <div className="grid gap-4 xl:grid-cols-2">
        <PlatformLlm api={api} />
        <div className="space-y-4">
          <TelephonySecret api={api} />
          <CloudflareToken api={api} />
          <HostCredentials api={api} />
        </div>
      </div>

      <RuntimeHealth api={api} />

      {tenantId ? (
        <>
          <TenantContextBar title={`Tenant diagnostics · ${tenant ? tenant.name : tenantId}`} subtitle="Applies to the tenant selected in the top bar." />
          <div className="grid gap-4 xl:grid-cols-2">
            <Card testId="tenant-llm-card">
              <CardHeader title="Tenant AI model routing" icon={Cpu} subtitle="Platform-managed or tenant-supplied provider." />
              <LlmConfigPanel api={api} mode="admin" tenantId={tenantId} />
            </Card>
            <div className="space-y-4">
              <CallQuality api={api} tenantId={tenantId} />
              <OperatorState api={api} tenantId={tenantId} />
            </div>
          </div>
          <Diagnostics api={api} tenantId={tenantId} />
          <NightDeskIntegrations api={api} tenantId={tenantId} />
        </>
      ) : null}
    </div>
  );
}

const StaffSignInCard = ({ api, account, accountQ }) => {
  const [form, setForm] = React.useState({ email: "", currentPassword: "", newPassword: "", confirm: "" });
  const [busy, setBusy] = React.useState(false);
  React.useEffect(() => {
    if (account && account.email && !form.email) {
      setForm((f) => ({ ...f, email: account.emailIsPlaceholder ? "" : account.email }));
    }
  }, [account, form.email]);
  const canChange = account && account.canChange;
  const save = async (e) => {
    e.preventDefault();
    if (form.newPassword && form.newPassword !== form.confirm) {
      toast.error("The two new passwords don't match");
      return;
    }
    setBusy(true);
    try {
      const body = { currentPassword: form.currentPassword };
      if (form.email.trim()) body.email = form.email.trim();
      if (form.newPassword) body.newPassword = form.newPassword;
      const res = await api.post("/api/admin/account/credentials", body);
      if (res && res.token) {
        adminStore.login({ token: res.token, tenantId: adminStore.getTenantId(), meta: { email: res.email } });
      }
      toast.success("Sign-in details updated", { description: "Use the new email and password next time you sign in." });
      setForm((f) => ({ email: (res && res.email) || f.email, currentPassword: "", newPassword: "", confirm: "" }));
      if (accountQ) accountQ.refetch();
    } catch (err) {
      toast.error("Couldn't update sign-in", { description: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card testId="staff-signin-card" id="account">
      <CardHeader title="Your sign-in" icon={KeyRound} subtitle="Email and password for this operations console. Changes take effect immediately — no server restart." />
      {!account && accountQ && accountQ.isPending ? (
        <CardSkeleton lines={4} className="border-0 p-0" />
      ) : !canChange ? (
        <InlineNote>
          This session is managed by your identity provider. Change your email or password there, then sign in again.
        </InlineNote>
      ) : (
        <form onSubmit={save} className="space-y-3" data-testid="staff-signin-form">
          <div className="grid gap-3 sm:grid-cols-2">
            <Stat label="Current login" value={account.email || "—"} />
            <Stat label="Stored in" value={account.source === "database" ? "This control plane" : "Server environment (bootstrap)"} />
          </div>
          {account.emailIsPlaceholder ? (
            <InlineNote tone="warning" icon={AlertTriangle}>
              The bootstrap login is a username, not an email. Set a work email below so you can sign in from /admin.
            </InlineNote>
          ) : (
            <InlineNote>This is the staff login for /admin. Each business owner changes their own portal login under Portal → Settings.</InlineNote>
          )}
          <Field label="Work email" htmlFor="staff-email" hint="Used on the platform sign-in page.">
            <Input id="staff-email" type="email" autoComplete="username" value={form.email} onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))} data-testid="staff-email-input" />
          </Field>
          <Field label="Current password" htmlFor="staff-current" required>
            <Input id="staff-current" type="password" autoComplete="current-password" required value={form.currentPassword} onChange={(e) => setForm((f) => ({ ...f, currentPassword: e.target.value }))} data-testid="staff-current-password" />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="New password" htmlFor="staff-new" hint={`Leave blank to keep the current password. At least ${account.passwordMinLength || 8} characters.`}>
              <Input id="staff-new" type="password" autoComplete="new-password" value={form.newPassword} onChange={(e) => setForm((f) => ({ ...f, newPassword: e.target.value }))} data-testid="staff-new-password" />
            </Field>
            <Field label="Confirm new password" htmlFor="staff-confirm">
              <Input id="staff-confirm" type="password" autoComplete="new-password" value={form.confirm} onChange={(e) => setForm((f) => ({ ...f, confirm: e.target.value }))} data-testid="staff-confirm-password" />
            </Field>
          </div>
          <div className="flex justify-end">
            <Button type="submit" disabled={busy || !form.currentPassword || (account.emailIsPlaceholder && !form.email.trim()) || (!form.email.trim() && !form.newPassword)} data-testid="staff-signin-save">
              <Save className="h-4 w-4" /> {busy ? "Saving…" : "Save sign-in details"}
            </Button>
          </div>
        </form>
      )}
    </Card>
  );
};

const useStaffQuery = (key, fn) => useQuery({ queryKey: key, queryFn: fn });
const staffOnly = (q) => q.isError && q.error instanceof ApiError && q.error.isStaffOnly;

const PlatformLlm = ({ api }) => {
  const q = useStaffQuery(["admin", "platform-llm"], () => api.get("/api/admin/config"));
  const [form, setForm] = React.useState(null);
  const [key, setKey] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  React.useEffect(() => {
    if (q.data && !form) setForm({ provider: q.data.provider || "local", openaiModel: q.data.openaiModel || "", localUrl: q.data.localUrl && q.data.localUrl !== "[redacted]" ? q.data.localUrl : "" });
  }, [q.data, form]);
  return (
    <Card testId="platform-llm-card">
      <CardHeader title="Platform LLM" subtitle="On-prem Qwen by default. OpenAI is optional BYOK." icon={Cpu} action={q.data ? <Pill tone={q.data.provider === "local" || q.data.hasOpenAIApiKey ? "success" : "warning"} icon={q.data.provider === "local" || q.data.hasOpenAIApiKey ? CheckCircle2 : AlertTriangle} size="sm">{q.data.provider === "local" ? "On-prem" : q.data.hasOpenAIApiKey ? "OpenAI key set" : "No OpenAI key"}</Pill> : null} />
      <QueryBoundary query={q} skeleton={<CardSkeleton lines={4} className="border-0 p-0" />} compact>
        {(d) =>
          form ? (
            <div className="space-y-3">
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Provider" htmlFor="pl-prov">
                  <Select value={form.provider} onValueChange={(v) => setForm((f) => ({ ...f, provider: v }))}>
                    <SelectTrigger id="pl-prov" data-testid="platform-llm-provider">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="local">On-prem Qwen</SelectItem>
                      <SelectItem value="openai">OpenAI (cloud)</SelectItem>
                    </SelectContent>
                  </Select>
                </Field>
                {form.provider === "openai" ? (
                  <Field label="OpenAI model" htmlFor="pl-model">
                    <Input id="pl-model" value={form.openaiModel} onChange={(e) => setForm((f) => ({ ...f, openaiModel: e.target.value }))} placeholder="gpt-4o-mini" data-testid="platform-llm-model" />
                  </Field>
                ) : (
                  <Field label="On-prem model" htmlFor="pl-model">
                    <Input id="pl-model" value={form.openaiModel} onChange={(e) => setForm((f) => ({ ...f, openaiModel: e.target.value }))} placeholder="Qwen3.5-27B-GPTQ-Int4" data-testid="platform-llm-model" />
                  </Field>
                )}
                {form.provider === "local" ? (
                  <Field label="On-prem endpoint" htmlFor="pl-url" hint={d.localUrl === "[redacted]" ? "Current value hidden for your role." : "OpenAI-compatible chat completions URL."}>
                    <Input id="pl-url" value={form.localUrl} onChange={(e) => setForm((f) => ({ ...f, localUrl: e.target.value }))} placeholder="http://host.docker.internal:8082/v1/chat/completions" />
                  </Field>
                ) : null}
              </div>
              {form.provider === "openai" ? (
                <Field label="OpenAI API key" htmlFor="pl-key" hint="Write-only. Leave blank to keep the existing key.">
                  <Input id="pl-key" type="password" autoComplete="off" value={key} onChange={(e) => setKey(e.target.value)} placeholder={d.hasOpenAIApiKey ? "••••••••  (set)" : "sk-…"} data-testid="platform-llm-key" />
                </Field>
              ) : null}
              <div className="flex justify-end">
                <Button disabled={busy} onClick={async () => { setBusy(true); try { const body = { provider: form.provider, openaiModel: form.openaiModel || undefined, localUrl: form.localUrl || undefined }; if (key) body.openaiApiKey = key; await api.post("/api/admin/config", body); toast.success("Platform LLM saved"); setKey(""); q.refetch(); } catch (e) { toast.error("Couldn't save", { description: errorMessage(e) }); } finally { setBusy(false); } }} data-testid="platform-llm-save">
                  <Save className="h-4 w-4" /> Save
                </Button>
              </div>
              {d.updatedAt ? <div className="vl-meta">Updated {fmtRelative(d.updatedAt)}</div> : null}
            </div>
          ) : null
        }
      </QueryBoundary>
    </Card>
  );
};

const TelephonySecret = ({ api }) => {
  const q = useStaffQuery(["admin", "telephony-secret"], () => api.get("/api/admin/telephony/secret"));
  const [secret, setSecret] = React.useState("");
  const [confirm, setConfirm] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  return (
    <Card testId="telephony-secret-card">
      <CardHeader title="Telephony webhook secret" icon={ShieldCheck} subtitle="Signs carrier webhooks. Rotating it requires updating the carrier." action={q.data ? <Pill tone={q.data.hasSecret ? "success" : "danger"} size="sm" icon={q.data.hasSecret ? CheckCircle2 : AlertTriangle}>{q.data.hasSecret ? "Secret set" : "Missing"}</Pill> : null} />
      {staffOnly(q) ? (
        <StaffOnlyState compact description="Only superadmins can view or rotate the telephony secret." />
      ) : (
        <QueryBoundary query={q} skeleton={<CardSkeleton lines={2} className="border-0 p-0" />} compact>
          {(d) => (
            <div className="space-y-3">
              {d.updatedAt ? <div className="vl-meta">Last rotated {fmtDateTime(d.updatedAt)}</div> : null}
              <div className="flex gap-2">
                <Input type="password" autoComplete="off" value={secret} onChange={(e) => setSecret(e.target.value)} placeholder="New secret (min 16 chars)" data-testid="telephony-secret-input" />
                <Button variant="outline" disabled={secret.length < 16 || busy} onClick={() => setConfirm(true)} data-testid="telephony-secret-rotate">
                  Rotate
                </Button>
              </div>
              <ConfirmDialog open={confirm} onOpenChange={setConfirm} title="Rotate the telephony secret?" description="Carrier webhooks signed with the old secret will be rejected until the carrier is updated." confirmLabel="Rotate secret" destructive loading={busy} onConfirm={async () => { setBusy(true); try { await api.post("/api/admin/telephony/secret", { secret }); toast.success("Secret rotated"); setSecret(""); setConfirm(false); q.refetch(); } catch (e) { toast.error("Couldn't rotate", { description: errorMessage(e) }); } finally { setBusy(false); } }} />
            </div>
          )}
        </QueryBoundary>
      )}
    </Card>
  );
};

const CloudflareToken = ({ api }) => {
  const q = useStaffQuery(["admin", "cloudflare-token"], () => api.get("/api/admin/cloudflare/token"));
  return (
    <Card testId="cloudflare-token-card">
      <CardHeader title="Cloudflare token" icon={Cloud} subtitle="Managed by infrastructure — read-only here." action={q.data ? <Pill tone={q.data.hasToken ? "success" : "neutral"} size="sm" icon={q.data.hasToken ? CheckCircle2 : Lock}>{q.data.hasToken ? "Token present" : "Not set"}</Pill> : null} />
      {staffOnly(q) ? <StaffOnlyState compact description="Only superadmins can see the Cloudflare token status." /> : <QueryBoundary query={q} skeleton={<CardSkeleton lines={1} className="border-0 p-0" />} compact>{() => <InlineNote icon={Lock}>Writes to this token are disabled by the API (410). Change it through infrastructure secrets.</InlineNote>}</QueryBoundary>}
    </Card>
  );
};

const RuntimeHealth = ({ api }) => {
  const q = useQuery({ queryKey: ["admin", "runtime-health"], queryFn: () => api.get("/api/admin/runtime/health"), refetchInterval: 60_000 });
  const h = useQuery({ queryKey: ["admin", "health", "settings"], queryFn: () => api.get("/api/admin/health") });
  return (
    <Card testId="runtime-health-card">
      <CardHeader title="Runtime & service health" icon={Server} action={<Button variant="ghost" size="sm" onClick={() => { q.refetch(); h.refetch(); }}><RefreshCw className="h-4 w-4" /> Refresh</Button>} />
      <div className="grid gap-4 md:grid-cols-2">
        <QueryBoundary query={q} skeleton={<CardSkeleton lines={3} className="border-0 p-0" />} compact>
          {(d) => {
            const runtime = fromRuntimeHealth(d);
            return (
            <div className="grid grid-cols-2 gap-3">
              <Stat label="Runtime" value={<StatusChip ok={runtime.ok} okLabel="OK" badLabel={titleCase(runtime.status || "error")} />} />
              <Stat label="Redis" value={runtime.redis ? `${runtime.redis.connected ? "Connected" : "Down"} · ${runtime.redis.latencyMs ?? "—"} ms` : "—"} />
              <Stat label="Published tenants" value={d.publishedTenants ?? "—"} />
              <Stat label="Voice runtime" value={d.voiceRuntime ? `${d.voiceRuntime.reachable ? "Reachable" : "Unreachable"} · ${d.voiceRuntime.version || ""}` : "—"} />
              <Stat label="Checked" value={fmtRelative(runtime.checkedAt || d.checkedAt)} className="col-span-2" />
            </div>
            );
          }}
        </QueryBoundary>
        <QueryBoundary query={h} skeleton={<CardSkeleton lines={3} className="border-0 p-0" />} compact>
          {(d) => {
            const health = fromAdminHealth(d);
            return (
            <div className="grid grid-cols-2 gap-3">
              {["llm", "stt", "tts"].map((k) => (
                <Stat key={k} label={k.toUpperCase()} value={<span className="inline-flex items-center gap-2"><StatusChip ok={health[k] && isServiceStatusOk(health[k].status)} /> <span className="vl-meta">{health[k] ? health[k].provider || health[k].engine : ""}{health[k] && health[k].latencyMs !== undefined ? ` · ${health[k].latencyMs} ms` : ""}</span></span>} />
              ))}
              <Stat label="Active calls" value={health.activeCalls ?? "—"} />
            </div>
            );
          }}
        </QueryBoundary>
      </div>
    </Card>
  );
};

const CallQuality = ({ api, tenantId }) => {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["admin", "call-quality", tenantId], queryFn: () => api.get(`/api/admin/tenants/${tenantId}/call-quality-settings`) });
  const [busy, setBusy] = React.useState(false);
  const [arm, setArm] = React.useState({ reason: "", expiresAt: "", mode: "next_call" });
  const [disableReason, setDisableReason] = React.useState("");
  const [confirmArm, setConfirmArm] = React.useState(false);
  const refresh = () => qc.invalidateQueries({ queryKey: ["admin", "call-quality", tenantId] });
  const patch = async (p) => {
    setBusy(true);
    try {
      await api.patch(`/api/admin/tenants/${tenantId}/call-quality-settings`, p);
      toast.success("Call quality settings saved");
      refresh();
    } catch (e) {
      toast.error("Couldn't save", { description: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card testId="call-quality-card">
      <CardHeader title="Call quality & diagnostics" icon={Gauge} />
      <QueryBoundary query={q} skeleton={<CardSkeleton lines={3} className="border-0 p-0" />} compact>
        {(d) => {
          const diag = d.rawAudioDiagnostics || {};
          return (
            <div className="space-y-4">
              <label className="flex items-center gap-3 rounded-[4px] border border-vl-border bg-vl-soft px-3.5 py-2.5">
                <Switch checked={!!d.showQualityToOwner} disabled={busy} onCheckedChange={(v) => patch({ showQualityToOwner: v })} data-testid="cq-show-owner" />
                <span className="text-[13px]"><span className="block font-medium">Show quality metrics to owner</span><span className="vl-meta">Owner portal call details include score, latency and confidence.</span></span>
              </label>
              <label className="flex items-center gap-3 rounded-[4px] border border-vl-border bg-vl-soft px-3.5 py-2.5">
                <Switch checked={!!d.captureMetrics} disabled={busy} onCheckedChange={(v) => patch({ captureMetrics: v })} data-testid="cq-capture" />
                <span className="text-[13px]"><span className="block font-medium">Capture quality metrics</span><span className="vl-meta">Record latency / interruptions on each call.</span></span>
              </label>

              <div className="rounded-[4px] border border-vl-border p-3.5 space-y-3" data-testid="raw-audio-diagnostics">
                <div className="flex items-center gap-2">
                  <Mic className="h-4 w-4 text-vl-secondary" aria-hidden="true" />
                  <span className="text-[13px] font-semibold">Raw audio diagnostics</span>
                  <Pill size="sm" tone={diag.armed ? "warning" : "neutral"} icon={diag.armed ? AlertTriangle : Lock}>{diag.armed ? `Armed · ${diag.mode || "next call"}` : "Off"}</Pill>
                  <Pill size="sm" tone="neutral" icon={Lock}>Superadmin</Pill>
                </div>
                {diag.armed ? (
                  <>
                    <div className="vl-meta">Reason: {diag.reason} · expires {fmtDateTime(diag.expiresAt)} · by {diag.armedBy}</div>
                    <div className="flex gap-2">
                      <Input value={disableReason} onChange={(e) => setDisableReason(e.target.value)} placeholder="Reason for disabling" data-testid="raw-audio-disable-reason" />
                      <Button variant="outline" disabled={!disableReason.trim() || busy} onClick={async () => { setBusy(true); try { await api.post(`/api/admin/tenants/${tenantId}/raw-audio-diagnostics/disable`, { reason: disableReason }); toast.success("Raw audio capture disabled"); setDisableReason(""); refresh(); } catch (e) { toast.error("Couldn't disable", { description: errorMessage(e) }); } finally { setBusy(false); } }} data-testid="raw-audio-disable">
                        Disable
                      </Button>
                    </div>
                  </>
                ) : (
                  <>
                    <InlineNote tone="warning" icon={AlertTriangle}>Captures the full raw audio of the next call for debugging. Requires a documented reason and an expiry.</InlineNote>
                    <div className="grid gap-2 sm:grid-cols-[1fr_170px_130px]">
                      <Input value={arm.reason} onChange={(e) => setArm((a) => ({ ...a, reason: e.target.value }))} placeholder="Reason (ticket / incident)" data-testid="raw-audio-reason" />
                      <Input type="datetime-local" value={arm.expiresAt} onChange={(e) => setArm((a) => ({ ...a, expiresAt: e.target.value }))} aria-label="Expires at" data-testid="raw-audio-expires" />
                      <Select value={arm.mode} onValueChange={(v) => setArm((a) => ({ ...a, mode: v }))}>
                        <SelectTrigger aria-label="Mode">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="next_call">Next call</SelectItem>
                          <SelectItem value="until_expiry">Until expiry</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <Button variant="outline" disabled={!arm.reason.trim() || !arm.expiresAt || busy} onClick={() => setConfirmArm(true)} data-testid="raw-audio-enable">
                      Arm for next call
                    </Button>
                    <ConfirmDialog open={confirmArm} onOpenChange={setConfirmArm} title="Arm raw audio capture?" description="The next call for this tenant will be recorded in full. This is logged in the audit trail." confirmLabel="Arm capture" destructive loading={busy} onConfirm={async () => { setBusy(true); try { await api.post(`/api/admin/tenants/${tenantId}/raw-audio-diagnostics/enable-next-call`, { reason: arm.reason, expiresAt: new Date(arm.expiresAt).toISOString(), mode: arm.mode }); toast.success("Raw audio capture armed"); setConfirmArm(false); setArm({ reason: "", expiresAt: "", mode: "next_call" }); refresh(); } catch (e) { toast.error(e instanceof ApiError && e.isStaffOnly ? "Superadmin required" : "Couldn't arm", { description: errorMessage(e) }); setConfirmArm(false); } finally { setBusy(false); } }} />
                  </>
                )}
              </div>
            </div>
          );
        }}
      </QueryBoundary>
    </Card>
  );
};

const OperatorState = ({ api, tenantId }) => {
  const q = useQuery({ queryKey: ["admin", "operator-state", tenantId], queryFn: () => api.get(`/api/admin/tenants/${tenantId}/operator-state`) });
  return (
    <Card testId="operator-state-card">
      <CardHeader title="Operator state" icon={PhoneCall} />
      <QueryBoundary query={q} skeleton={<CardSkeleton lines={3} className="border-0 p-0" />} compact>
        {(op) => (
          <div className="space-y-3">
            <ul className="grid grid-cols-2 gap-1.5 text-[13px]">
              {Object.entries(op.onboarding || {}).map(([k, v]) => (
                <li key={k} className="flex items-center gap-2">
                  {v ? <CheckCircle2 className="h-4 w-4 text-vl-success" aria-hidden="true" /> : <AlertTriangle className="h-4 w-4 text-vl-warning" aria-hidden="true" />}
                  <span className={v ? "" : "text-vl-secondary"}>{titleCase(k)}</span>
                </li>
              ))}
            </ul>
            <div className="flex items-center justify-between gap-3 rounded-[4px] bg-vl-soft border border-vl-border px-3.5 py-2.5">
              <div className="text-[13px]">
                <div className="font-medium">Operator test call</div>
                <div className="vl-meta">{op.testCall && op.testCall.completedAt ? `Completed ${fmtDateTime(op.testCall.completedAt)} by ${op.testCall.by || "—"}` : "Not completed yet"}</div>
              </div>
              <Button size="sm" variant="outline" onClick={async () => { try { await api.post(`/api/admin/tenants/${tenantId}/operator-test-call/complete`); toast.success("Marked complete"); q.refetch(); } catch (e) { toast.error(errorMessage(e)); } }} data-testid="operator-test-call-complete">
                Mark complete
              </Button>
            </div>
          </div>
        )}
      </QueryBoundary>
    </Card>
  );
};

const Diagnostics = ({ api, tenantId }) => {
  const [result, setResult] = React.useState(null);
  const [err, setErr] = React.useState(null);
  const [busy, setBusy] = React.useState(false);
  const run = async () => {
    setBusy(true);
    setErr(null);
    try {
      setResult(await api.get(`/api/admin/diagnostics/call-db-check?tenantId=${encodeURIComponent(tenantId)}`));
    } catch (e) {
      setErr(e);
      setResult(null);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card testId="diagnostics-card">
      <CardHeader title="Call database check" icon={Stethoscope} subtitle="Verifies the call store for this tenant (superadmin)." action={<Button variant="outline" size="sm" onClick={run} disabled={busy} data-testid="diagnostics-run"><Stethoscope className="h-4 w-4" /> {busy ? "Checking…" : "Run check"}</Button>} />
      {err ? err instanceof ApiError && err.isStaffOnly ? <StaffOnlyState compact description="Raw diagnostics are restricted to superadmins." /> : <InlineNote tone="danger" icon={AlertTriangle}>{errorMessage(err)}</InlineNote> : null}
      {result ? (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3" data-testid="diagnostics-result">
          <Stat label="Result" value={<StatusChip ok={result.ok} okLabel="Healthy" badLabel="Problem" />} />
          <Stat label="Calls" value={result.callsCount} />
          <Stat label="Leads" value={result.leadsCount} />
          <Stat label="DB latency" value={`${result.dbLatencyMs} ms`} />
          <Stat label="Last call" value={result.lastCallAt ? fmtDateTime(result.lastCallAt) : "—"} className="col-span-2" />
          <Stat label="Indexes" value={(result.indexes || []).join(", ") || "—"} className="col-span-2" />
        </div>
      ) : !err ? (
        <p className="vl-meta">Run the check to see call/lead counts and database latency.</p>
      ) : null}
    </Card>
  );
};

const NightDeskIntegrations = ({ api, tenantId }) => {
  const fsmQ = useQuery({ queryKey: ["admin", "fsm", tenantId], queryFn: () => api.get("/api/admin/fsm") });
  const [jobber, setJobber] = React.useState("");
  const [hcp, setHcp] = React.useState("");
  const [telnyx, setTelnyx] = React.useState("");
  const [telnyxConnectionId, setTelnyxConnectionId] = React.useState("");
  const [telnyxPhone, setTelnyxPhone] = React.useState("");
  const [telnyxPublicKey, setTelnyxPublicKey] = React.useState("");
  const [jobberMembershipField, setJobberMembershipField] = React.useState("");
  const [jobberWarrantyField, setJobberWarrantyField] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const save = async () => {
    setBusy(true);
    try {
      if (jobber) await api.put("/api/admin/fsm/jobber/token", { token: jobber });
      if (hcp) await api.put("/api/admin/fsm/housecall_pro/token", { token: hcp });
      if (jobberMembershipField || jobberWarrantyField) {
        await api.put("/api/admin/fsm/jobber/custom-fields", {
          membershipFieldId: jobberMembershipField || undefined,
          warrantyFieldId: jobberWarrantyField || undefined,
        });
      }
      if (telnyx) await api.put("/api/admin/telnyx/tenant-credentials", {
        apiKey: telnyx,
        connectionId: telnyxConnectionId || undefined,
        phoneNumber: telnyxPhone || undefined,
        publicKey: telnyxPublicKey || undefined,
      });
      toast.success("Night-desk integrations saved");
      setJobber("");
      setHcp("");
      setTelnyx("");
      setTelnyxConnectionId("");
      setTelnyxPhone("");
      setTelnyxPublicKey("");
      setJobberMembershipField("");
      setJobberWarrantyField("");
      fsmQ.refetch();
    } catch (e) {
      toast.error("Couldn't save integrations", { description: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };
  const connectJobber = async () => {
    setBusy(true);
    try {
      const result = await api.post("/api/admin/fsm/jobber/oauth/start", {});
      window.location.assign(result.url);
    } catch (e) {
      toast.error("Couldn't start Jobber OAuth", { description: errorMessage(e) });
      setBusy(false);
    }
  };
  return (
    <Card className="mt-4" testId="night-desk-integrations">
      <CardHeader title="Night desk integrations" icon={PhoneCall} subtitle="Jobber OAuth first, Housecall Pro second. Credentials never display again." />
      <div className="flex flex-wrap gap-2 mb-3">
        <Pill size="sm" tone={fsmQ.data && fsmQ.data.jobberConfigured ? "success" : "neutral"}>Jobber {fsmQ.data && fsmQ.data.jobberConfigured ? "connected" : "not connected"}</Pill>
        <Pill size="sm" tone={fsmQ.data && fsmQ.data.housecallProConfigured ? "success" : "neutral"}>Housecall Pro {fsmQ.data && fsmQ.data.housecallProConfigured ? "connected" : "dry-run"}</Pill>
      </div>
      <div className="mb-3 flex flex-wrap gap-2">
        <Button onClick={connectJobber} disabled={busy}>Connect Jobber with OAuth</Button>
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        <Field label="Jobber test token" hint="Fallback for private testing; OAuth is required for production."><Input type="password" value={jobber} onChange={(e) => setJobber(e.target.value)} /></Field>
        <Field label="Housecall Pro token"><Input type="password" value={hcp} onChange={(e) => setHcp(e.target.value)} /></Field>
        <Field label="Jobber membership field ID"><Input value={jobberMembershipField} onChange={(e) => setJobberMembershipField(e.target.value)} /></Field>
        <Field label="Jobber warranty field ID"><Input value={jobberWarrantyField} onChange={(e) => setJobberWarrantyField(e.target.value)} /></Field>
        <Field label="Tenant Telnyx key"><Input type="password" value={telnyx} onChange={(e) => setTelnyx(e.target.value)} /></Field>
        <Field label="Tenant Telnyx connection ID"><Input value={telnyxConnectionId} onChange={(e) => setTelnyxConnectionId(e.target.value)} /></Field>
        <Field label="Tenant Telnyx sending number"><Input value={telnyxPhone} onChange={(e) => setTelnyxPhone(e.target.value)} placeholder="+15095550100" /></Field>
        <Field label="Tenant Telnyx webhook public key"><Input type="password" value={telnyxPublicKey} onChange={(e) => setTelnyxPublicKey(e.target.value)} /></Field>
      </div>
      <Button className="mt-3" onClick={save} disabled={busy}><Save className="h-4 w-4" /> Save tokens</Button>
    </Card>
  );
};

const HostCredentials = ({ api }) => {
  const q = useStaffQuery(["admin", "host-credentials"], () => api.get("/api/admin/pipeline/host-credentials"));
  const [form, setForm] = React.useState({ renderApiKey: "", railwayToken: "", awsAccessKeyId: "", awsSecretAccessKey: "", awsRegion: "" });
  const [busy, setBusy] = React.useState(false);
  const save = async () => {
    setBusy(true);
    try {
      const body = {};
      if (form.renderApiKey) body.renderApiKey = form.renderApiKey;
      if (form.railwayToken) body.railwayToken = form.railwayToken;
      if (form.awsAccessKeyId) body.awsAccessKeyId = form.awsAccessKeyId;
      if (form.awsSecretAccessKey) body.awsSecretAccessKey = form.awsSecretAccessKey;
      if (form.awsRegion) body.awsRegion = form.awsRegion;
      await api.put("/api/admin/pipeline/host-credentials", body);
      toast.success("Host credentials saved");
      setForm({ renderApiKey: "", railwayToken: "", awsAccessKeyId: "", awsSecretAccessKey: "", awsRegion: "" });
      q.refetch();
    } catch (e) {
      toast.error(e instanceof ApiError && e.isStaffOnly ? "Superadmin required" : "Couldn't save", { description: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card testId="host-credentials-card">
      <CardHeader title="Cloud host credentials" icon={Cloud} subtitle="Used by Pipeline provision. Keys are never shown again." />
      {staffOnly(q) ? <StaffOnlyState compact description="Host API keys are restricted to superadmins." /> : (
        <div className="space-y-3">
          <div className="flex flex-wrap gap-2">
            <Pill size="sm" tone={q.data && q.data.renderConfigured ? "success" : "neutral"}>Render {q.data && q.data.renderConfigured ? "set" : "missing"}</Pill>
            <Pill size="sm" tone={q.data && q.data.railwayConfigured ? "success" : "neutral"}>Railway {q.data && q.data.railwayConfigured ? "set" : "missing"}</Pill>
            <Pill size="sm" tone={q.data && q.data.awsConfigured ? "success" : "neutral"}>AWS {q.data && q.data.awsConfigured ? "set" : "missing"}</Pill>
          </div>
          <Field label="Render API key"><Input type="password" value={form.renderApiKey} onChange={(e) => setForm((f) => ({ ...f, renderApiKey: e.target.value }))} data-testid="host-render-key" /></Field>
          <Field label="Railway token"><Input type="password" value={form.railwayToken} onChange={(e) => setForm((f) => ({ ...f, railwayToken: e.target.value }))} data-testid="host-railway-token" /></Field>
          <Field label="AWS access key"><Input value={form.awsAccessKeyId} onChange={(e) => setForm((f) => ({ ...f, awsAccessKeyId: e.target.value }))} data-testid="host-aws-key" /></Field>
          <Field label="AWS secret"><Input type="password" value={form.awsSecretAccessKey} onChange={(e) => setForm((f) => ({ ...f, awsSecretAccessKey: e.target.value }))} /></Field>
          <Field label="AWS region"><Input value={form.awsRegion} onChange={(e) => setForm((f) => ({ ...f, awsRegion: e.target.value }))} placeholder="us-east-1" /></Field>
          <Button onClick={save} disabled={busy} data-testid="host-credentials-save"><Save className="h-4 w-4" /> Save host keys</Button>
        </div>
      )}
    </Card>
  );
};
