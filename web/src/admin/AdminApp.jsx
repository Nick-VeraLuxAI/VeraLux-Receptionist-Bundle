import React from "react";
import { Routes, Route, Navigate, useNavigate, useLocation } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createClient, ApiError } from "@/lib/api";
import { adminStore } from "@/lib/session";
import { useSync } from "@/lib/useSync";
import { AdminShell } from "./AdminShell";
import AdminLogin from "./pages/Login";
import Overview from "./pages/Overview";
import Tenants from "./pages/Tenants";
import TenantDetail from "./pages/TenantDetail";
import Numbers from "./pages/Numbers";
import Plans from "./pages/Plans";
import Receptionist from "./pages/Receptionist";
import Calls from "./pages/Calls";
import Leads from "./pages/Leads";
import Analytics from "./pages/Analytics";
import Workflows from "./pages/Workflows";
import Billing from "./pages/Billing";
import Audit from "./pages/Audit";
import ApiKeys from "./pages/ApiKeys";
import Settings from "./pages/Settings";
import Pipeline from "./pages/Pipeline";
import Rules from "./pages/Rules";
import Cutover from "./pages/Cutover";
import Approvals from "./pages/Approvals";
import OnCall from "./pages/OnCall";
import Digest from "./pages/Digest";
import Qa from "./pages/Qa";

const AdminCtx = React.createContext(null);
export const useAdmin = () => React.useContext(AdminCtx);

export default function AdminApp() {
  const [, force] = React.useReducer((x) => x + 1, 0);
  React.useEffect(() => adminStore.subscribe(force), []);
  const navigate = useNavigate();
  const location = useLocation();
  const [expired, setExpired] = React.useState(false);
  const queryClient = useQueryClient();
  // Derived tenant (e.g. auto-selected first tenant) is available synchronously via this ref,
  // so tenant-scoped requests never race the localStorage write.
  const tenantRef = React.useRef(null);

  // Every session boundary (login / logout / expiry) purges this app's cached queries so a new
  // user can never inherit another session's tenant list or capability probes.
  const purgeCache = React.useCallback(() => queryClient.removeQueries({ queryKey: ["admin"] }), [queryClient]);

  const api = React.useMemo(
    () =>
      createClient({
        getToken: adminStore.getToken,
        getTenantId: () => tenantRef.current || adminStore.getTenantId(),
        onUnauthorized: () => {
          if (adminStore.getToken()) {
            setExpired(true);
            adminStore.clear();
            purgeCache();
          }
        },
      }),
    [purgeCache],
  );
  const token = adminStore.getToken();
  const logout = React.useCallback(() => {
    adminStore.clear();
    purgeCache();
    navigate("/admin/login", { replace: true });
  }, [navigate, purgeCache]);

  if (!token) {
    return (
      <Routes>
        <Route
          path="login"
          element={
            <AdminLogin
              api={api}
              expired={expired}
              onLoggedIn={() => {
                purgeCache();
                setExpired(false);
              }}
            />
          }
        />
        <Route path="*" element={<Navigate to="/admin/login" replace state={{ from: location.pathname }} />} />
      </Routes>
    );
  }
  return <AuthedAdmin api={api} logout={logout} />;
}

/** Capability probe: use documented 403s to decide what to show. Never assumes a role. */
const probe = async (api, path) => {
  try {
    await api.get(path);
    return true;
  } catch (e) {
    if (e instanceof ApiError && e.isStaffOnly) return false;
    return true; // unknown failure -> let the page handle it
  }
};

const AuthedAdmin = ({ api, logout }) => {
  const tenantsQ = useQuery({ queryKey: ["admin", "tenants"], queryFn: () => api.get("/api/admin/tenants") });
  const tenants = (tenantsQ.data && tenantsQ.data.tenants) || [];
  const storedTenant = adminStore.getTenantId();
  const tenantId = storedTenant && tenants.some((t) => t.id === storedTenant) ? storedTenant : tenants[0] ? tenants[0].id : storedTenant || null;
  React.useEffect(() => {
    if (tenantId && tenantId !== storedTenant) adminStore.setTenantId(tenantId);
  }, [tenantId, storedTenant]);
  const tenant = tenants.find((t) => t.id === tenantId) || null;
  const setTenantId = React.useCallback((id) => adminStore.setTenantId(id), []);

  const capsQ = useQuery({
    queryKey: ["admin", "caps"],
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const [carrier, audit, keys] = await Promise.all([probe(api, "/api/admin/telnyx/status"), probe(api, "/api/admin/audit?limit=1"), probe(api, "/api/admin/auth/keys")]);
      return { carrier, audit, keys };
    },
  });
  const accountQ = useQuery({
    queryKey: ["admin", "account"],
    staleTime: 5 * 60_000,
    queryFn: () => api.get("/api/admin/account"),
  });
  const caps = capsQ.data || { carrier: null, audit: null, keys: null };
  const syncState = useSync({ api, tenantId, mode: "admin" });

  const value = React.useMemo(
    () => ({ api, tenants, tenantsQ, tenantId, tenant, setTenantId, caps, capsLoading: capsQ.isPending, account: accountQ.data, accountQ, logout, ...syncState }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [api, tenants, tenantsQ.dataUpdatedAt, tenantsQ.isPending, tenantId, tenant, caps, capsQ.isPending, accountQ.data, accountQ.dataUpdatedAt, logout, syncState.sync.state, syncState.sync.lastPublishedAt, syncState.health, syncState.healthOk],
  );

  return (
    <AdminCtx.Provider value={value}>
      <AdminShell>
        <Routes>
          <Route index element={<Overview />} />
          <Route path="login" element={<Navigate to="/admin" replace />} />
          <Route path="tenants" element={<Tenants />} />
          <Route path="tenants/:id" element={<TenantDetail />} />
          <Route path="numbers" element={<Numbers />} />
          <Route path="plans" element={<Plans />} />
          <Route path="receptionist" element={<Receptionist />} />
          <Route path="pipeline" element={<Pipeline />} />
          <Route path="rules" element={<Rules />} />
          <Route path="cutover" element={<Cutover />} />
          <Route path="approvals" element={<Approvals />} />
          <Route path="on-call" element={<OnCall />} />
          <Route path="digest" element={<Digest />} />
          <Route path="qa" element={<Qa />} />
          <Route path="calls" element={<Calls />} />
          <Route path="leads" element={<Leads />} />
          <Route path="analytics" element={<Analytics />} />
          <Route path="workflows" element={<Workflows />} />
          <Route path="billing" element={<Billing />} />
          <Route path="audit" element={<Audit />} />
          <Route path="api-keys" element={<ApiKeys />} />
          <Route path="settings" element={<Settings />} />
          <Route path="*" element={<Navigate to="/admin" replace />} />
        </Routes>
      </AdminShell>
    </AdminCtx.Provider>
  );
};
