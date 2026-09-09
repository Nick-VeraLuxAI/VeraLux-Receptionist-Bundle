import React from "react";
import { Routes, Route, Navigate, useNavigate, useLocation } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createClient } from "@/lib/api";
import { portalStore } from "@/lib/session";
import { useSync } from "@/lib/useSync";
import { PortalShell } from "./PortalShell";
import PortalLogin from "./pages/Login";
import Overview from "./pages/Overview";
import Calls from "./pages/Calls";
import Leads from "./pages/Leads";
import Receptionist from "./pages/Receptionist";
import Hours from "./pages/Hours";
import Services from "./pages/Services";
import TransferLines from "./pages/TransferLines";
import QuickReplies from "./pages/QuickReplies";
import Workflows from "./pages/Workflows";
import Analytics from "./pages/Analytics";
import Billing from "./pages/Billing";
import Settings from "./pages/Settings";
import Rules from "./pages/Rules";
import Cutover from "./pages/Cutover";
import Approvals from "./pages/Approvals";
import OnCall from "./pages/OnCall";
import Digest from "./pages/Digest";
import Qa from "./pages/Qa";

const PortalCtx = React.createContext(null);
export const usePortal = () => React.useContext(PortalCtx);

export default function PortalApp() {
  const [, force] = React.useReducer((x) => x + 1, 0);
  React.useEffect(() => portalStore.subscribe(force), []);
  const navigate = useNavigate();
  const location = useLocation();
  const [expired, setExpired] = React.useState(false);
  const queryClient = useQueryClient();
  // Purge this app's cached queries at every session boundary so one owner never sees another's data.
  const purgeCache = React.useCallback(() => queryClient.removeQueries({ queryKey: ["portal"] }), [queryClient]);

  const api = React.useMemo(
    () =>
      createClient({
        getToken: portalStore.getToken,
        getTenantId: portalStore.getTenantId,
        onUnauthorized: () => {
          if (portalStore.getToken()) {
            setExpired(true);
            portalStore.clear();
            purgeCache();
          }
        },
      }),
    [purgeCache],
  );

  const token = portalStore.getToken();
  const tenantId = portalStore.getTenantId();
  const tenant = portalStore.getMeta();

  const logout = React.useCallback(() => {
    portalStore.clear();
    purgeCache();
    navigate("/portal/login", { replace: true });
  }, [navigate, purgeCache]);

  if (!token || !tenantId) {
    return (
      <Routes>
        <Route
          path="login"
          element={
            <PortalLogin
              api={api}
              expired={expired}
              onLoggedIn={() => {
                purgeCache();
                setExpired(false);
              }}
            />
          }
        />
        <Route path="*" element={<Navigate to={`/portal/login${location.search}`} replace state={{ from: location.pathname }} />} />
      </Routes>
    );
  }
  return <AuthedPortal api={api} tenantId={tenantId} tenant={tenant} logout={logout} />;
}

const AuthedPortal = ({ api, tenantId, tenant, logout }) => {
  const syncState = useSync({ api, tenantId, mode: "portal" });
  const limitsQ = useQuery({ queryKey: ["portal", "limits", tenantId], queryFn: () => api.get(`/api/admin/tenants/${tenantId}/limits`) });
  const limits = limitsQ.data ? limitsQ.data.limits : null;
  const has = (flag) => (limitsQ.isError ? true : limits ? !!limits[flag] : null); // null = unknown (loading)

  const value = React.useMemo(
    () => ({ api, tenantId, tenant: tenant || { id: tenantId, name: tenantId, numbers: [] }, limits, limitsLoading: limitsQ.isPending, has, logout, ...syncState }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [api, tenantId, tenant, limits, limitsQ.isPending, limitsQ.isError, logout, syncState.sync.state, syncState.sync.lastPublishedAt, syncState.health, syncState.healthOk],
  );

  return (
    <PortalCtx.Provider value={value}>
      <PortalShell>
        <Routes>
          <Route index element={<Overview />} />
          <Route path="login" element={<Navigate to="/portal" replace />} />
          <Route path="calls" element={<Calls />} />
          <Route path="leads" element={<Leads />} />
          <Route path="receptionist" element={<Receptionist />} />
          <Route path="hours" element={<Hours />} />
          <Route path="rules" element={<Rules />} />
          <Route path="cutover" element={<Cutover />} />
          <Route path="approvals" element={<Approvals />} />
          <Route path="on-call" element={<OnCall />} />
          <Route path="digest" element={<Digest />} />
          <Route path="qa" element={<Qa />} />
          <Route path="services" element={<Services />} />
          <Route path="transfer-lines" element={<TransferLines />} />
          <Route path="quick-replies" element={<QuickReplies />} />
          <Route path="workflows" element={<Workflows />} />
          <Route path="analytics" element={<Analytics />} />
          <Route path="billing" element={<Billing />} />
          <Route path="settings" element={<Settings />} />
          <Route path="*" element={<Navigate to="/portal" replace />} />
        </Routes>
      </PortalShell>
    </PortalCtx.Provider>
  );
};
