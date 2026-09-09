/** Two independent session stores - the apps never share auth state. */
function makeStore(prefix) {
  const K = { token: `${prefix}_token`, tenant: `${prefix}_tenant_id`, meta: `${prefix}_meta` };
  const listeners = new Set();
  const notify = () => listeners.forEach((l) => l());
  return {
    keys: K,
    getToken: () => localStorage.getItem(K.token),
    getTenantId: () => localStorage.getItem(K.tenant),
    getMeta: () => {
      try {
        return JSON.parse(localStorage.getItem(K.meta) || "null");
      } catch (e) {
        return null;
      }
    },
    login: ({ token, tenantId, meta }) => {
      localStorage.setItem(K.token, token);
      if (tenantId) localStorage.setItem(K.tenant, tenantId);
      else localStorage.removeItem(K.tenant);
      if (meta) localStorage.setItem(K.meta, JSON.stringify(meta));
      notify();
    },
    setTenantId: (tenantId) => {
      if (tenantId) localStorage.setItem(K.tenant, tenantId);
      else localStorage.removeItem(K.tenant);
      notify();
    },
    setMeta: (meta) => {
      localStorage.setItem(K.meta, JSON.stringify(meta));
      notify();
    },
    clear: () => {
      Object.values(K).forEach((k) => localStorage.removeItem(k));
      notify();
    },
    subscribe: (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}

export const adminStore = makeStore("admin");
export const portalStore = makeStore("portal");
