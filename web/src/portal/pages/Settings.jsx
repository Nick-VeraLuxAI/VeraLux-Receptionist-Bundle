import React from "react";
import { toast } from "sonner";
import { KeyRound, Hash, Cpu, Building2, LogOut, Mail } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PageHeader, Card, CardHeader, Field, Stat } from "@/components/vl/Cards";
import { LlmConfigPanel } from "@/components/vl/editors/LlmConfigPanel";
import { usePortal } from "../PortalApp";
import { errorMessage } from "@/lib/api";
import { portalStore } from "@/lib/session";

export default function Settings() {
  const { api, tenantId, tenant, logout, limits } = usePortal();
  const [account, setAccount] = React.useState(null);
  React.useEffect(() => {
    let cancelled = false;
    api.get("/api/owner/account").then((d) => {
      if (!cancelled) setAccount(d);
    }).catch(() => {
      if (!cancelled) setAccount({ emailLoginSet: false, passcodeSet: false, email: null });
    });
    return () => { cancelled = true; };
  }, [api, tenantId]);
  return (
    <div data-testid="portal-settings-page">
      <PageHeader eyebrow="Account" title="Settings" subtitle="Your sign-in details and how your receptionist thinks." />
      <div className="grid gap-4 lg:grid-cols-2">
        <Card testId="account-card">
          <CardHeader title="Your business" icon={Building2} />
          <div className="grid grid-cols-2 gap-4">
            <Stat label="Business name" value={tenant.name} />
            <Stat label="Plan" value={limits ? limits.planName : "—"} />
            <Stat label="Sign-in email" value={(account && account.email) || "Not set"} />
            <Stat label="Receptionist numbers" value={(tenant.numbers || []).join(", ") || "None assigned"} className="col-span-2" />
          </div>
          <p className="mt-4 vl-meta">To change your business name or numbers, contact your VeraLux representative.</p>
          <Button variant="outline" className="mt-4" onClick={logout} data-testid="settings-sign-out">
            <LogOut className="h-4 w-4" /> Sign out
          </Button>
        </Card>
        <div className="space-y-4">
          {account && account.emailLoginSet ? <ChangeEmail api={api} currentEmail={account.email} onChanged={(email) => setAccount((a) => ({ ...a, email }))} /> : null}
          <ChangeSecret api={api} kind="password" />
          <ChangeSecret api={api} kind="passcode" />
        </div>
      </div>
      <Card className="mt-4" testId="llm-card">
        <CardHeader title="AI model" subtitle="Which language model powers your receptionist's replies." icon={Cpu} />
        <LlmConfigPanel api={api} mode="portal" tenantId={tenantId} />
      </Card>
      <OwnedVoiceCard api={api} tenantId={tenantId} />
    </div>
  );
}

const OwnedVoiceCard = ({ api, tenantId }) => {
  const [mode, setMode] = React.useState("whisper_http");
  const [busy, setBusy] = React.useState(false);
  React.useEffect(() => {
    api.get("/api/admin/owned-voice").then((d) => setMode(d.sttMode || "whisper_http")).catch(() => undefined);
  }, [api, tenantId]);
  const save = async () => {
    setBusy(true);
    try {
      await api.put("/api/admin/owned-voice", { sttMode: mode });
      toast.success("Owned voice stack updated");
    } catch (err) {
      toast.error("Couldn't update STT mode", { description: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card className="mt-4" testId="owned-voice-card">
      <CardHeader title="Owned voice stack" subtitle="Named STT presets only — no raw provider URLs. Telnyx can be platform-owned or tenant-owned (staff sets the key)." icon={Cpu} />
      <Field label="Speech-to-text">
        <select className="h-9 w-full border border-vl-border px-2 text-[13px]" value={mode} onChange={(e) => setMode(e.target.value)} data-testid="owned-stt-mode">
          <option value="whisper_http">Local Whisper</option>
          <option value="deepgram">Deepgram (cloud)</option>
          <option value="openai_whisper">OpenAI Whisper</option>
        </select>
      </Field>
      <Button className="mt-3" onClick={save} disabled={busy}>{busy ? "Saving…" : "Save STT mode"}</Button>
    </Card>
  );
}

const ChangeEmail = ({ api, currentEmail, onChanged }) => {
  const [form, setForm] = React.useState({ current: "", next: "", confirm: "" });
  const [busy, setBusy] = React.useState(false);
  const submit = async (e) => {
    e.preventDefault();
    if (form.next.trim().toLowerCase() !== form.confirm.trim().toLowerCase()) {
      toast.error("The two emails don't match");
      return;
    }
    setBusy(true);
    try {
      const res = await api.post("/api/owner/change-email", { currentPassword: form.current, newEmail: form.next.trim() });
      if (res && res.token) {
        portalStore.login({ token: res.token, tenantId: portalStore.getTenantId(), meta: portalStore.getMeta() });
      }
      toast.success("Sign-in email updated");
      setForm({ current: "", next: "", confirm: "" });
      if (onChanged) onChanged(res.email);
    } catch (err) {
      toast.error("Couldn't update email", { description: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card testId="change-email-card">
      <CardHeader title="Change email" subtitle={currentEmail ? `Currently ${currentEmail}` : "Used with your password to sign in."} icon={Mail} />
      <form onSubmit={submit} className="space-y-3">
        <Field label="Current password" htmlFor="email-cur">
          <Input id="email-cur" type="password" autoComplete="current-password" value={form.current} onChange={(e) => setForm((f) => ({ ...f, current: e.target.value }))} required data-testid="email-current-password" />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="New email" htmlFor="email-new">
            <Input id="email-new" type="email" autoComplete="email" value={form.next} onChange={(e) => setForm((f) => ({ ...f, next: e.target.value }))} required data-testid="email-new" />
          </Field>
          <Field label="Confirm email" htmlFor="email-conf">
            <Input id="email-conf" type="email" autoComplete="email" value={form.confirm} onChange={(e) => setForm((f) => ({ ...f, confirm: e.target.value }))} required data-testid="email-confirm" />
          </Field>
        </div>
        <div className="flex justify-end">
          <Button type="submit" variant="outline" disabled={busy} data-testid="email-submit">
            {busy ? "Updating…" : "Update email"}
          </Button>
        </div>
      </form>
    </Card>
  );
};

const ChangeSecret = ({ api, kind }) => {
  const isPw = kind === "password";
  const [form, setForm] = React.useState({ current: "", next: "", confirm: "" });
  const [busy, setBusy] = React.useState(false);
  const min = isPw ? 8 : 4;
  const submit = async (e) => {
    e.preventDefault();
    if (form.next.length < min) {
      toast.error(`${isPw ? "Password" : "Passcode"} must be at least ${min} characters`);
      return;
    }
    if (form.next !== form.confirm) {
      toast.error("The two entries don't match");
      return;
    }
    setBusy(true);
    try {
      if (isPw) await api.post("/api/owner/change-password", { currentPassword: form.current, newPassword: form.next });
      else await api.post("/api/owner/change-passcode", { currentPasscode: form.current, newPasscode: form.next });
      toast.success(`${isPw ? "Password" : "Passcode"} updated`);
      setForm({ current: "", next: "", confirm: "" });
    } catch (err) {
      toast.error(`Couldn't update ${kind}`, { description: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card testId={`change-${kind}-card`}>
      <CardHeader title={isPw ? "Change password" : "Change phone passcode"} subtitle={isPw ? "Used with your email to sign in." : "Used with your business number to sign in."} icon={isPw ? KeyRound : Hash} />
      <form onSubmit={submit} className="space-y-3">
        <Field label={`Current ${kind}`} htmlFor={`${kind}-cur`}>
          <Input id={`${kind}-cur`} type="password" autoComplete="current-password" value={form.current} onChange={(e) => setForm((f) => ({ ...f, current: e.target.value }))} required data-testid={`${kind}-current`} />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={`New ${kind}`} htmlFor={`${kind}-new`} hint={`At least ${min} characters`}>
            <Input id={`${kind}-new`} type="password" autoComplete="new-password" value={form.next} onChange={(e) => setForm((f) => ({ ...f, next: e.target.value }))} required data-testid={`${kind}-new`} />
          </Field>
          <Field label="Confirm" htmlFor={`${kind}-conf`}>
            <Input id={`${kind}-conf`} type="password" autoComplete="new-password" value={form.confirm} onChange={(e) => setForm((f) => ({ ...f, confirm: e.target.value }))} required data-testid={`${kind}-confirm`} />
          </Field>
        </div>
        <div className="flex justify-end">
          <Button type="submit" variant="outline" disabled={busy} data-testid={`${kind}-submit`}>
            {busy ? "Updating…" : `Update ${kind}`}
          </Button>
        </div>
      </form>
    </Card>
  );
};
