import React from "react";
import { BrowserRouter, Routes, Route, Link, Navigate } from "react-router-dom";
import { Toaster } from "@/components/ui/sonner";
import { ArrowRight, Building2, ShieldCheck } from "lucide-react";
import { VMark, Wordmark } from "@/components/vl/Logo";
import PortalApp from "@/portal/PortalApp";
import AdminApp from "@/admin/AdminApp";
import { BrandingProvider } from "@/lib/branding";
import "@/App.css";

/** Root chooser: two distinct products, two entry points. */
const Chooser = () => (
  <main className="vl-app-grid min-h-screen bg-vl-canvas flex flex-col" data-testid="root-chooser">
    <header className="vl-glass-bar flex h-[68px] items-center gap-3 border-b border-vl-border px-6">
      <VMark size={30} />
      <Wordmark />
    </header>
    <div className="flex-1 flex items-center justify-center px-6 pb-16">
      <div className="w-full max-w-3xl">
        <div className="vl-eyebrow mb-3">AI systems that complete the next step</div>
        <h1 className="vl-page-title mb-3">Where would you like to go?</h1>
        <p className="text-[15px] text-vl-secondary mb-8 max-w-xl">VeraLux runs two separate applications: a customer portal for business owners and an internal platform console for VeraLux staff.</p>
        <div className="grid gap-4 sm:grid-cols-2">
          <Link to="/portal" className="vl-card p-6 group transition-all hover:-translate-y-px hover:border-vl-border-strong hover:shadow-vl focus-visible:outline-none" data-testid="chooser-portal-link">
            <div className="vl-icon-circle mb-4">
              <Building2 className="h-5 w-5" aria-hidden="true" />
            </div>
            <h2 className="font-serif text-[22px]">Customer Portal</h2>
            <p className="mt-1 text-[13px] text-vl-secondary">For business owners. Check on your AI receptionist, review calls and leads, and fine-tune how it answers.</p>
            <span className="mt-5 inline-flex items-center gap-1.5 text-[13px] font-medium text-vl-gold-deep">
              Open portal <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" aria-hidden="true" />
            </span>
          </Link>
          <Link to="/admin" className="vl-card p-6 group transition-all hover:-translate-y-px hover:border-vl-border-strong hover:shadow-vl focus-visible:outline-none" data-testid="chooser-admin-link">
            <div className="mb-4 inline-flex h-11 w-11 items-center justify-center rounded-full bg-vl-warm text-vl-text">
              <ShieldCheck className="h-5 w-5" aria-hidden="true" />
            </div>
            <h2 className="font-serif text-[22px]">VeraLux Platform</h2>
            <p className="mt-1 text-[13px] text-vl-secondary">Internal console for VeraLux staff. Multi-tenant operations, numbers, plans, billing and support.</p>
            <span className="mt-5 inline-flex items-center gap-1.5 text-[13px] font-medium text-vl-text">
              Staff sign in <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" aria-hidden="true" />
            </span>
          </Link>
        </div>
      </div>
    </div>
  </main>
);

export default function App() {
  return (
    <div className="App">
      <BrowserRouter>
        <BrandingProvider>
          <Routes>
            <Route path="/" element={<Chooser />} />
            <Route path="/portal/*" element={<PortalApp />} />
            <Route path="/admin/*" element={<AdminApp />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </BrandingProvider>
        <Toaster
          position="bottom-right"
          closeButton
          visibleToasts={3}
          toastOptions={{
            style: { fontFamily: "var(--vl-font-sans)" },
            classNames: {
              toast: "vl-toast",
              success: "vl-toast-success",
              error: "vl-toast-error",
              warning: "vl-toast-warning",
              info: "vl-toast-info",
            },
          }}
        />
      </BrowserRouter>
    </div>
  );
}
