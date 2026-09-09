/**
 * Control-plane API client.
 * Production: leave REACT_APP_CONTROL_PLANE_URL empty (same-origin fetch("/api/...")).
 * Dev: CRA setupProxy.js forwards /api to :4000.
 */
export const CONTROL_PLANE = String(
  process.env.REACT_APP_CONTROL_PLANE_URL || "",
).replace(/\/+$/, "");

export class ApiError extends Error {
  constructor(status, body, path) {
    super((body && body.error) || `HTTP ${status}`);
    this.name = "ApiError";
    this.status = status;
    this.body = body || {};
    this.code = this.body.error;
    this.details = this.body.details;
    this.path = path;
  }
  get isUnauthorized() {
    return this.status === 401;
  }
  get isFeatureGate() {
    return this.status === 403 && ["feature_not_enabled", "feature_denied_by_plan"].includes(this.code);
  }
  get isStaffOnly() {
    return this.status === 403 && ["carrier_admin_required", "superadmin_required", "admin_required", "read_only_role"].includes(this.code);
  }
  get isForbidden() {
    return this.status === 403;
  }
  get feature() {
    return (this.body && this.body.feature) || (this.details && this.details.feature);
  }
}

const MESSAGES = {
  invalid_credentials: "That email or password is not right.",
  session_expired: "Your session has expired. Please sign in again.",
  invalid_token: "Your session is no longer valid. Please sign in again.",
  missing_token: "Please sign in to continue.",
  tenant_forbidden: "You do not have access to that business.",
  tenant_required: "Select a tenant first.",
  read_only_role: "Your role is read-only.",
  admin_required: "This action is only available to VeraLux staff.",
  superadmin_required: "This action requires a VeraLux superadmin.",
  carrier_admin_required: "Carrier administration requires a VeraLux superadmin.",
  feature_not_enabled: "This feature is not included in the current plan.",
  feature_denied_by_plan: "This feature is not included in the current plan.",
  max_phone_numbers_exceeded: "This plan allows fewer phone numbers. Raise the limit first.",
  email_already_registered: "That email is already used by another login.",
  no_email_login: "Email login is not set up for this account yet.",
  email_required: "Enter a work email to use for sign-in.",
  email_or_password_required: "Enter a new email, a new password, or both.",
  current_password_required: "Enter your current password.",
  current_password_and_email_required: "Enter your current password and the new email.",
  console_login_not_configured: "Staff login is not configured on this server yet.",
  invalid_email: "Enter a valid email address.",
  runtime_config_missing: "The receptionist has not been published yet. Publish first.",
  invalid_phone_number: "Phone numbers must be in E.164 format, e.g. +15551234567.",
  invalid_did: "DID must be in E.164 format.",
  password_too_short: "Password must be at least 8 characters.",
  passcode_too_short: "Passcode must be at least 4 characters.",
  invalid_current_password: "The current password is incorrect.",
  invalid_current_passcode: "The current passcode is incorrect.",
  passcode_not_set: "No passcode is set for this account.",
  transcript_retention_required: "Transcript retention cannot be turned off.",
  owner_edit_disabled: "Workflow editing is managed by VeraLux for this account.",
  owner_rules_read_only: "Shop rules and hours are read-only on the owner portal.",
  owner_scope_forbidden: "This action is managed by VeraLux staff.",
  cutover_evidence_missing: "Run the corresponding test before marking this cutover item passed.",
  workflow_locked: "This workflow is locked by VeraLux.",
  billing_portal_disabled: "Billing self-service is not enabled for this account.",
  subscription_not_configured: "No subscription is configured yet.",
  number_already_owned: "That number is already in the account.",
  cloudflare_token_write_disabled: "Cloudflare token is managed by infrastructure and cannot be changed here.",
  validation_error: "Some fields are invalid.",
  tenant_not_found: "That tenant was not found.",
  default_tenant_protected: "The default tenant cannot be deleted.",
};

export function errorMessage(err, fallback = "Something went wrong. Please try again.") {
  if (!err) return fallback;
  if (err instanceof ApiError) {
    const base = MESSAGES[err.code] || (err.code ? err.code.replace(/_/g, " ") : `Request failed (${err.status})`);
    if (typeof err.details === "string") return `${base} ${err.details}`;
    return base;
  }
  if (err.message && /Failed to fetch|NetworkError/i.test(err.message)) return "Cannot reach the VeraLux control plane. Check your connection.";
  return err.message || fallback;
}

export function createClient({ getToken, getTenantId, onUnauthorized }) {
  async function request(method, path, { body, headers = {}, raw = false, form, tenantId } = {}) {
    const h = { Accept: "application/json", ...headers };
    const token = getToken && getToken();
    if (token) h.Authorization = `Bearer ${token}`;
    const tid = tenantId !== undefined ? tenantId : getTenantId && getTenantId();
    if (tid) h["X-Tenant-ID"] = tid;
    let payload;
    if (form) payload = form;
    else if (body !== undefined) {
      h["Content-Type"] = "application/json";
      payload = JSON.stringify(body);
    }
    const res = await fetch(`${CONTROL_PLANE}${path}`, { method, headers: h, body: payload });
    if (res.status === 401 && onUnauthorized) onUnauthorized();
    if (!res.ok) {
      let parsed = null;
      try {
        parsed = await res.json();
      } catch (e) {
        parsed = null;
      }
      throw new ApiError(res.status, parsed, path);
    }
    if (raw) return res;
    if (res.status === 204) return null;
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  }
  return {
    get: (p, o) => request("GET", p, o),
    post: (p, body, o) => request("POST", p, { ...(o || {}), body }),
    put: (p, body, o) => request("PUT", p, { ...(o || {}), body }),
    patch: (p, body, o) => request("PATCH", p, { ...(o || {}), body }),
    del: (p, o) => request("DELETE", p, o),
    upload: (p, form, o) => request("POST", p, { ...(o || {}), form }),
    raw: (p, o) => request("GET", p, { ...(o || {}), raw: true }),
    postRaw: (p, body, o) => request("POST", p, { ...(o || {}), body, raw: true }),
  };
}

/** Public (unauthenticated) client for login + branding. */
export const publicApi = createClient({ getToken: () => null, getTenantId: () => null });
