import React from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { ArrowRight, Loader2, AlertCircle, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field, InlineNote } from "@/components/vl/Cards";
import { BrandLockup } from "@/components/vl/Logo";
import { adminStore } from "@/lib/session";
import { errorMessage } from "@/lib/api";

export default function AdminLogin({ api, expired, onLoggedIn }) {
  const navigate = useNavigate();
  const location = useLocation();
  const [form, setForm] = React.useState({ email: "", password: "" });
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState(null);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api.post("/api/admin/login", { email: form.email.trim(), password: form.password });
      // Reset any prior session state before persisting the new token
      onLoggedIn && onLoggedIn();
      adminStore.login({ token: res.token, tenantId: adminStore.getTenantId(), meta: { email: form.email.trim() } });
      const to = location.state && location.state.from && location.state.from !== "/admin/login" ? location.state.from : "/admin";
      navigate(to, { replace: true });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="vl-app-grid min-h-screen bg-vl-canvas flex items-center justify-center p-6" data-testid="admin-login-page">
      <div className="w-full max-w-[440px]">
        <div className="mb-7 flex items-center justify-between">
          <BrandLockup variant="admin" size={36} />
          <span className="inline-flex items-center gap-1.5 rounded-[2px] border border-vl-text bg-vl-text px-2.5 py-1 font-mono text-[9px] font-semibold uppercase tracking-[0.08em] text-white">
            <ShieldCheck className="h-3.5 w-3.5" aria-hidden="true" /> Staff only
          </span>
        </div>
        <div className="vl-login-card p-7 sm:p-9">
          <div className="vl-eyebrow mb-3">Internal operations</div>
          <h1 className="font-serif text-[32px] leading-[1.1] tracking-[-0.02em]">Platform sign in</h1>
          <p className="mt-2 text-[13px] text-vl-secondary">Multi-tenant operations console for VeraLux staff.</p>
          {expired ? (
            <InlineNote tone="warning" icon={AlertCircle} className="mt-5" testId="session-expired-banner">
              Your session expired. Please sign in again.
            </InlineNote>
          ) : null}
          <form onSubmit={submit} className="mt-6 space-y-4" data-testid="admin-login-form">
            <Field label="Work email" htmlFor="a-email">
              <Input id="a-email" type="email" autoComplete="username" required value={form.email} onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))} className="h-11" data-testid="admin-login-email" />
            </Field>
            <Field label="Password" htmlFor="a-pass">
              <Input id="a-pass" type="password" autoComplete="current-password" required value={form.password} onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))} className="h-11" data-testid="admin-login-password" />
            </Field>
            {error ? (
              <InlineNote tone="danger" icon={AlertCircle} testId="admin-login-error">
                {error}
              </InlineNote>
            ) : null}
            <Button type="submit" className="h-11 w-full" disabled={busy} data-testid="admin-login-submit-button">
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null} Sign in <ArrowRight className="h-4 w-4" />
            </Button>
          </form>
        </div>
        <p className="mt-5 text-center vl-meta">
          Looking for your business portal? <a href="/portal/login" className="font-medium text-vl-gold-deep underline decoration-vl-gold/40 underline-offset-4">Sign in to the customer portal</a>
        </p>
      </div>
    </main>
  );
}
