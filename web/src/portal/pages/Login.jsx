import React from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { toast } from "sonner";
import { Mail, Phone, ArrowRight, Loader2, AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field, InlineNote } from "@/components/vl/Cards";
import { BrandLockup } from "@/components/vl/Logo";
import { portalStore } from "@/lib/session";
import { errorMessage } from "@/lib/api";
import { cn } from "@/lib/utils";

export default function PortalLogin({ api, expired, onLoggedIn }) {
  const navigate = useNavigate();
  const location = useLocation();
  const [method, setMethod] = React.useState("email");
  const [form, setForm] = React.useState({ email: "", password: "", phone: "", passcode: "" });
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState(null);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const body = method === "email" ? { email: form.email.trim(), password: form.password } : { phone: form.phone.trim(), passcode: form.passcode };
      const res = await api.post("/api/owner/login", body);
      // Reset any prior session state before persisting the new token
      onLoggedIn && onLoggedIn();
      portalStore.login({ token: res.token, tenantId: res.tenant.id, meta: res.tenant });
      toast.success(`Welcome back, ${res.tenant.name}`);
      const to = location.state && location.state.from && location.state.from !== "/portal/login" ? location.state.from : "/portal";
      navigate(to, { replace: true });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="min-h-screen bg-vl-canvas grid lg:grid-cols-[1.1fr_1fr]" data-testid="portal-login-page">
      <section className="vl-brand-panel hidden lg:flex flex-col justify-between p-12 border-r border-vl-border">
        <div className="relative">
          <BrandLockup variant="portal" size={36} />
        </div>
        <div className="relative max-w-md">
          <div className="vl-eyebrow mb-3">Your AI receptionist</div>
          <h1 className="vl-serif text-[46px] leading-[1.04] tracking-[-0.025em]">Every call answered.<br />Every next step taken.</h1>
          <p className="mt-5 max-w-[430px] text-[15px] leading-7 text-vl-secondary">Check on your receptionist, review the conversations it handled, and tune how it speaks for your business.</p>
        </div>
        <div className="relative font-mono text-[9px] uppercase tracking-[0.14em] text-vl-muted">Request · Understand · Decide · Act</div>
      </section>

      <section className="vl-app-grid flex items-center justify-center p-6 sm:p-12">
        <div className="w-full max-w-[420px]">
          <div className="lg:hidden mb-9">
            <BrandLockup variant="portal" size={34} />
          </div>
          <div className="vl-eyebrow mb-3">Business portal</div>
          <h2 className="vl-serif text-[38px] leading-[1.08] tracking-[-0.02em]">Sign in to your portal</h2>
          <p className="mt-2 text-[14px] text-vl-secondary">Use the login your VeraLux contact set up for your business.</p>
          {new URLSearchParams(location.search).get("from") === "admin" || new URLSearchParams(location.search).get("welcome") === "1" ? (
            <InlineNote className="mt-4" testId="admin-handoff-banner">
              Your VeraLux contact just set up this portal. Sign in with the email and password they sent you.
            </InlineNote>
          ) : null}

          {expired ? (
            <InlineNote tone="warning" icon={AlertCircle} className="mt-5" testId="session-expired-banner">
              Your session expired. Please sign in again.
            </InlineNote>
          ) : null}

          <div className="mt-7 inline-flex rounded-[3px] border border-vl-border bg-vl-warm p-1" role="tablist" aria-label="Sign-in method">
            {[
              ["email", "Email", Mail],
              ["phone", "Phone & passcode", Phone],
            ].map(([id, label, Icon]) => (
              <button key={id} type="button" role="tab" aria-selected={method === id} onClick={() => setMethod(id)} className={cn("inline-flex items-center gap-1.5 rounded-[2px] px-3.5 py-1.5 text-[13px] font-medium transition-colors", method === id ? "bg-white border border-vl-border shadow-xs" : "border border-transparent text-vl-secondary hover:text-vl-text")} data-testid={`portal-login-method-${id}`}>
                <Icon className="h-3.5 w-3.5" aria-hidden="true" /> {label}
              </button>
            ))}
          </div>

          <form onSubmit={submit} className="mt-5 space-y-4" data-testid="portal-login-form">
            {method === "email" ? (
              <>
                <Field label="Email" htmlFor="email">
                  <Input id="email" type="email" autoComplete="username" required value={form.email} onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))} className="h-11 bg-white" data-testid="portal-login-email" />
                </Field>
                <Field label="Password" htmlFor="password">
                  <Input id="password" type="password" autoComplete="current-password" required value={form.password} onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))} className="h-11 bg-white" data-testid="portal-login-password" />
                </Field>
              </>
            ) : (
              <>
                <Field label="Business phone number" htmlFor="phone" hint="The number your receptionist answers, e.g. +15125550142">
                  <Input id="phone" type="tel" required value={form.phone} onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))} placeholder="+1…" className="h-11 bg-white" data-testid="portal-login-phone" />
                </Field>
                <Field label="Passcode" htmlFor="passcode">
                  <Input id="passcode" type="password" inputMode="numeric" required value={form.passcode} onChange={(e) => setForm((f) => ({ ...f, passcode: e.target.value }))} className="h-11 bg-white" data-testid="portal-login-passcode" />
                </Field>
              </>
            )}
            {error ? (
              <InlineNote tone="danger" icon={AlertCircle} testId="portal-login-error">
                {error}
              </InlineNote>
            ) : null}
            <Button type="submit" className="h-11 w-full text-[14px]" disabled={busy} data-testid="portal-login-submit-button">
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null} Sign in <ArrowRight className="h-4 w-4" />
            </Button>
          </form>
          <p className="mt-6 vl-meta">Forgot your login? Contact your VeraLux representative to reset it.</p>
        </div>
      </section>
    </main>
  );
}
