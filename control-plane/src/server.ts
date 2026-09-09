import "./env";
import "express-async-errors";
import { startVeraluxOsReporting } from "./veraluxOsReporter";
import express, { type Request, type Response, type NextFunction } from "express";
import { randomUUID } from "crypto";
import dotenv from "dotenv";
import { createServer, type AddressInfo } from "net";
import path from "path";
import fs from "fs";
import multer from "multer";
import { z } from "zod";
import {
  requestIdMiddleware,
  requestTimeout,
  globalErrorHandler,
  asyncHandler,
  logger,
  getRequestId,
  validateBody,
  createApiError,
  requestLogger,
  commonSchemas,
} from "./middleware";
import {
  normalizeE164,
  parseRuntimeTenantConfig,
  quickReplyIntentSchema,
  type RuntimeTenantConfig,
} from "./runtime/runtimeContract";
import {
  businessHoursSchema,
  evaluateBusinessHours,
  redactPublishedRuntimeConfig,
  redactHttpUrlToPlaceholder,
  hasUsableApiKey,
} from "@veralux/shared";
import {
  assertRuntimeRedisConfigured,
  getTenantConfig,
  healthcheckRedis,
  publishTenantConfig,
  unpublishTenantConfig,
  unmapDid,
  closeRuntimeRedis,
} from "./runtime/runtimePublisher";
import {
  buildTenantRuntimeConfig,
  BuildRuntimeConfigError,
} from "./runtime/buildTenantRuntimeConfig";
import {
  type LLMProvider,
  type TTSConfig,
  type VoicePreset,
  type PromptConfig,
  type SafeTtsPublicConfig,
  coerceKokoroVoiceId,
} from "./config";
import { getCustomerBrandingPayload } from "./customerBranding";
import { applyPreviewOverrides, resolvePreviewText, synthesizeTtsPreview } from "./ttsPreview";
import { createPreviewJob, pollPreviewJob } from "./ttsPreviewJobs";
import { tenants, DEFAULT_TENANT_ID, type TenantContext } from "./tenants";
import {
  authenticateAdminKey,
  createAdminKey,
  listAdminKeySummaries,
  revokeAdminKey,
  recordAudit,
  type AdminRole,
} from "./auth";
import { secretStore } from "./secretStore";
import {
  listAuditLogs,
  upsertUserBySub,
  listMembershipsForUser,
  closePool,
  pingPool,
  getSubscription,
  upsertSubscription,
  pool as dbPool,
  addTenantNumberIfMissing,
  findTenantIdByInboundNumberE164,
  getTenantNumbers,
  setTenantNumbers,
  getOwnerPasscodeHash,
  getTenantIdByPortalEmail,
  getOwnerPortalCredentialRow,
  upsertOwnerPortalCredentials,
  getTenantLimits,
  upsertTenantLimits,
  resetTenantLimitsToPlanDefaults,
  applyPlanTierDefaultsKeepingService,
  setTenantBillingStatus,
  getTenantUsageSnapshot,
  getTenantBillingSummary,
  recordTenantCallStarted,
  recordTenantCallEnded,
  listCallsForTenantDb,
  getCallByIdForTenantDb,
  findCallByVoiceControlId,
  findOpenGreetingCall,
  upsertCallRowMerge,
  getTenantCallQualitySettings,
  updateTenantCallQualitySettings,
  consumeTenantNextCallDiagnostics,
  upsertCallQualitySummary,
  getCallQualitySummaryForCall,
  expireStaleRawAudioDiagnostics,
  type TenantCallQualitySettingsRow,
} from "./db";
import { getCallAnalyticsPayloadForTenant } from "./callAnalyticsFromDb";
import {
  trySyncTenantRuntimeConfigForLimits,
  autoPublishTenantRuntimeAfterSave,
  syncTenantRuntimeConfigForLimits,
} from "./tenantRuntimePublish";
import {
  maskCallerId,
  summarizeHistory,
  isMissedCallRow,
  normalizeHistoryForAdminUi,
  presentAdminCall,
  dedupeCallHistoryRows,
} from "./callSanitizer";
import { rateLimit } from "./rateLimit";
import { ipRateLimit } from "./middleware/ipRateLimit";
import { closeRedis as closeRateLimitRedis } from "./redis";
import { normalizePhoneNumber } from "./utils/phone";
import { isUuid } from "./utils/validation";
import { parsePricingInfo, createForwardingProfile } from "./llmContext";
import {
  tenantLimitsSchema,
  planTierSchema,
  billingStatusSchema,
  getPlanDefaults,
  listPlanDefaultsPayload,
  RECOMMENDED_DEFAULT_PLAN_TIER,
} from "./planLimits";
import { checkFeatureEntitlement, type FeatureKey } from "./featureEntitlements";
import {
  verifyOwnerPasscode,
  setOwnerPasscode,
  issueOwnerJwt,
  issueInstallerConsoleJwt,
  verifyOwnerPortalToken,
  changeOwnerPasscodeIfValid,
  changeOwnerPortalPasswordIfValid,
  changeOwnerPortalEmailIfValid,
} from "./ownerAuth";
import {
  timingSafeTextEqual,
  getInstallerUsername,
  getInstallerPassword,
  verifyConsoleLogin,
  describeConsoleAccount,
  changeConsoleCredentials,
} from "./consoleAuth";
import { registerTenantLlmRoutes } from "./tenantLlmHandlers";
import { registerPipelineRoutes } from "./cloud/pipelineHandlers";
import { registerNightDeskRoutes } from "./nightDesk/handlers";
import { startMorningDigestLoop, stopMorningDigestLoop } from "./nightDesk/digest";
import {
  startOncallFallbackLoop,
  stopOncallFallbackLoop,
} from "./nightDesk/oncallWorker";
import { getShopPlaybookRow, upsertCutoverItem } from "./nightDesk/db";
import { startPriceRefreshLoop, stopPriceRefreshLoop } from "./cloud/pricing/refresh";
import {
  hashPortalPassword,
  verifyPortalPassword,
  normalizePortalEmail,
  isValidPortalEmailShape,
  PORTAL_PASSWORD_MIN_LEN,
  PORTAL_PASSWORD_MAX_LEN,
} from "./portalPassword";
import {
  isStripeConfigured,
  isStripeLiveMode,
  createCheckoutSession,
  createPortalSession,
  handleStripeWebhook,
  listStripePlans,
  createStaffSubscription,
  cancelStaffSubscription,
  syncTenantBillingFromStripe,
  serializeSubscriptionPayload,
  webhookPublicUrl,
} from "./stripe";
import {
  initAutomationEngine,
  shutdownAutomationEngine,
  handleCallEnded,
  handleJobCompleted,
  dryRunPipeline,
  listWorkflows,
  getWorkflow,
  createWorkflow,
  updateWorkflow,
  deleteWorkflow,
  listRuns,
  listLeads,
  presentLead,
  deleteLead,
  getWorkflowSettings,
  updateWorkflowSettings,
  ensureTenantWorkflows,
  enableWorkflowTemplate,
  galleryPayload,
  type CallEndedEvent,
} from "./automations";
import {
  quickRepliesSuggestBodySchema,
  suggestQuickRepliesWithOpenAI,
} from "./quickRepliesSuggest";

dotenv.config();

// ✅ Put these early so crashes are visible even during startup
process.on("unhandledRejection", (reason) => {
  console.error("UNHANDLED REJECTION:", reason);
});
process.on("uncaughtException", (err) => {
  console.error("UNCAUGHT EXCEPTION:", err);
});

const app = express();

/** HTML/CSS shells are not fingerprinted; tell browsers and CDNs (e.g. Cloudflare) not to cache them. */
function applyAdminShellCachePolicy(res: Response): void {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  res.setHeader("CDN-Cache-Control", "no-store");
  res.setHeader("Surrogate-Control", "no-store");
}

function isSpaShellPath(p: string): boolean {
  return (
    p === "/admin" ||
    p === "/admin/" ||
    (p.startsWith("/admin/") && !p.startsWith("/admin-legacy")) ||
    p === "/portal" ||
    p === "/portal/" ||
    (p.startsWith("/portal/") && !p.startsWith("/portal-legacy"))
  );
}

function noStoreAdminUiShell(req: Request, res: Response, next: NextFunction) {
  const p = req.path;
  const staticShells = new Set([
    "/admin-neural.css",
    "/admin.html",
    "/owner.html",
    "/portal.html",
    "/admin-legacy",
    "/admin-legacy/",
    "/portal-legacy",
    "/portal-legacy/",
    "/app/index.html",
  ]);
  if (
    staticShells.has(p) ||
    isSpaShellPath(p) ||
    p === "/owner" ||
    p === "/owner/"
  ) {
    applyAdminShellCachePolicy(res);
  }
  next();
}
app.use(noStoreAdminUiShell);

app.use(
  express.json({
    limit: "10mb",
    // NOTE: keep verify so HMAC uses raw bytes
    verify: (req, _res, buf) => {
      (req as any).rawBody = buf;
    },
  })
);
/** Canonical URLs; `*.html` bookmarks redirect (must be before `express.static`). */
app.get("/portal.html", (req, res) => {
  const q = req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : "";
  res.redirect(301, "/portal" + q);
});
app.get("/admin.html", (req, res) => {
  const q = req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : "";
  res.redirect(301, "/admin" + q);
});
app.get("/owner.html", (req, res) => {
  const q = req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : "";
  res.redirect(301, "/owner" + q);
});

/** Public JSON for operator branding (BRAND_* env) — used by apply-branding.js on static shells. */
app.get("/api/branding", (_req, res) => {
  res.json(getCustomerBrandingPayload());
});

app.use(express.static("public"));

// ────────────────────────────────────────────────
// Production Middleware (request ID, timeout, logging)
// ────────────────────────────────────────────────
app.use(requestIdMiddleware);
app.use(
  requestTimeout(undefined, {
    skip: (req) => req.originalUrl.includes("/api/tts/preview/async"),
  })
);
app.use(requestLogger);

// ────────────────────────────────────────────────
// Voice Recording Upload Configuration
// ────────────────────────────────────────────────
const VOICE_RECORDINGS_DIR = process.env.VOICE_RECORDINGS_DIR || path.join(__dirname, "..", "public", "voice-recordings");

// Ensure voice recordings directory exists
if (!fs.existsSync(VOICE_RECORDINGS_DIR)) {
  fs.mkdirSync(VOICE_RECORDINGS_DIR, { recursive: true });
}

const voiceRecordingStorage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, VOICE_RECORDINGS_DIR);
  },
  filename: (_req, file, cb) => {
    const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
    const ext = path.extname(file.originalname) || ".wav";
    cb(null, `voice-clone-${uniqueSuffix}${ext}`);
  },
});

const VOICE_RECORDING_MAX_SIZE_MB = parseInt(process.env.VOICE_RECORDING_MAX_SIZE_MB || "10", 10);

const voiceRecordingUpload = multer({
  storage: voiceRecordingStorage,
  limits: {
    fileSize: VOICE_RECORDING_MAX_SIZE_MB * 1024 * 1024,
  },
  fileFilter: (_req, file, cb) => {
    // Accept WAV files
    if (file.mimetype === "audio/wav" || file.mimetype === "audio/wave" || file.originalname.endsWith(".wav")) {
      cb(null, true);
    } else {
      cb(new Error("Only WAV files are allowed"));
    }
  },
});

// ────────────────────────────────────────────────
// Cognito OAuth helpers (login + callback)
// ────────────────────────────────────────────────

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

app.get("/oauth/login", (_req, res) => {
  const COGNITO_DOMAIN = requireEnv("COGNITO_DOMAIN");
  const COGNITO_CLIENT_ID = requireEnv("COGNITO_CLIENT_ID");
  const COGNITO_REDIRECT_URI = requireEnv("COGNITO_REDIRECT_URI");

  const params = new URLSearchParams({
    client_id: COGNITO_CLIENT_ID,
    response_type: "code",
    scope: "openid email phone",
    redirect_uri: COGNITO_REDIRECT_URI,
  });

  return res.redirect(`${COGNITO_DOMAIN}/login?${params.toString()}`);
});

app.get("/oauth/callback", async (req, res) => {
  const code = typeof req.query.code === "string" ? req.query.code : undefined;
  if (!code) return res.status(400).send("Missing code");

  const COGNITO_DOMAIN = requireEnv("COGNITO_DOMAIN");
  const COGNITO_CLIENT_ID = requireEnv("COGNITO_CLIENT_ID");
  const COGNITO_REDIRECT_URI = requireEnv("COGNITO_REDIRECT_URI");

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: COGNITO_CLIENT_ID,
    code,
    redirect_uri: COGNITO_REDIRECT_URI,
  });

  // If your Cognito app client has a secret, uncomment this:
  // const secret = process.env.COGNITO_CLIENT_SECRET;
  // if (secret) body.append("client_secret", secret);

  const tokenRes = await fetch(`${COGNITO_DOMAIN}/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  const payload = await tokenRes.json();

  if (!tokenRes.ok) {
    console.error("Cognito token exchange failed:", payload);
    return res.status(401).json(payload);
  }

  // DEV MVP: show tokens so you can copy id_token into Authorization header.
  // NEXT: store in httpOnly cookie and/or mint your own ADMIN JWT.
    const idToken = payload?.id_token;
  if (!idToken || typeof idToken !== "string") {
    console.error("Cognito token exchange returned no id_token:", payload);
    return res.status(500).send("Missing id_token from Cognito");
  }

  // Store the Cognito JWT so the browser can present it on subsequent requests.
  res.cookie("admin_jwt", idToken, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 1000, // 60 minutes
  });

  return res.redirect("/admin");

});


app.get("/", (req, res) => {
  const host = String(req.get("x-forwarded-host") || req.get("host") || "")
    .split(",")[0]
    .trim()
    .toLowerCase();
  if (host.startsWith("portal.")) {
    return res.redirect("/portal");
  }
  return res.redirect("/admin");
});

interface AuthedRequest extends Request {
  ctx?: RequestContext;
}

interface RequestContext {
  authType: "jwt" | "adminKey";
  idpSub?: string;
  email?: string;
  userId?: string;
  tenantId?: string;
  /**
   * All tenant ids the JWT principal is a member of. Used to scope multi-tenant
   * read endpoints (e.g. GET /api/admin/tenants) for non-superadmin users.
   * Undefined / empty for superadmin (treat as "all tenants").
   */
  tenantIds?: string[];
  isSuperAdmin: boolean;
  role: "superadmin" | "tenant-admin" | "tenant-viewer";
  ownerConsole?: boolean;
}

function parseBooleanish(
  value: string | undefined,
  defaultValue: boolean
): boolean {
  if (typeof value !== "string") return defaultValue;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on", "required"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return defaultValue;
}

const IS_PROD = process.env.NODE_ENV === "production";

const ENABLE_RUNTIME_ADMIN = parseBooleanish(
  process.env.ENABLE_RUNTIME_ADMIN,
  true
);
const ALLOW_RUNTIME_SECRET_READ = parseBooleanish(
  process.env.ALLOW_RUNTIME_SECRET_READ,
  !IS_PROD
);

const OPENAI_KEY_RE = /^sk-[A-Za-z0-9-_]{10,}$/;

/* ────────────────────────────────────────────────
   ✅ Admin hardening + CORS allowlist
   ──────────────────────────────────────────────── */

const ADMIN_AUTH_MODE = (
  process.env.ADMIN_AUTH_MODE ||
  (IS_PROD ? "jwt-only" : "hybrid")
).toLowerCase();
// hybrid = allow x-admin-key OR bearer
// jwt-only = only bearer JWT (block x-admin-key) unless explicitly allowed

const ALLOW_ADMIN_API_KEY_IN_PROD = parseBooleanish(
  process.env.ALLOW_ADMIN_API_KEY_IN_PROD,
  false
);

const ADMIN_ALLOWED_ORIGINS = (process.env.ADMIN_ALLOWED_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

function isAllowedOrigin(origin?: string): boolean {
  // In production without an origin header, log a warning but allow for backward compatibility
  // This allows server-to-server calls (e.g., from runtime) that don't set Origin
  if (!origin) {
    if (IS_PROD && process.env.REQUIRE_CORS_ORIGIN === "true") {
      return false;
    }
    return true;
  }
  if (!ADMIN_ALLOWED_ORIGINS.length) return !IS_PROD; // prod requires allowlist
  return ADMIN_ALLOWED_ORIGINS.includes(origin);
}

/** Browser Origin matches this request's Host (and scheme via X-Forwarded-Proto or TLS). */
function isSameOriginAsHost(req: Request, origin: string): boolean {
  const host = req.get("host");
  if (!host) return false;
  let scheme = (req.get("x-forwarded-proto") || "").split(",")[0].trim().toLowerCase();
  if (!scheme) scheme = req.secure ? "https" : "http";
  try {
    const o = new URL(origin);
    if (o.host !== host) return false;
    const oScheme = o.protocol.replace(":", "").toLowerCase();
    return oScheme === scheme;
  } catch {
    return false;
  }
}

function adminCorsGuard(req: Request, res: Response, next: NextFunction) {
  const origin = typeof req.headers.origin === "string" ? req.headers.origin : undefined;

  const originAllowedByList = isAllowedOrigin(origin);
  const originSameHost = !!origin && isSameOriginAsHost(req, origin);
  const originOk = originAllowedByList || originSameHost;

  // Log warning for requests without Origin in production
  if (IS_PROD && !origin && req.path.startsWith("/api/admin")) {
    logger.warn("Admin API request without Origin header", {
      requestId: getRequestId(req),
      path: req.path,
      ip: req.ip,
    });
  }

  if (IS_PROD && !originOk) {
    logger.warn("CORS origin rejected", {
      requestId: getRequestId(req),
      origin: origin || "none",
      path: req.path,
    });
    return res.status(403).json({ error: "origin_not_allowed" });
  }

  if (origin && originOk) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader(
      "Access-Control-Allow-Headers",
      "authorization,content-type,x-admin-key,x-tenant-id,x-active-tenant"
    );
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
  }

  if (req.method === "OPTIONS") return res.status(204).end();
  return next();
}

function getAdminToken(req: Request): string | undefined {
  const auth = req.headers.authorization;
  const bearer =
    typeof auth === "string" && auth.toLowerCase().startsWith("bearer ")
      ? auth.slice(7).trim()
      : undefined;

  const header = req.headers["x-admin-key"];
  const xAdminKey =
    typeof header === "string"
      ? header.trim()
      : Array.isArray(header) && header[0]
      ? header[0].trim()
      : undefined;

  // ✅ PROD default: jwt-only (no x-admin-key) unless explicitly allowed
  if (IS_PROD && ADMIN_AUTH_MODE === "jwt-only" && !ALLOW_ADMIN_API_KEY_IN_PROD) {
    return bearer;
  }

  // Hybrid/dev: allow x-admin-key first, then bearer
  if (xAdminKey) return xAdminKey;
  if (bearer) return bearer;
  return undefined;
}

function ownerConsoleWriteAllowed(req: Request): boolean {
  const path = req.path;
  const method = req.method.toUpperCase();
  if (path.startsWith("/api/owner/")) return true;
  if (method === "POST" && path === "/api/admin/prompts") return true;
  if (method === "POST" && path === "/api/admin/pricing") return true;
  if (method === "POST" && path === "/api/admin/forwarding-profiles") return true;
  if (method === "POST" && path === "/api/admin/quick-replies/suggest") return true;
  if (
    (method === "PUT" || method === "POST") &&
    /^\/api\/admin\/runtime\/tenants\/[^/]+\/quick-replies$/.test(path)
  ) {
    return true;
  }
  if (method === "POST" && path === "/api/tts/config") return true;
  if (method === "POST" && path === "/api/tts/preview/async") return true;
  if (method === "POST" && path === "/api/admin/stripe/portal") return true;
  if (method === "DELETE" && /^\/api\/admin\/leads\/[^/]+$/.test(path)) {
    return true;
  }
  if (
    ["POST", "PUT", "DELETE"].includes(method) &&
    /^\/api\/admin\/workflows(?:\/|$)/.test(path)
  ) {
    return true;
  }
  if (
    method === "POST" &&
    /^\/api\/admin\/approvals\/[^/]+\/decide$/.test(path)
  ) {
    return true;
  }
  if (method === "PUT" && path === "/api/admin/owned-voice") return true;
  // The route itself enforces shop_playbooks.owner_can_edit.
  if (method === "PUT" && path === "/api/admin/shop-playbook") return true;
  return false;
}

function adminGuard(requiredRole: AdminRole = "viewer") {
  return async (
    req: AuthedRequest,
    res: express.Response,
    next: NextFunction
  ) => {
    try {
      const token = getAdminToken(req);

      const hasXAdminKey =
        typeof req.headers["x-admin-key"] === "string" ||
        Array.isArray(req.headers["x-admin-key"]);

      if (IS_PROD && ADMIN_AUTH_MODE === "jwt-only" && hasXAdminKey && !ALLOW_ADMIN_API_KEY_IN_PROD) {
        return res.status(401).json({ error: "admin_key_disabled_in_prod" });
      }

      if (!token) {
        return res.status(401).json({ error: "admin_auth_required" });
      }

      const principal = await authenticateAdminKey(token);
      if (!principal) {
        return res.status(401).json({ error: "admin_auth_invalid" });
      }

      const ctx: RequestContext = {
        authType: principal.source === "oidc" ? "jwt" : "adminKey",
        isSuperAdmin: false,
        role: "tenant-viewer",
      };

      // Superadmin via master/admin key or installer console JWT
      if (principal.source !== "oidc") {
        ctx.isSuperAdmin = true;
        ctx.role = "superadmin";
        if (principal.source === "installer") {
          ctx.authType = "jwt";
          ctx.email = principal.email;
        }
        req.ctx = ctx;

        res.on("finish", () => {
          void recordAudit({
            adminKeyId: principal.id,
            action: `${req.method} ${req.path}`,
            path: req.path,
            tenantId: extractTenantId(req) || undefined,
            status: String(res.statusCode),
            details:
              principal.source === "installer" && principal.email
                ? { operatorEmail: principal.email, role: "superadmin" }
                : principal.source === "env"
                  ? { operator: "master-key", role: "superadmin" }
                  : undefined,
          });
        });

        return next();
      }

      // OIDC/JWT user path
      const sub = principal.idpSub;
      if (!sub) {
        return res.status(401).json({ error: "jwt_missing_sub" });
      }

      const user = await upsertUserBySub({
        idpSub: sub,
        email: principal.email || principal.name,
      });

      ctx.userId = user.id;
      ctx.idpSub = sub;
      ctx.email = principal.email;
      ctx.ownerConsole = Boolean(principal.ownerConsole);

      const memberships = await listMembershipsForUser(user.id);
      if (memberships.length === 0) {
        return res.status(403).json({ error: "No tenant membership" });
      }

      ctx.tenantIds = memberships.map((m) => m.tenant_id);

      let tenantIdForCtx: string | undefined;

      if (memberships.length === 1) {
        tenantIdForCtx = memberships[0].tenant_id;
        ctx.role =
          memberships[0].role === "viewer" ? "tenant-viewer" : "tenant-admin";
      } else {
        const activeHeader = req.headers["x-active-tenant"];
        const active =
          typeof activeHeader === "string"
            ? activeHeader
            : Array.isArray(activeHeader) && activeHeader[0]
            ? activeHeader[0]
            : undefined;

        const tenantIdHeader = req.headers["x-tenant-id"];
        const tenantFromHeader =
          typeof tenantIdHeader === "string"
            ? tenantIdHeader.trim()
            : Array.isArray(tenantIdHeader) && tenantIdHeader[0]
            ? String(tenantIdHeader[0]).trim()
            : "";

        // UIs (admin / portal) send X-Tenant-ID when switching businesses; historically only
        // X-Active-Tenant was read here, so JWT multi-tenant users could not align ctx with the UI.
        let chosen = active?.trim() || "";
        if (!chosen && tenantFromHeader) {
          const byHeader = memberships.find((m) => m.tenant_id === tenantFromHeader);
          if (byHeader) chosen = byHeader.tenant_id;
        }

        if (!chosen) {
          return res.status(400).json({
            error: "Ambiguous tenant; set X-Active-Tenant or X-Tenant-ID",
          });
        }

        const match = memberships.find((m) => m.tenant_id === chosen);
        if (!match) {
          return res.status(400).json({
            error: "Ambiguous tenant; set X-Active-Tenant or X-Tenant-ID",
          });
        }

        tenantIdForCtx = match.tenant_id;
        ctx.role = match.role === "viewer" ? "tenant-viewer" : "tenant-admin";
      }

      ctx.tenantId = tenantIdForCtx;
      ctx.isSuperAdmin = false;
      req.ctx = ctx;

      if (
        requiredRole === "admin" &&
        ctx.ownerConsole &&
        !ownerConsoleWriteAllowed(req)
      ) {
        return res.status(403).json({ error: "owner_scope_forbidden" });
      }

      if (requiredRole === "admin" && ctx.role !== "tenant-admin") {
        return res.status(403).json({ error: "admin_forbidden" });
      }

      res.on("finish", () => {
        void recordAudit({
          adminKeyId: principal.id,
          action: `${req.method} ${req.path}`,
          path: req.path,
          tenantId: tenantIdForCtx,
          status: String(res.statusCode),
        });
      });

      return next();
    } catch (err) {
      console.error("adminGuard error:", err);
      return res.status(500).json({ error: "admin_auth_error" });
    }
  };
}

/* ──────────────────────────────────────────────── */

function sanitizeEnvValue(value: string | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  return value.replace(/[\r\n]/g, "").trim();
}

function clamp(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}

function optBoolBody(v: unknown): boolean | undefined {
  if (typeof v === "boolean") return v;
  if (v === "true" || v === "1") return true;
  if (v === "false" || v === "0") return false;
  return undefined;
}

/** Accepts JSON numbers and numeric strings (clients sometimes stringify sliders). */
function toFiniteNumber(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

function optNumBody(v: unknown, min: number, max: number): number | undefined {
  const n = toFiniteNumber(v);
  if (n === undefined) return undefined;
  return clamp(n, min, max);
}

function optIntBody(v: unknown, min: number, max: number): number | undefined {
  const n = toFiniteNumber(v);
  if (n === undefined) return undefined;
  const r = Math.round(n);
  return Math.min(max, Math.max(min, r));
}

const rawAudioDiagnosticsModeEnum = z.enum([
  "off",
  "next_call_only",
  "failed_calls_only",
  "all_calls_temporary",
]);

const callQualitySettingsPatchSchema = z
  .object({
    callQualityAnalyticsEnabled: z.boolean().optional(),
    transcriptStorageEnabled: z.boolean().optional(),
    transcriptRetentionDays: z.number().int().min(1).max(365).optional(),
    qualitySummaryVisibleToClient: z.boolean().optional(),
    rawArtifactsVisibleToClient: z.boolean().optional(),
    rawAudioDiagnosticsMode: rawAudioDiagnosticsModeEnum.optional(),
    rawAudioDiagnosticsExpiresAt: z.string().datetime().nullable().optional(),
    rawAudioDiagnosticsEnabledBy: z.string().max(512).nullable().optional(),
    rawAudioDiagnosticsReason: z.string().max(4000).nullable().optional(),
    rawAudioDiagnosticsNextCallPending: z.boolean().optional(),
  })
  .strict();

const rawDiagEnableBodySchema = z
  .object({
    reason: z.string().min(1).max(4000),
    expiresAt: z.string().datetime(),
    mode: rawAudioDiagnosticsModeEnum.default("next_call_only"),
  })
  .strict();

const rawDiagDisableBodySchema = z
  .object({
    reason: z.string().min(1).max(4000),
  })
  .strict();

function callQualityRowToApi(row: TenantCallQualitySettingsRow, viewer: boolean) {
  const base = {
    callQualityAnalyticsEnabled: row.call_quality_analytics_enabled,
    transcriptStorageEnabled: row.transcript_storage_enabled,
    transcriptRetentionDays: row.transcript_retention_days,
    qualitySummaryVisibleToClient: row.quality_summary_visible_to_client,
  };
  if (viewer) return base;
  return {
    ...base,
    rawAudioDiagnosticsMode: row.raw_audio_diagnostics_mode,
    rawAudioDiagnosticsExpiresAt: row.raw_audio_diagnostics_expires_at,
    rawAudioDiagnosticsEnabledBy: row.raw_audio_diagnostics_enabled_by,
    rawAudioDiagnosticsReason: row.raw_audio_diagnostics_reason,
    rawAudioDiagnosticsNextCallPending: row.raw_audio_diagnostics_next_call_pending,
    rawArtifactsVisibleToClient: row.raw_artifacts_visible_to_client,
  };
}

/** Client portal: safe labels only (no raw JSON, URLs, or internal diagnostics paths). */
function mapOwnerPortalCallQuality(s: Record<string, unknown>): Record<string, unknown> {
  const qs = typeof s.qualityStatus === "string" ? s.qualityStatus : "unknown";
  const callQualityLabel =
    qs === "good" ? "Good" : qs === "warning" ? "Needs review" : qs === "poor" ? "Poor" : "Unknown";

  const tq = typeof s.transcriptQuality === "string" ? s.transcriptQuality : "unknown";
  const transcriptQualityLabel =
    tq === "good" ? "Good" : tq === "medium" ? "Medium" : tq === "poor" ? "Poor" : "Unknown";

  const lr = typeof s.latencyRisk === "string" ? s.latencyRisk : "unknown";
  const aiResponseDelay = lr === "high" ? "slow" : "normal";

  const issues: string[] = [];
  if (s.interruptionDetected === true) issues.push("caller_interrupted");
  const echo = typeof s.echoRisk === "string" ? s.echoRisk : "";
  if (echo === "high" || echo === "medium") issues.push("background_noise");
  const missed = typeof s.missedSpeechRisk === "string" ? s.missedSpeechRisk : "";
  if (missed === "high") issues.push("no_speech_detected");
  if (s.deadAirDetected === true) issues.push("no_speech_detected");
  if (typeof s.whisperRequestCount === "number" && s.whisperRequestCount === 0 && s.durationSeconds) {
    issues.push("transcript_unavailable");
  }

  return {
    callQuality: callQualityLabel,
    transcriptQuality: transcriptQualityLabel,
    aiResponseDelay,
    issueDetected: issues.length ? issues : ["none"],
  };
}

const CTRL_CHARS = /[\x00-\x08\x0B\x0C\x0E-\x1F]/g;

function sanitizeTtsShortText(v: unknown, maxLen: number): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.replace(CTRL_CHARS, "").trim();
  if (!t) return undefined;
  return t.length > maxLen ? t.slice(0, maxLen) : t;
}

/** Clear Qwen3-only fields when switching TTS mode away from qwen3_tts_http. */
function clearQwen3GenFields(u: Record<string, unknown>): void {
  u.qwen3DoSample = undefined;
  u.qwen3Temperature = undefined;
  u.qwen3TopP = undefined;
  u.qwen3TopK = undefined;
  u.qwen3RepetitionPenalty = undefined;
  u.qwen3MaxNewTokens = undefined;
  u.qwen3NonStreamingMode = undefined;
  u.qwen3SubtalkerDoSample = undefined;
  u.qwen3SubtalkerTopK = undefined;
  u.qwen3SubtalkerTopP = undefined;
  u.qwen3SubtalkerTemperature = undefined;
  u.qwen3Streaming = undefined;
}

/** Clear Miso-only generation fields when switching TTS mode away from miso_tts_http. */
function clearMisoGenFields(u: Record<string, unknown>): void {
  u.misoMaxAudioLengthMs = undefined;
  u.misoTemperature = undefined;
  u.misoTopK = undefined;
}

function clearMagpieGenFields(u: Record<string, unknown>): void {
  u.magpieTemperature = undefined;
  u.magpieCfgScale = undefined;
  u.magpieTopK = undefined;
  u.magpieUseCfg = undefined;
  u.magpieApplyTn = undefined;
}

function clearMeloGenFields(u: Record<string, unknown>): void {
  u.meloSdpRatio = undefined;
  u.meloNoiseScale = undefined;
  u.meloNoiseScaleW = undefined;
}

/** Clear Coqui XTTS decoding fields when switching away from coqui_xtts. */
function clearCoquiGenFields(u: Record<string, unknown>): void {
  u.coquiTemperature = undefined;
  u.coquiLengthPenalty = undefined;
  u.coquiRepetitionPenalty = undefined;
  u.coquiTopK = undefined;
  u.coquiTopP = undefined;
  u.coquiSpeed = undefined;
  u.coquiSplitSentences = undefined;
}

function respondVoiceRuntimeMoved(res: express.Response) {
  return res.status(410).json({
    error: "voice_runtime_moved",
    message: "Voice loop endpoints moved to the voice runtime repo.",
  });
}
function extractTenantId(req: Request): string | undefined {
  const header = req.headers["x-tenant-id"];
  if (typeof header === "string" && header.trim()) return header.trim();
  if (Array.isArray(header) && header[0]) return header[0].trim();

  const queryTenant =
    typeof req.query.tenantId === "string" ? req.query.tenantId : undefined;
  if (queryTenant && queryTenant.trim()) return queryTenant.trim();

  const bodyTenant =
    req.body && typeof req.body.tenantId === "string"
      ? req.body.tenantId
      : undefined;
  if (bodyTenant && bodyTenant.trim()) return bodyTenant.trim();

  return undefined;
}

function extractDialedNumber(req: Request): string | undefined {
  const body = req.body || {};
  const candidates = [
    (body as any).toNumber,
    (body as any).calledNumber,
    (body as any).called_number,
    (body as any).to,
    (body as any).to_number,
    (body as any).number,
  ];
  const query = req.query || {};
  candidates.push(
    (query as any).toNumber || undefined,
    (query as any).calledNumber || undefined,
    (query as any).to || undefined
  );

  for (const c of candidates) {
    if (typeof c === "string" && c.trim()) {
      const normalized = normalizePhoneNumber(c);
      if (normalized) return normalized;
    }
  }
  return undefined;
}

/**
 * PUBLIC tenant resolution:
 * - Only uses dialed number mapping, else DEFAULT tenant
 */
function resolveTenant(req: Request): TenantContext {
  const dialed = extractDialedNumber(req);
  if (dialed) {
    const matched = tenants.getByNumber(dialed);
    if (matched) return matched;
  }
  return tenants.getOrCreate(DEFAULT_TENANT_ID);
}

function resolveTenantStrict(req: Request): TenantContext | null {
  const dialed = extractDialedNumber(req);
  if (!dialed) return null;

  const matched = tenants.getByNumber(dialed);
  return matched ?? null;
}

/**
 * ADMIN tenant resolution:
 * - Superadmin can explicitly select tenant with X-Tenant-ID/tenantId
 * - Otherwise falls back to safe public logic (dialed/default)
 */
function resolveTenantForAdmin(req: Request): TenantContext {
  const explicitId = extractTenantId(req);
  if (explicitId) return tenants.getOrCreate(explicitId);
  return resolveTenant(req);
}

function getTenantForAdmin(
  req: AuthedRequest,
  res: express.Response
): TenantContext | undefined {
  const ctx = req.ctx;

  if (ctx?.isSuperAdmin) {
    return resolveTenantForAdmin(req);
  }

  if (!ctx || !ctx.tenantId) {
    res.status(403).json({ error: "tenant_context_missing" });
    return undefined;
  }

  return tenants.getOrCreate(ctx.tenantId);
}

function ensureRuntimeAdminEnabled(res: express.Response): boolean {
  if (!ENABLE_RUNTIME_ADMIN) {
    res.status(503).json({ error: "runtime_admin_disabled" });
    return false;
  }
  return true;
}

function adminActorRole(req: AuthedRequest): string {
  if (req.ctx?.isSuperAdmin) return "superadmin";
  return req.ctx?.role ?? "admin";
}

function isStaffBillingActor(req: AuthedRequest): boolean {
  if (req.ctx?.isSuperAdmin) return true;
  if (req.ctx?.ownerConsole) return false;
  return req.ctx?.role === "tenant-admin";
}

function requireStaffBilling(req: AuthedRequest, res: express.Response): boolean {
  if (isStaffBillingActor(req)) return true;
  res.status(403).json({ error: "staff_only", message: "Only VeraLux staff can create or cancel subscriptions." });
  return false;
}

function requireSuperAdmin(req: AuthedRequest, res: express.Response): boolean {
  if (req.ctx?.isSuperAdmin) return true;
  res.status(403).json({ error: "superadmin_required" });
  return false;
}

function ensureTenantAccess(
  req: AuthedRequest,
  res: express.Response,
  tenantId: string
): boolean {
  const ctx = req.ctx;
  if (!ctx) {
    res.status(403).json({ error: "tenant_context_missing" });
    return false;
  }
  if (ctx.isSuperAdmin) return true;
  if (!ctx.tenantId || ctx.tenantId !== tenantId) {
    res.status(403).json({ error: "tenant_forbidden" });
    return false;
  }
  return true;
}

registerTenantLlmRoutes(app, {
  mergeOperatorState: (tenantId, patch) => tenants.mergeOperatorState(tenantId, patch),
  afterMutation: trySyncTenantRuntimeConfigForLimits,
  adminGuard,
  ensureTenantAccess,
  getAdminToken,
  verifyOwnerPortalToken,
  tenantsGetOrCreate: (id) => tenants.getOrCreate(id),
});

async function requireTenantFeature(
  req: AuthedRequest,
  res: express.Response,
  tenantId: string,
  feature:
    | "advancedAnalytics"
    | "customWorkflows"
    | "calendarIntegration"
    | "crmIntegration"
    | "smsFollowup"
    | "callRecording"
    | "multiLocation"
): Promise<boolean> {
  if (!ensureTenantAccess(req, res, tenantId)) return false;
  const entitlement = await checkFeatureEntitlement(tenantId, feature as FeatureKey, {
    path: req.path,
    method: req.method,
    requestId: getRequestId(req),
  });
  if (!entitlement.allowed) {
    res.status(403).json({ error: entitlement.reason, feature });
    return false;
  }
  return true;
}

function shouldIncludeRuntimeSecrets(req: Request): boolean {
  const raw = typeof req.query.includeSecrets === "string" ? req.query.includeSecrets : undefined;
  return parseBooleanish(raw, false) && ALLOW_RUNTIME_SECRET_READ;
}

function redactRuntimeConfig(config: RuntimeTenantConfig): Record<string, unknown> {
  return redactPublishedRuntimeConfig(config);
}

function ttsDiagnosticsPayload(full: TTSConfig): Record<string, unknown> {
  return {
    xttsUrl: redactHttpUrlToPlaceholder(full.xttsUrl),
    kokoroUrl: redactHttpUrlToPlaceholder(full.kokoroUrl),
    coquiXttsUrl: redactHttpUrlToPlaceholder(full.coquiXttsUrl),
    chatterboxUrl: redactHttpUrlToPlaceholder(full.chatterboxUrl),
    qwen3TtsUrl: redactHttpUrlToPlaceholder(full.qwen3TtsUrl),
    misoTtsUrl: redactHttpUrlToPlaceholder(full.misoTtsUrl),
    magpieTtsUrl: redactHttpUrlToPlaceholder(full.magpieTtsUrl),
    meloTtsUrl: redactHttpUrlToPlaceholder(full.meloTtsUrl),
    clonedSpeakerWavUrl: full.clonedVoice?.speakerWavUrl
      ? redactHttpUrlToPlaceholder(full.clonedVoice.speakerWavUrl)
      : undefined,
  };
}

function parsePreferredPort(value: string | undefined, fallback = 4000): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const tester = createServer();
    tester.once("error", () => resolve(false));
    tester.once("listening", () => {
      tester.close(() => resolve(true));
    });
    tester.listen(port);
  });
}

function getEphemeralPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const tester = createServer();
    tester.once("error", reject);
    tester.listen(0, () => {
      const address = tester.address() as AddressInfo | null;
      if (!address) {
        tester.close(() => reject(new Error("Unable to determine ephemeral port")));
        return;
      }
      const port = address.port;
      tester.close(() => resolve(port));
    });
  });
}

async function findAvailablePort(
  preferredPort: number,
  maxAttempts = 20
): Promise<number> {
  for (let i = 0; i < maxAttempts; i += 1) {
    const port = preferredPort + i;
    // eslint-disable-next-line no-await-in-loop
    if (await isPortAvailable(port)) return port;
  }
  return getEphemeralPort();
}

/* ────────────────────────────────────────────────
   Legacy voice loop endpoints (disabled)
   ──────────────────────────────────────────────── */

app.post("/api/dev/echo-audio", (_req, res) => respondVoiceRuntimeMoved(res));
app.post("/api/dev/receptionist-audio", (_req, res) =>
  respondVoiceRuntimeMoved(res)
);

/* ────────────────────────────────────────────────
   Health
   ──────────────────────────────────────────────── */

import { healthcheckRedis as healthcheckRateLimitRedis } from "./redis";

app.get("/health", (_req, res) => {
  // Basic liveness check - just confirms the process is running
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

app.get("/ready", async (_req, res) => {
  const checks: { 
    db?: { ok: boolean; latencyMs?: number };
    runtimeRedis?: { ok: boolean; latencyMs?: number };
    rateLimitRedis?: { ok: boolean; latencyMs?: number };
  } = {};
  
  // Check database
  const dbStart = Date.now();
  const dbOk = await pingPool();
  checks.db = { ok: dbOk, latencyMs: Date.now() - dbStart };
  
  // Check runtime Redis if enabled
  if (ENABLE_RUNTIME_ADMIN) {
    try {
      const redisHealth = await healthcheckRedis();
      checks.runtimeRedis = redisHealth;
    } catch (err) {
      checks.runtimeRedis = { ok: false };
    }
  }
  
  // Check rate limit Redis if enabled
  if (process.env.REDIS_URL) {
    try {
      const rateLimitHealth = await healthcheckRateLimitRedis();
      checks.rateLimitRedis = rateLimitHealth;
    } catch (err) {
      checks.rateLimitRedis = { ok: false };
    }
  }
  
  // Overall health
  const dbHealthy = checks.db?.ok ?? false;
  const runtimeRedisHealthy = ENABLE_RUNTIME_ADMIN ? (checks.runtimeRedis?.ok ?? false) : true;
  const rateLimitRedisHealthy = process.env.REDIS_URL ? (checks.rateLimitRedis?.ok ?? false) : true;
  
  const ok = dbHealthy && runtimeRedisHealthy && rateLimitRedisHealthy;
  
  if (!ok) {
    logger.warn("Health check failed", { checks });
    return res.status(503).json({ status: "not_ready", checks });
  }
  
  res.json({ status: "ok", checks });
});

/* ────────────────────────────────────────────────
   Installer admin-auth (used by install.sh)
   ──────────────────────────────────────────────── */

const INSTALLER_AUTH_RATE_LIMIT = ipRateLimit({ windowMs: 60_000, max: 20 });
const OWNER_LOGIN_RATE_LIMIT = ipRateLimit({ windowMs: 60_000, max: 25 });

app.post("/admin-auth", INSTALLER_AUTH_RATE_LIMIT, (req, res) => {
  const { username, password } = req.body || {};

  if (!username || !password) {
    return res.status(400).json({ success: false, error: "Username and password are required" });
  }

  const userOk = timingSafeTextEqual(String(username), getInstallerUsername());
  const passOk = timingSafeTextEqual(String(password), getInstallerPassword());

  if (userOk && passOk) {
    return res.json({ success: true });
  }

  return res.status(401).json({ success: false, error: "Invalid credentials" });
});

/** Neural Operations Console — email/password (no API key in the browser). */
app.post("/api/admin/login", INSTALLER_AUTH_RATE_LIMIT, async (req, res) => {
  try {
    const email = typeof req.body?.email === "string" ? req.body.email : "";
    const password = typeof req.body?.password === "string" ? req.body.password : "";

    if (!email.trim() || !password) {
      return res.status(400).json({ success: false, error: "email_and_password_required" });
    }

    const result = await verifyConsoleLogin(email, password);
    if (!result.ok) {
      if (result.error === "console_login_not_configured") {
        return res.status(503).json({
          success: false,
          error: "console_login_not_configured",
          message: "Set INSTALLER_PASSWORD (and optionally ADMIN_CONSOLE_EMAIL) in the control plane environment.",
        });
      }
      return res.status(401).json({ success: false, error: "Invalid credentials" });
    }

    const operatorEmail = result.email;
    const token = await issueInstallerConsoleJwt({ email: operatorEmail });
    void recordAudit({
      action: "console_superadmin_login",
      path: "/api/admin/login",
      status: "200",
      details: { email: operatorEmail, role: "superadmin", source: result.source },
    });
    return res.json({ success: true, token, email: operatorEmail });
  } catch (err) {
    console.error("POST /api/admin/login error:", err);
    return res.status(500).json({ success: false, error: "login_failed" });
  }
});

/* ────────────────────────────────────────────────
   Owner Portal – public auth (no adminGuard)
   ──────────────────────────────────────────────── */

app.post("/api/owner/login", OWNER_LOGIN_RATE_LIMIT, async (req, res) => {
  try {
    const body = req.body || {};
    const emailRaw = typeof body.email === "string" ? body.email : "";
    const password = typeof body.password === "string" ? body.password : "";
    const phone = typeof body.phone === "string" ? body.phone : "";
    const passcode = typeof body.passcode === "string" ? body.passcode : "";

    if (emailRaw.trim() || password) {
      const emailNorm = normalizePortalEmail(emailRaw);
      if (!emailNorm || !password) {
        return res.status(400).json({ error: "email_and_password_required" });
      }
      if (!isValidPortalEmailShape(emailNorm)) {
        return res.status(400).json({ error: "invalid_email" });
      }
      const tenantId = await getTenantIdByPortalEmail(emailNorm);
      if (!tenantId) {
        return res.status(401).json({ error: "Invalid credentials" });
      }
      const row = await getOwnerPortalCredentialRow(tenantId);
      if (!row || row.emailNorm !== emailNorm) {
        return res.status(401).json({ error: "Invalid credentials" });
      }
      const valid = verifyPortalPassword(password, row.passwordHash);
      if (!valid) {
        return res.status(401).json({ error: "Invalid credentials" });
      }
      const tenant = tenants.getOrCreate(tenantId);
      const token = await issueOwnerJwt({
        tenantId: tenant.id,
        tenantName: tenant.meta.name,
        ownerEmail: emailNorm,
      });
      return res.json({
        success: true,
        token,
        tenant: {
          id: tenant.id,
          name: tenant.meta.name,
          numbers: tenant.meta.numbers,
        },
      });
    }

    if (phone.trim() && passcode) {
      const normalized = normalizePhoneNumber(phone);
      const stripped = phone.replace(/[\s\-\(\)\.]/g, "");
      const digits = stripped.replace(/^\+/, "");

      const tenant =
        (normalized ? tenants.getByNumber(normalized) : undefined) ||
        tenants.getByNumber(stripped) ||
        tenants.getByNumber(digits) ||
        tenants.getByNumber("+" + digits) ||
        (digits.length === 10
          ? tenants.getByNumber("1" + digits) ||
            tenants.getByNumber("+1" + digits)
          : undefined);

      if (!tenant) {
        return res.status(401).json({ error: "Invalid credentials" });
      }

      const valid = await verifyOwnerPasscode(tenant.id, passcode);
      if (!valid) {
        return res.status(401).json({ error: "Invalid credentials" });
      }

      const token = await issueOwnerJwt({
        tenantId: tenant.id,
        tenantName: tenant.meta.name,
      });

      return res.json({
        success: true,
        token,
        tenant: {
          id: tenant.id,
          name: tenant.meta.name,
          numbers: tenant.meta.numbers,
        },
      });
    }

    return res.status(400).json({ error: "credentials_required" });
  } catch (err) {
    console.error("POST /api/owner/login error:", err);
    return res.status(500).json({ error: "Login failed" });
  }
});

// Admin-only: set a tenant's owner passcode
app.post("/api/owner/set-passcode", async (req, res) => {
  try {
    // Require admin auth for this endpoint
    const adminToken = getAdminToken(req);
    if (!adminToken) {
      return res.status(401).json({ error: "Admin auth required" });
    }
    const principal = await authenticateAdminKey(adminToken);
    if (!principal || principal.source === "oidc") {
      return res.status(401).json({ error: "Admin auth required" });
    }

    const { tenantId, passcode } = req.body || {};
    if (!tenantId || typeof tenantId !== "string") {
      return res.status(400).json({ error: "tenantId is required" });
    }
    if (!passcode || typeof passcode !== "string" || passcode.length < 4) {
      return res.status(400).json({ error: "passcode must be at least 4 characters" });
    }

    const tenant = tenants.getOrCreate(tenantId);
    if (!tenant) {
      return res.status(404).json({ error: "Tenant not found" });
    }

    await setOwnerPasscode(tenantId, passcode);
    return res.json({ success: true, tenantId });
  } catch (err) {
    console.error("POST /api/owner/set-passcode error:", err);
    return res.status(500).json({ error: "Failed to set passcode" });
  }
});

// Admin-only: set email + password for client portal (preferred over passcode-only)
app.post("/api/owner/set-portal-credentials", async (req, res) => {
  try {
    const adminToken = getAdminToken(req);
    if (!adminToken) {
      return res.status(401).json({ error: "Admin auth required" });
    }
    const principal = await authenticateAdminKey(adminToken);
    if (!principal || principal.source === "oidc") {
      return res.status(401).json({ error: "Admin auth required" });
    }

    const { tenantId, email, password } = req.body || {};
    if (!tenantId || typeof tenantId !== "string") {
      return res.status(400).json({ error: "tenantId is required" });
    }
    const emailNorm = normalizePortalEmail(
      typeof email === "string" ? email : ""
    );
    if (!emailNorm || !isValidPortalEmailShape(emailNorm)) {
      return res.status(400).json({ error: "invalid_email" });
    }
    const pw = typeof password === "string" ? password : "";
    if (pw.length < PORTAL_PASSWORD_MIN_LEN) {
      return res.status(400).json({
        error: "password_too_short",
        minLength: PORTAL_PASSWORD_MIN_LEN,
      });
    }
    if (pw.length > PORTAL_PASSWORD_MAX_LEN) {
      return res.status(400).json({ error: "password_too_long" });
    }

    const tenant = tenants.getOrCreate(tenantId);
    if (!tenant) {
      return res.status(404).json({ error: "Tenant not found" });
    }

    const passwordHash = hashPortalPassword(pw);
    try {
      await upsertOwnerPortalCredentials({
        tenantId,
        emailNorm,
        passwordHash,
      });
    } catch (e: unknown) {
      const code = (e as { code?: string })?.code;
      if (code === "23505") {
        return res.status(409).json({
          error: "email_already_registered",
          message: "That email is already used for another business.",
        });
      }
      throw e;
    }
    return res.json({ success: true, tenantId, email: emailNorm });
  } catch (err) {
    console.error("POST /api/owner/set-portal-credentials error:", err);
    return res.status(500).json({ error: "Failed to set portal credentials" });
  }
});

/**
 * Logged-in client portal session (owner JWT): change passcode with current + new.
 * Auth: same token as other portal API calls (Bearer preferred for jwt-only prod).
 */
app.post("/api/owner/change-passcode", async (req, res) => {
  try {
    const raw = getAdminToken(req);
    if (!raw) {
      return res.status(401).json({ error: "auth_required" });
    }
    const session = await verifyOwnerPortalToken(raw);
    if (!session) {
      return res.status(401).json({ error: "invalid_or_expired_session" });
    }

    const body = req.body || {};
    const currentPasscode =
      typeof body.currentPasscode === "string" ? body.currentPasscode : "";
    const newPasscode =
      typeof body.newPasscode === "string" ? body.newPasscode : "";
    if (!currentPasscode.trim() || !newPasscode.trim()) {
      return res.status(400).json({
        error: "current_and_new_passcode_required",
      });
    }

    const result = await changeOwnerPasscodeIfValid(
      session.tenantId,
      currentPasscode,
      newPasscode
    );
    if (!result.ok) {
      if (result.error === "invalid_current") {
        return res.status(403).json({ error: "invalid_current_passcode" });
      }
      if (result.error === "passcode_too_short") {
        return res
          .status(400)
          .json({ error: "passcode_too_short", minLength: 4 });
      }
      return res.status(400).json({ error: "passcode_too_long" });
    }
    return res.json({ success: true });
  } catch (err) {
    console.error("POST /api/owner/change-passcode error:", err);
    return res.status(500).json({ error: "change_passcode_failed" });
  }
});

/** Logged-in portal session: change password (email login). */
app.post("/api/owner/change-password", async (req, res) => {
  try {
    const raw = getAdminToken(req);
    if (!raw) {
      return res.status(401).json({ error: "auth_required" });
    }
    const session = await verifyOwnerPortalToken(raw);
    if (!session) {
      return res.status(401).json({ error: "invalid_or_expired_session" });
    }

    const body = req.body || {};
    const currentPassword =
      typeof body.currentPassword === "string" ? body.currentPassword : "";
    const newPassword =
      typeof body.newPassword === "string" ? body.newPassword : "";
    if (!currentPassword.trim() || !newPassword.trim()) {
      return res.status(400).json({
        error: "current_and_new_password_required",
      });
    }

    const result = await changeOwnerPortalPasswordIfValid(
      session.tenantId,
      currentPassword,
      newPassword
    );
    if (!result.ok) {
      if (result.error === "invalid_current") {
        return res.status(403).json({ error: "invalid_current_password" });
      }
      if (result.error === "password_too_short") {
        return res.status(400).json({
          error: "password_too_short",
          minLength: PORTAL_PASSWORD_MIN_LEN,
        });
      }
      if (result.error === "no_email_login") {
        return res.status(400).json({ error: "no_email_login" });
      }
      return res.status(400).json({ error: "password_too_long" });
    }
    return res.json({ success: true });
  } catch (err) {
    console.error("POST /api/owner/change-password error:", err);
    return res.status(500).json({ error: "change_password_failed" });
  }
});

app.get("/api/owner/account", async (req, res) => {
  try {
    const raw = getAdminToken(req);
    if (!raw) {
      return res.status(401).json({ error: "auth_required" });
    }
    const session = await verifyOwnerPortalToken(raw);
    if (!session) {
      return res.status(401).json({ error: "invalid_or_expired_session" });
    }
    const [hash, cred] = await Promise.all([
      getOwnerPasscodeHash(session.tenantId),
      getOwnerPortalCredentialRow(session.tenantId),
    ]);
    return res.json({
      email: cred?.emailNorm ?? null,
      emailLoginSet: Boolean(cred),
      passcodeSet: Boolean(hash),
      passwordMinLength: PORTAL_PASSWORD_MIN_LEN,
    });
  } catch (err) {
    console.error("GET /api/owner/account error:", err);
    return res.status(500).json({ error: "account_lookup_failed" });
  }
});

app.post("/api/owner/change-email", async (req, res) => {
  try {
    const raw = getAdminToken(req);
    if (!raw) {
      return res.status(401).json({ error: "auth_required" });
    }
    const session = await verifyOwnerPortalToken(raw);
    if (!session) {
      return res.status(401).json({ error: "invalid_or_expired_session" });
    }

    const body = req.body || {};
    const currentPassword =
      typeof body.currentPassword === "string" ? body.currentPassword : "";
    const newEmail = typeof body.newEmail === "string" ? body.newEmail : "";
    if (!currentPassword.trim() || !newEmail.trim()) {
      return res.status(400).json({ error: "current_password_and_email_required" });
    }

    const result = await changeOwnerPortalEmailIfValid(
      session.tenantId,
      currentPassword,
      newEmail
    );
    if (!result.ok) {
      if (result.error === "invalid_current") {
        return res.status(403).json({ error: "invalid_current_password" });
      }
      if (result.error === "no_email_login") {
        return res.status(400).json({ error: "no_email_login" });
      }
      if (result.error === "email_already_registered") {
        return res.status(409).json({ error: "email_already_registered" });
      }
      return res.status(400).json({ error: "invalid_email" });
    }

    const tenant = tenants.getOrCreate(session.tenantId);
    const token = await issueOwnerJwt({
      tenantId: tenant.id,
      tenantName: tenant.meta.name,
      ownerEmail: result.email,
    });
    return res.json({ success: true, email: result.email, token });
  } catch (err) {
    console.error("POST /api/owner/change-email error:", err);
    return res.status(500).json({ error: "change_email_failed" });
  }
});

app.post(
  "/api/admin/tenants/:tenantId/owner-passcode/change",
  adminGuard("admin"),
  async (req, res) => {
    try {
      const tenantId = req.params.tenantId?.trim();
      if (!tenantId) {
        return res.status(400).json({ error: "tenant_id_required" });
      }
      if (!ensureTenantAccess(req as AuthedRequest, res, tenantId)) return;

      const body = req.body || {};
      const currentPasscode =
        typeof body.currentPasscode === "string" ? body.currentPasscode : "";
      const newPasscode =
        typeof body.newPasscode === "string" ? body.newPasscode : "";
      if (!currentPasscode.trim() || !newPasscode.trim()) {
        return res.status(400).json({
          error: "current_and_new_passcode_required",
        });
      }

      const result = await changeOwnerPasscodeIfValid(
        tenantId,
        currentPasscode,
        newPasscode
      );
      if (!result.ok) {
        if (result.error === "invalid_current") {
          return res.status(403).json({ error: "invalid_current_passcode" });
        }
        if (result.error === "passcode_too_short") {
          return res
            .status(400)
            .json({ error: "passcode_too_short", minLength: 4 });
        }
        return res.status(400).json({ error: "passcode_too_long" });
      }
      return res.json({ success: true });
    } catch (err) {
      console.error(
        "POST /api/admin/tenants/:tenantId/owner-passcode/change error:",
        err
      );
      return res.status(500).json({ error: "change_passcode_failed" });
    }
  }
);

app.post(
  "/api/admin/tenants/:tenantId/owner-portal-password/change",
  adminGuard("admin"),
  async (req, res) => {
    try {
      const tenantId = req.params.tenantId?.trim();
      if (!tenantId) {
        return res.status(400).json({ error: "tenant_id_required" });
      }
      if (!ensureTenantAccess(req as AuthedRequest, res, tenantId)) return;

      const body = req.body || {};
      const currentPassword =
        typeof body.currentPassword === "string" ? body.currentPassword : "";
      const newPassword =
        typeof body.newPassword === "string" ? body.newPassword : "";
      if (!currentPassword.trim() || !newPassword.trim()) {
        return res.status(400).json({
          error: "current_and_new_password_required",
        });
      }

      const result = await changeOwnerPortalPasswordIfValid(
        tenantId,
        currentPassword,
        newPassword
      );
      if (!result.ok) {
        if (result.error === "invalid_current") {
          return res.status(403).json({ error: "invalid_current_password" });
        }
        if (result.error === "password_too_short") {
          return res.status(400).json({
            error: "password_too_short",
            minLength: PORTAL_PASSWORD_MIN_LEN,
          });
        }
        if (result.error === "no_email_login") {
          return res.status(400).json({ error: "no_email_login" });
        }
        return res.status(400).json({ error: "password_too_long" });
      }
      return res.json({ success: true });
    } catch (err) {
      console.error(
        "POST /api/admin/tenants/:tenantId/owner-portal-password/change error:",
        err
      );
      return res.status(500).json({ error: "change_password_failed" });
    }
  }
);

/* ──────────────────────────────────────────────── */

const ADMIN_RATE_MAX = Number(process.env.ADMIN_RATE_MAX || 100);
const ADMIN_RATE_WINDOW_MS = Number(
  process.env.ADMIN_RATE_WINDOW_MS || 5 * 60 * 1000
);
const ADMIN_RATE_USE_REDIS = parseBooleanish(
  process.env.ADMIN_RATE_USE_REDIS,
  false
);

const ttsApiRateLimiter = rateLimit({
  windowMs: ADMIN_RATE_WINDOW_MS,
  max: ADMIN_RATE_MAX,
  keyFn: (req) => getAdminToken(req) || req.ip || "anon",
  useRedis: ADMIN_RATE_USE_REDIS,
});

const adminSharedRateLimiter = rateLimit({
  windowMs: ADMIN_RATE_WINDOW_MS,
  max: ADMIN_RATE_MAX,
  keyFn: (req) => getAdminToken(req) || req.ip || "anon",
  useRedis: ADMIN_RATE_USE_REDIS,
});

/** Frequent dashboard GETs share one limiter bucket; exempt light polling paths from the cap. */
function adminApiRateLimitUnlessPollingGet(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  if (req.method === "GET") {
    const pathOnly = (req.originalUrl || req.url || "").split("?")[0];
    if (
      pathOnly === "/api/admin/calls" ||
      pathOnly.startsWith("/api/admin/analytics") ||
      pathOnly === "/api/admin/health" ||
      pathOnly.startsWith("/api/admin/health/")
    ) {
      next();
      return;
    }
  }
  adminSharedRateLimiter(req, res, next);
}

/**
 * Voice preview async flow polls ~once per second for minutes; the default admin
 * cap (100 / 5 min) would 429 mid-synthesis and break preview behind Cloudflare.
 */
function ttsApiRateLimitUnlessPreviewPoll(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const rel = req.path || "";
  const full = req.originalUrl || "";
  if (
    rel.startsWith("/preview/async") ||
    full.includes("/api/tts/preview/async")
  ) {
    next();
    return;
  }
  ttsApiRateLimiter(req, res, next);
}

// ✅ Admin mounts now include CORS guard first
app.use(
  "/api/admin",
  adminCorsGuard,
  adminApiRateLimitUnlessPollingGet,
  adminGuard("viewer")
);

app.use(
  "/api/tts",
  adminCorsGuard,
  ttsApiRateLimitUnlessPreviewPoll,
  adminGuard("admin")
);

/* ────────────────────────────────────────────────
   Admin – LLM config / keys / audit
   ──────────────────────────────────────────────── */

app.get("/api/admin/auth/keys", adminGuard("admin"), async (_req, res) => {
  const keys = await listAdminKeySummaries();
  res.json({
    keys: keys.map((k) => ({
      id: k.id,
      name: k.name,
      role: k.role,
      createdAt: k.created_at,
      lastUsedAt: k.last_used_at,
    })),
  });
});

app.post("/api/admin/auth/keys", adminGuard("admin"), async (req, res) => {
  const { name, role } = req.body as { name?: string; role?: AdminRole };
  if (!name || typeof name !== "string") {
    return res.status(400).json({ error: "name_required" });
  }
  const normalizedRole: AdminRole = role === "viewer" ? "viewer" : "admin";
  const created = await createAdminKey(name.trim(), normalizedRole);
  res.json({
    id: created.id,
    token: created.token,
    name: created.name,
    role: created.role,
  });
});

app.get("/api/admin/account", async (req: AuthedRequest, res) => {
  const snapshot = await describeConsoleAccount();
  if (!req.ctx?.isSuperAdmin) {
    return res.json({
      canChange: false,
      source: "identity_provider",
      email: req.ctx?.email || null,
      passwordMinLength: PORTAL_PASSWORD_MIN_LEN,
    });
  }
  return res.json({
    canChange: true,
    ...snapshot,
    sessionEmail: req.ctx?.email || snapshot.email,
  });
});

app.post(
  "/api/admin/account/credentials",
  INSTALLER_AUTH_RATE_LIMIT,
  async (req: AuthedRequest, res) => {
    if (!requireSuperAdmin(req, res)) return;
    const body = req.body || {};
    const currentPassword =
      typeof body.currentPassword === "string" ? body.currentPassword : "";
    const email = typeof body.email === "string" ? body.email : undefined;
    const newPassword =
      typeof body.newPassword === "string" ? body.newPassword : undefined;

    const result = await changeConsoleCredentials({
      currentPassword,
      email,
      newPassword,
    });
    if (!result.ok) {
      const err = result.error;
      if (err === "invalid_current_password") {
        return res.status(403).json({ error: err });
      }
      if (err === "email_already_registered") {
        return res.status(409).json({ error: err });
      }
      if (err === "console_login_not_configured") {
        return res.status(503).json({ error: err });
      }
      if (err === "password_too_short") {
        return res.status(400).json({
          error: err,
          minLength: PORTAL_PASSWORD_MIN_LEN,
        });
      }
      return res.status(400).json({ error: err });
    }

    const token = await issueInstallerConsoleJwt({ email: result.email });
    void recordAudit({
      action: "console_credentials_changed",
      path: "/api/admin/account/credentials",
      status: "200",
      details: {
        email: result.email,
        passwordChanged: Boolean(newPassword),
        emailChanged: Boolean(email),
      },
    });
    return res.json({ success: true, email: result.email, token });
  }
);

app.delete("/api/admin/auth/keys/:id", adminGuard("admin"), async (req, res) => {
  const { id } = req.params;
  if (!id) return res.status(400).json({ error: "id_required" });
  if (!isUuid(id)) return res.status(400).json({ error: "invalid_id" });
  await revokeAdminKey(id);
  res.json({ status: "ok" });
});

app.get("/api/admin/audit", adminGuard("admin"), async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const entries = await listAuditLogs(limit);
    res.json({ entries });
  } catch (err) {
    console.error("GET /api/admin/audit error:", err);
    res.status(500).json({ error: "internal_error" });
  }
});

app.get("/api/admin/config", async (req, res) => {
  const tenant = getTenantForAdmin(req as AuthedRequest, res);
  if (!tenant) return;

  const hasKey = await secretStore.hasSecret(tenant.id, "openai_api_key");
  const safe = tenant.config.getSafeConfig();

  res.json({
    ...safe,
    hasOpenAIApiKey: hasKey || safe.hasOpenAIApiKey,
  });
});

app.post("/api/admin/config", (req, res) => {
  const tenant = getTenantForAdmin(req as AuthedRequest, res);
  if (!tenant) return;

  const { provider, localUrl, openaiModel, openaiApiKey } = req.body as {
    provider?: LLMProvider;
    localUrl?: string;
    openaiModel?: string;
    openaiApiKey?: string;
  };

  if (provider && provider !== "local" && provider !== "openai") {
    return res.status(400).json({ error: "invalid_provider" });
  }

  const sanitizedKey = sanitizeEnvValue(openaiApiKey);
  if (openaiApiKey && (!sanitizedKey || !OPENAI_KEY_RE.test(sanitizedKey))) {
    return res.status(400).json({ error: "invalid_openai_api_key" });
  }

  const sanitizedModel = sanitizeEnvValue(openaiModel);

  tenant.config.set({
    provider,
    localUrl,
    openaiModel: sanitizedModel,
    openaiApiKey: sanitizedKey,
  });

  tenants.persistConfig(tenant.id);

  if (sanitizedKey) {
    void secretStore.setSecret(tenant.id, "openai_api_key", sanitizedKey);
  }

  res.json(tenant.config.getSafeConfig());
});

/* ────────────────────────────────────────────────
   Admin – prompts
   ──────────────────────────────────────────────── */

app.get("/api/admin/prompts", (req, res) => {
  const tenant = getTenantForAdmin(req as AuthedRequest, res);
  if (!tenant) return;
  res.json(tenant.config.getPrompts());
});

app.post(
  "/api/admin/prompts",
  asyncHandler(async (req: AuthedRequest, res) => {
    const tenant = getTenantForAdmin(req, res);
    if (!tenant) return;

    const { systemPreamble, schemaHint, policyPrompt, voicePrompt, greetingText } =
      req.body as Partial<PromptConfig>;

    logger.info("tenant_settings_save_attempt", {
      event: "tenant_settings_save_attempt",
      tenantId: tenant.id,
      settingArea: "prompts",
      actorRole: adminActorRole(req),
    });
    const updated = tenant.config.setPrompts({
      systemPreamble,
      schemaHint,
      policyPrompt,
      voicePrompt,
      greetingText,
    });

    tenants.persistConfig(tenant.id);
    logger.info("tenant_settings_save_success", {
      event: "tenant_settings_save_success",
      tenantId: tenant.id,
      settingArea: "prompts",
      actorRole: adminActorRole(req),
    });
    const publish = await autoPublishTenantRuntimeAfterSave(tenant.id, {
      settingArea: "prompts",
      actorRole: adminActorRole(req),
    });
    res.json({
      ...updated,
      saved: true,
      published: publish.published,
      lastRuntimePublishedAt: publish.lastRuntimePublishedAt,
      ...(publish.publishError ? { publishError: publish.publishError } : {}),
      ...(publish.publishSkippedReason ? { publishSkippedReason: publish.publishSkippedReason } : {}),
    });
  }),
);

/* ────────────────────────────────────────────────
   Admin – LLM context (forwarding profiles + pricing)
   ──────────────────────────────────────────────── */

app.get("/api/admin/forwarding-profiles", (req, res) => {
  const tenant = getTenantForAdmin(req as AuthedRequest, res);
  if (!tenant) return;
  void requireTenantFeature(req as AuthedRequest, res, tenant.id, "multiLocation").then((ok) => {
    if (!ok) return;
    res.json({ profiles: tenant.forwardingProfiles });
  });
});

app.post(
  "/api/admin/forwarding-profiles",
  asyncHandler(async (req: AuthedRequest, res) => {
    const tenant = getTenantForAdmin(req, res);
    if (!tenant) return;
    if (!(await requireTenantFeature(req, res, tenant.id, "multiLocation"))) return;
    const raw = req.body?.profiles;
    const profiles = Array.isArray(raw)
      ? raw
          .filter((p: unknown) => p != null && typeof (p as any).name === "string")
          .map((p: any) =>
            createForwardingProfile({
              id: p.id,
              name: String(p.name).trim(),
              number: typeof p.number === "string" ? p.number.trim() : "",
              role: typeof p.role === "string" ? p.role.trim() : "",
            }),
          )
      : [];
    logger.info("tenant_settings_save_attempt", {
      event: "tenant_settings_save_attempt",
      tenantId: tenant.id,
      settingArea: "forwarding_profiles",
      actorRole: adminActorRole(req),
    });
    const updated = tenants.setForwardingProfiles(tenant.id, profiles);
    if (!updated) return res.status(404).json({ error: "tenant_not_found" });
    logger.info("tenant_settings_save_success", {
      event: "tenant_settings_save_success",
      tenantId: tenant.id,
      settingArea: "forwarding_profiles",
      actorRole: adminActorRole(req),
    });
    const publish = await autoPublishTenantRuntimeAfterSave(tenant.id, {
      settingArea: "forwarding_profiles",
      actorRole: adminActorRole(req),
    });
    res.json({
      profiles: updated.forwardingProfiles,
      saved: true,
      published: publish.published,
      lastRuntimePublishedAt: publish.lastRuntimePublishedAt,
      ...(publish.publishError ? { publishError: publish.publishError } : {}),
      ...(publish.publishSkippedReason ? { publishSkippedReason: publish.publishSkippedReason } : {}),
    });
  }),
);

app.get("/api/admin/pricing", (req, res) => {
  const tenant = getTenantForAdmin(req as AuthedRequest, res);
  if (!tenant) return;
  void requireTenantFeature(req as AuthedRequest, res, tenant.id, "crmIntegration").then((ok) => {
    if (!ok) return;
    res.json(tenant.pricing);
  });
});

app.post(
  "/api/admin/pricing",
  asyncHandler(async (req: AuthedRequest, res) => {
    const tenant = getTenantForAdmin(req, res);
    if (!tenant) return;
    if (!(await requireTenantFeature(req, res, tenant.id, "crmIntegration"))) return;
    const parsed = parsePricingInfo(req.body);
    logger.info("tenant_settings_save_attempt", {
      event: "tenant_settings_save_attempt",
      tenantId: tenant.id,
      settingArea: "pricing",
      actorRole: adminActorRole(req),
    });
    const updated = tenants.setPricing(tenant.id, parsed);
    if (!updated) return res.status(404).json({ error: "tenant_not_found" });
    logger.info("tenant_settings_save_success", {
      event: "tenant_settings_save_success",
      tenantId: tenant.id,
      settingArea: "pricing",
      actorRole: adminActorRole(req),
    });
    const publish = await autoPublishTenantRuntimeAfterSave(tenant.id, {
      settingArea: "pricing",
      actorRole: adminActorRole(req),
    });
    res.json({
      ...updated.pricing,
      saved: true,
      published: publish.published,
      lastRuntimePublishedAt: publish.lastRuntimePublishedAt,
      ...(publish.publishError ? { publishError: publish.publishError } : {}),
      ...(publish.publishSkippedReason ? { publishSkippedReason: publish.publishSkippedReason } : {}),
    });
  }),
);

/* ────────────────────────────────────────────────
   Admin – Subscription / Billing
   ──────────────────────────────────────────────── */

app.get("/api/admin/subscription", asyncHandler(async (req, res) => {
  const tenant = getTenantForAdmin(req as AuthedRequest, res);
  if (!tenant) return;
  const owner = Boolean((req as AuthedRequest).ctx?.ownerConsole);
  res.json(await serializeSubscriptionPayload(tenant.id, { owner }));
}));

app.post("/api/admin/subscription", asyncHandler(async (req, res) => {
  const tenant = getTenantForAdmin(req as AuthedRequest, res);
  if (!tenant) return;
  if (!requireStaffBilling(req as AuthedRequest, res)) return;

  const {
    planName, priceCents, currency, billingFrequency, billingInterval, status,
    paymentMethodBrand, paymentMethodLast4,
    trialEndsAt, nextBillingDate, cancelledAt,
    showBillingPortal, adminNotes,
    stripePriceId, stripeProductId, stripeCustomerId, stripeSubscriptionId,
    planTier, applyTierDefaults,
  } = req.body || {};

  await upsertSubscription(tenant.id, {
    planName, priceCents, currency,
    billingFrequency: billingFrequency || billingInterval,
    status,
    paymentMethodBrand, paymentMethodLast4,
    trialEndsAt, nextBillingDate, cancelledAt,
    showBillingPortal, adminNotes,
    stripePriceId, stripeProductId, stripeCustomerId, stripeSubscriptionId,
  });

  const actor = (req as AuthedRequest).ctx?.idpSub || (req as AuthedRequest).ctx?.userId || "admin";
  if (applyTierDefaults !== false && typeof planTier === "string") {
    const parsed = planTierSchema.safeParse(planTier);
    if (parsed.success) {
      await applyPlanTierDefaultsKeepingService(tenant.id, parsed.data, actor);
      await trySyncTenantRuntimeConfigForLimits(tenant.id);
    }
  }

  void recordAudit({
    action: "stripe.subscription.save_local",
    path: req.path,
    tenantId: tenant.id,
    status: "200",
    details: {
      stripePriceId: stripePriceId || null,
      hasStripeSub: Boolean(stripeSubscriptionId),
      applyTierDefaults: applyTierDefaults !== false,
      planTier: planTier || null,
    },
  });

  res.json(await serializeSubscriptionPayload(tenant.id));
}));

app.delete("/api/admin/subscription", asyncHandler(async (req, res) => {
  const tenant = getTenantForAdmin(req as AuthedRequest, res);
  if (!tenant) return;
  if (!requireStaffBilling(req as AuthedRequest, res)) return;

  const existing = await getSubscription(tenant.id);
  if (!existing) {
    return res.json({ success: true, message: "No subscription to remove" });
  }

  const client = await dbPool.connect();
  try {
    await client.query("DELETE FROM tenant_subscriptions WHERE tenant_id = $1", [tenant.id]);
  } finally {
    client.release();
  }

  void recordAudit({
    action: "stripe.subscription.delete_local",
    path: req.path,
    tenantId: tenant.id,
    status: "200",
    details: { stripeSubscriptionId: existing.stripeSubscriptionId },
  });

  res.json({ success: true });
}));

app.patch("/api/admin/subscription", asyncHandler(async (req, res) => {
  const tenant = getTenantForAdmin(req as AuthedRequest, res);
  if (!tenant) return;
  if (!requireStaffBilling(req as AuthedRequest, res)) return;

  const existing = await getSubscription(tenant.id);
  const { showBillingPortal, adminNotes } = req.body || {};

  await upsertSubscription(tenant.id, {
    ...(existing || {}),
    showBillingPortal: showBillingPortal !== undefined ? showBillingPortal : existing?.showBillingPortal,
    adminNotes: adminNotes !== undefined ? adminNotes : existing?.adminNotes,
    planName: existing?.planName,
    priceCents: existing?.priceCents,
    status: existing?.status,
  });

  if (showBillingPortal !== undefined) {
    void recordAudit({
      action: "stripe.portal.toggle",
      path: req.path,
      tenantId: tenant.id,
      status: "200",
      details: { showBillingPortal: Boolean(showBillingPortal) },
    });
  }

  res.json(await serializeSubscriptionPayload(tenant.id));
}));

/* ────────────────────────────────────────────────
   Stripe – Webhook (public, raw body)
   ──────────────────────────────────────────────── */

app.post("/api/stripe/webhook", asyncHandler(async (req, res) => {
  if (!isStripeConfigured()) {
    return res.status(501).json({ error: "Stripe not configured" });
  }
  const sig = req.headers["stripe-signature"] as string;
  if (!sig) return res.status(400).json({ error: "Missing stripe-signature" });

  const rawBody = (req as any).rawBody as Buffer;
  if (!rawBody) return res.status(400).json({ error: "Missing raw body" });

  try {
    const result = await handleStripeWebhook(rawBody, sig);
    console.log(`[stripe] Webhook processed: ${result.event} tenant=${result.tenantId || "?"}`);
    res.json({ received: true, event: result.event });
  } catch (err: any) {
    console.error("[stripe] Webhook error:", err.message);
    res.status(400).json({ error: err.message });
  }
}));

/* ────────────────────────────────────────────────
   Stripe – Admin routes
   ──────────────────────────────────────────────── */

app.get("/api/admin/stripe/status", (req, res) => {
  const owner = Boolean((req as AuthedRequest).ctx?.ownerConsole);
  res.json({
    configured: isStripeConfigured(),
    liveMode: isStripeLiveMode(),
    publishableKey: owner ? null : process.env.STRIPE_PUBLISHABLE_KEY || null,
    webhookUrl: owner ? undefined : webhookPublicUrl(),
    webhookPath: "/api/stripe/webhook",
  });
});

app.get("/api/admin/stripe/plans", asyncHandler(async (req, res) => {
  const tierDefaults = listPlanDefaultsPayload();
  if (Boolean((req as AuthedRequest).ctx?.ownerConsole)) {
    return res.json({ plans: [], source: "hidden", ...tierDefaults });
  }
  if (!isStripeConfigured()) {
    return res.json({
      plans: await listStripePlans(),
      source: "catalog_defaults",
      liveMode: false,
      ...tierDefaults,
    });
  }
  const plans = await listStripePlans();
  res.json({
    plans,
    source: "stripe_catalog",
    liveMode: isStripeLiveMode(),
    webhookUrl: webhookPublicUrl(),
    ...tierDefaults,
  });
}));

app.get("/api/admin/plan-defaults", (_req, res) => {
  res.json(listPlanDefaultsPayload());
});

app.post("/api/admin/stripe/plans", asyncHandler(async (req, res) => {
  if (!requireStaffBilling(req as AuthedRequest, res)) return;
  return res.status(400).json({
    error: "catalog_readonly",
    message: "Creating Stripe products/prices is disabled. Use the live Receptionist catalog.",
  });
}));

app.delete("/api/admin/stripe/plans/:planId", asyncHandler(async (req, res) => {
  if (!requireStaffBilling(req as AuthedRequest, res)) return;
  return res.status(400).json({
    error: "catalog_readonly",
    message: "Archiving Stripe products/prices is disabled. Use the live Receptionist catalog.",
  });
}));

app.post("/api/admin/stripe/subscribe", asyncHandler(async (req, res) => {
  const tenant = getTenantForAdmin(req as AuthedRequest, res);
  if (!tenant) return;
  if (!requireStaffBilling(req as AuthedRequest, res)) return;
  if (!isStripeConfigured()) {
    return res.status(501).json({ error: "Stripe not configured" });
  }

  const { priceId, includeSetup, confirm, confirmLive, collectionMethod, applyTierDefaults, planTier } = req.body || {};
  if (!priceId || typeof priceId !== "string") {
    return res.status(400).json({ error: "priceId required" });
  }

  try {
    const result = await createStaffSubscription({
      tenantId: tenant.id,
      priceId,
      includeSetup: Boolean(includeSetup),
      confirm: confirm ?? confirmLive,
      tenantName: tenant.meta.name,
      collectionMethod:
        collectionMethod === "charge_automatically" || collectionMethod === "send_invoice"
          ? collectionMethod
          : undefined,
    });
    const actor = (req as AuthedRequest).ctx?.idpSub || (req as AuthedRequest).ctx?.userId || "admin";
    if (applyTierDefaults !== false) {
      const parsed = planTierSchema.safeParse(planTier);
      if (parsed.success) {
        await applyPlanTierDefaultsKeepingService(tenant.id, parsed.data, actor);
        await trySyncTenantRuntimeConfigForLimits(tenant.id);
      }
    }
    void recordAudit({
      action: "stripe.subscription.create",
      path: req.path,
      tenantId: tenant.id,
      status: "200",
      details: {
        priceId,
        includeSetup: Boolean(includeSetup),
        created: result.created,
        liveMode: isStripeLiveMode(),
        applyTierDefaults: applyTierDefaults !== false,
        planTier: planTier || null,
      },
    });
    res.json({
      ...result,
      subscription: await serializeSubscriptionPayload(tenant.id),
    });
  } catch (err: any) {
    const code = err?.code || "stripe_error";
    const status = code === "live_confirm_required" ? 400 : code === "unknown_catalog_price" ? 400 : 400;
    res.status(status).json({ error: code, message: err.message });
  }
}));

app.post("/api/admin/stripe/cancel", asyncHandler(async (req, res) => {
  const tenant = getTenantForAdmin(req as AuthedRequest, res);
  if (!tenant) return;
  if (!requireStaffBilling(req as AuthedRequest, res)) return;
  if (!isStripeConfigured()) {
    return res.status(501).json({ error: "Stripe not configured" });
  }
  try {
    await cancelStaffSubscription({
      tenantId: tenant.id,
      confirm: req.body?.confirm ?? req.body?.confirmLive,
      atPeriodEnd: req.body?.atPeriodEnd !== false,
    });
    void recordAudit({
      action: "stripe.subscription.cancel",
      path: req.path,
      tenantId: tenant.id,
      status: "200",
      details: { atPeriodEnd: req.body?.atPeriodEnd !== false, liveMode: isStripeLiveMode() },
    });
    res.json(await serializeSubscriptionPayload(tenant.id));
  } catch (err: any) {
    res.status(400).json({ error: err.code || "stripe_error", message: err.message });
  }
}));

app.post("/api/admin/stripe/checkout", asyncHandler(async (req, res) => {
  const tenant = getTenantForAdmin(req as AuthedRequest, res);
  if (!tenant) return;
  if (!requireStaffBilling(req as AuthedRequest, res)) return;
  if (!isStripeConfigured()) {
    return res.status(501).json({ error: "Stripe not configured" });
  }

  const { priceId, successUrl, cancelUrl, includeSetup } = req.body || {};
  if (!priceId) return res.status(400).json({ error: "priceId required" });

  const baseUrl = process.env.PUBLIC_BASE_URL || `http://localhost:${process.env.PORT || 4000}`;
  try {
    const session = await createCheckoutSession({
      tenantId: tenant.id,
      priceId,
      successUrl: successUrl || `${baseUrl}/portal?checkout=success`,
      cancelUrl: cancelUrl || `${baseUrl}/portal?checkout=cancelled`,
      tenantName: tenant.meta.name,
      includeSetup: Boolean(includeSetup),
    });
    res.json({ url: session.url, sessionId: session.id });
  } catch (err: any) {
    res.status(400).json({ error: err.code || "stripe_error", message: err.message });
  }
}));

app.post("/api/admin/stripe/portal", asyncHandler(async (req, res) => {
  const tenant = getTenantForAdmin(req as AuthedRequest, res);
  if (!tenant) return;
  if (!isStripeConfigured()) {
    return res.status(501).json({ error: "Stripe not configured" });
  }

  const owner = Boolean((req as AuthedRequest).ctx?.ownerConsole);
  const existing = await getSubscription(tenant.id);
  if (owner && !existing?.showBillingPortal) {
    return res.status(403).json({ error: "self_serve_disabled", message: "Self-service billing is not enabled for this account." });
  }
  if (owner && !existing?.stripeCustomerId) {
    return res.status(404).json({ error: "no_stripe_customer" });
  }

  const { returnUrl } = req.body || {};
  const baseUrl = process.env.PUBLIC_BASE_URL || `http://localhost:${process.env.PORT || 4000}`;
  const defaultReturn = owner ? `${baseUrl}/portal/billing` : `${baseUrl}/admin/billing`;

  try {
    const session = await createPortalSession({
      tenantId: tenant.id,
      returnUrl: returnUrl || defaultReturn,
      createCustomerIfMissing: !owner,
    });
    if (owner) {
      void recordAudit({
        action: "stripe.portal.open",
        path: req.path,
        tenantId: tenant.id,
        status: "200",
        details: { actor: "owner" },
      });
    }
    res.json({ url: session.url });
  } catch (err: any) {
    res.status(400).json({ error: err.code || "stripe_error", message: err.message });
  }
}));

app.post("/api/admin/stripe/sync", asyncHandler(async (req, res) => {
  const tenant = getTenantForAdmin(req as AuthedRequest, res);
  if (!tenant) return;
  if (!requireStaffBilling(req as AuthedRequest, res)) return;
  if (!isStripeConfigured()) {
    return res.status(501).json({ error: "Stripe not configured" });
  }

  try {
    const result = await syncTenantBillingFromStripe(tenant.id);
    void recordAudit({
      action: "stripe.sync",
      path: req.path,
      tenantId: tenant.id,
      status: "200",
      details: { changes: result.changes },
    });
    res.json({ ...result.subscription, changes: result.changes });
  } catch (err: any) {
    const status = err.code === "stripe_customer_deleted" ? 409 : 400;
    res.status(status).json({ error: err.code || "stripe_error", message: err.message });
  }
}));

/* ────────────────────────────────────────────────
   Admin – TTS config + preview (XTTS / Kokoro)
   ──────────────────────────────────────────────── */

// Extended TTS config type for API responses (uses string for mode to handle legacy compatibility)
type ExtendedTtsConfig = TTSConfig & {
  mode?: string;
  voice?: string;
  coquiTemperature?: number;
  coquiLengthPenalty?: number;
  coquiRepetitionPenalty?: number;
  coquiTopK?: number;
  coquiTopP?: number;
  coquiSpeed?: number;
  coquiSplitSentences?: boolean;
  chatterboxUrl?: string;
  chatterboxVariant?: string;
  qwen3TtsUrl?: string;
  magpieTtsUrl?: string;
  meloTtsUrl?: string;
  qwen3Instruct?: string;
  qwen3DoSample?: boolean;
  qwen3Temperature?: number;
  qwen3TopP?: number;
  qwen3TopK?: number;
  qwen3RepetitionPenalty?: number;
  qwen3MaxNewTokens?: number;
  qwen3NonStreamingMode?: boolean;
  qwen3SubtalkerDoSample?: boolean;
  qwen3SubtalkerTopK?: number;
  qwen3SubtalkerTopP?: number;
  qwen3SubtalkerTemperature?: number;
  qwen3Streaming?: boolean;
  misoTtsUrl?: string;
  misoMaxAudioLengthMs?: number;
  misoTemperature?: number;
  misoTopK?: number;
  magpieTemperature?: number;
  magpieCfgScale?: number;
  magpieTopK?: number;
  magpieUseCfg?: boolean;
  magpieApplyTn?: boolean;
  meloSdpRatio?: number;
  meloNoiseScale?: number;
  meloNoiseScaleW?: number;
};

const QWEN3_CUSTOMVOICE_VOICES = [
  { id: "Serena", label: "Serena — warm receptionist (best English female)" },
  { id: "Vivian", label: "Vivian — bright slightly edgy young female" },
  { id: "Sohee", label: "Sohee — warm emotional female" },
  { id: "Ono_Anna", label: "Ono Anna — playful light female" },
  { id: "Ryan", label: "Ryan — dynamic English male" },
  { id: "Aiden", label: "Aiden — sunny American male" },
  { id: "Uncle_Fu", label: "Uncle Fu — seasoned low male" },
  { id: "Dylan", label: "Dylan — clear Beijing male" },
  { id: "Eric", label: "Eric — lively Chengdu male" },
];

const MAGPIE_VOICES = [
  { id: "Aria", label: "Aria — bright female" },
  { id: "Jason", label: "Jason — clear male" },
  { id: "John", label: "John — warm male" },
  { id: "Leo", label: "Leo — deeper male" },
  { id: "Sofia", label: "Sofia — warm receptionist female" },
];

const MELO_VOICES = [
  { id: "EN-US", label: "EN-US — American English" },
  { id: "EN-BR", label: "EN-BR — British English" },
  { id: "EN-INDIA", label: "EN-INDIA — Indian English" },
  { id: "EN-AU", label: "EN-AU — Australian English" },
  { id: "EN-Default", label: "EN-Default — default English" },
  { id: "ES", label: "ES — Spanish" },
  { id: "FR", label: "FR — French" },
  { id: "ZH", label: "ZH — Chinese" },
  { id: "JP", label: "JP — Japanese" },
  { id: "KR", label: "KR — Korean" },
];

const KOKORO_VOICES = [
  { id: "af_bella", label: "af_bella — American English female" },
  { id: "af_heart", label: "af_heart — American English female" },
  { id: "af_nicole", label: "af_nicole — American English female" },
  { id: "af_sarah", label: "af_sarah — American English female" },
  { id: "af_sky", label: "af_sky — American English female" },
  { id: "am_adam", label: "am_adam — American English male" },
  { id: "am_michael", label: "am_michael — American English male" },
  { id: "bf_emma", label: "bf_emma — British English female" },
  { id: "bm_george", label: "bm_george — British English male" },
];

app.get("/api/tts/config", (req, res) => {
  const tenant = getTenantForAdmin(req as AuthedRequest, res);
  if (!tenant) return;

  const ar = req as AuthedRequest;
  const diagnostics =
    typeof ar.query?.diagnostics === "string" && ar.query.diagnostics === "1" && ar.ctx?.isSuperAdmin;

  // Superadmin operator console needs full URLs to edit infrastructure (trusted).
  if (ar.ctx?.isSuperAdmin) {
    const baseCfg = tenant.config.getTtsConfig();
    const extendedCfg: ExtendedTtsConfig = {
      ...baseCfg,
      mode: "kokoro_http",
      ttsMode: "kokoro_http",
    };
    (extendedCfg as { availableVoices?: Record<string, { id: string; label: string }[]> }).availableVoices = {
      kokoro_http: KOKORO_VOICES,
    };
    if ((baseCfg as any).defaultVoiceMode) {
      extendedCfg.defaultVoiceMode = (baseCfg as any).defaultVoiceMode;
    }
    if ((baseCfg as any).clonedVoice) {
      extendedCfg.clonedVoice = (baseCfg as any).clonedVoice;
    }
    if ((baseCfg as any).coquiXttsUrl) extendedCfg.coquiXttsUrl = (baseCfg as any).coquiXttsUrl;
    if ((baseCfg as any).kokoroUrl) extendedCfg.kokoroUrl = (baseCfg as any).kokoroUrl;
    if ((baseCfg as any).chatterboxUrl) extendedCfg.chatterboxUrl = (baseCfg as any).chatterboxUrl;
    if ((baseCfg as any).chatterboxVariant) {
      extendedCfg.chatterboxVariant = (baseCfg as any).chatterboxVariant;
    }
    if ((baseCfg as any).qwen3TtsUrl) extendedCfg.qwen3TtsUrl = (baseCfg as any).qwen3TtsUrl;
    if ((baseCfg as any).misoTtsUrl) extendedCfg.misoTtsUrl = (baseCfg as any).misoTtsUrl;
    if ((baseCfg as any).magpieTtsUrl) extendedCfg.magpieTtsUrl = (baseCfg as any).magpieTtsUrl;
    if ((baseCfg as any).meloTtsUrl) extendedCfg.meloTtsUrl = (baseCfg as any).meloTtsUrl;
    if ((baseCfg as any).qwen3Instruct) extendedCfg.qwen3Instruct = (baseCfg as any).qwen3Instruct;
    const bq = baseCfg as any;
    if (bq.qwen3DoSample !== undefined) extendedCfg.qwen3DoSample = bq.qwen3DoSample;
    if (bq.qwen3Temperature !== undefined) extendedCfg.qwen3Temperature = bq.qwen3Temperature;
    if (bq.qwen3TopP !== undefined) extendedCfg.qwen3TopP = bq.qwen3TopP;
    if (bq.qwen3TopK !== undefined) extendedCfg.qwen3TopK = bq.qwen3TopK;
    if (bq.qwen3RepetitionPenalty !== undefined) extendedCfg.qwen3RepetitionPenalty = bq.qwen3RepetitionPenalty;
    if (bq.qwen3MaxNewTokens !== undefined) extendedCfg.qwen3MaxNewTokens = bq.qwen3MaxNewTokens;
    if (bq.qwen3NonStreamingMode !== undefined) extendedCfg.qwen3NonStreamingMode = bq.qwen3NonStreamingMode;
    if (bq.qwen3SubtalkerDoSample !== undefined) extendedCfg.qwen3SubtalkerDoSample = bq.qwen3SubtalkerDoSample;
    if (bq.qwen3SubtalkerTopK !== undefined) extendedCfg.qwen3SubtalkerTopK = bq.qwen3SubtalkerTopK;
    if (bq.qwen3SubtalkerTopP !== undefined) extendedCfg.qwen3SubtalkerTopP = bq.qwen3SubtalkerTopP;
    if (bq.qwen3SubtalkerTemperature !== undefined) {
      extendedCfg.qwen3SubtalkerTemperature = bq.qwen3SubtalkerTemperature;
    }
    if (bq.qwen3Streaming !== undefined) extendedCfg.qwen3Streaming = bq.qwen3Streaming;
    if (bq.misoMaxAudioLengthMs !== undefined) extendedCfg.misoMaxAudioLengthMs = bq.misoMaxAudioLengthMs;
    if (bq.misoTemperature !== undefined) extendedCfg.misoTemperature = bq.misoTemperature;
    if (bq.misoTopK !== undefined) extendedCfg.misoTopK = bq.misoTopK;
    if (bq.magpieTemperature !== undefined) extendedCfg.magpieTemperature = bq.magpieTemperature;
    if (bq.magpieCfgScale !== undefined) extendedCfg.magpieCfgScale = bq.magpieCfgScale;
    if (bq.magpieTopK !== undefined) extendedCfg.magpieTopK = bq.magpieTopK;
    if (bq.magpieUseCfg !== undefined) extendedCfg.magpieUseCfg = bq.magpieUseCfg;
    if (bq.magpieApplyTn !== undefined) extendedCfg.magpieApplyTn = bq.magpieApplyTn;
    if (bq.meloSdpRatio !== undefined) extendedCfg.meloSdpRatio = bq.meloSdpRatio;
    if (bq.meloNoiseScale !== undefined) extendedCfg.meloNoiseScale = bq.meloNoiseScale;
    if (bq.meloNoiseScaleW !== undefined) extendedCfg.meloNoiseScaleW = bq.meloNoiseScaleW;
    if (bq.coquiTemperature !== undefined) extendedCfg.coquiTemperature = bq.coquiTemperature;
    if (bq.coquiLengthPenalty !== undefined) extendedCfg.coquiLengthPenalty = bq.coquiLengthPenalty;
    if (bq.coquiRepetitionPenalty !== undefined) extendedCfg.coquiRepetitionPenalty = bq.coquiRepetitionPenalty;
    if (bq.coquiTopK !== undefined) extendedCfg.coquiTopK = bq.coquiTopK;
    if (bq.coquiTopP !== undefined) extendedCfg.coquiTopP = bq.coquiTopP;
    if (bq.coquiSpeed !== undefined) extendedCfg.coquiSpeed = bq.coquiSpeed;
    if (bq.coquiSplitSentences !== undefined) extendedCfg.coquiSplitSentences = bq.coquiSplitSentences;
    if (diagnostics) {
      (extendedCfg as any).diagnostics = ttsDiagnosticsPayload(baseCfg);
    }
    res.json(extendedCfg);
    return;
  }

  const safe = tenant.config.getSafeTtsConfig();
  const payload: SafeTtsPublicConfig & {
    mode: string;
    diagnostics?: Record<string, unknown>;
    availableVoices?: Record<string, { id: string; label: string }[]>;
  } = {
    ...safe,
    mode: "kokoro_http",
    availableVoices: {
      kokoro_http: KOKORO_VOICES,
    },
  };
  if (diagnostics) {
    payload.diagnostics = ttsDiagnosticsPayload(tenant.config.getTtsConfig());
  }

  res.json(payload);
});

app.post("/api/tts/config", async (req: AuthedRequest, res) => {
  const tenant = getTenantForAdmin(req, res);
  if (!tenant) return;

  const body = req.body as Partial<ExtendedTtsConfig> & Record<string, unknown>;
  const {
    voiceId,
    language,
    rate,
    preset,
  } = body;

  // Provider URL fields are infrastructure (point at internal STT/TTS hosts).
  // They are admin-curated and must not be set by tenant clients via the portal.
  // Reject any client request that tries to override them; superadmin (env/master/db
  // admin key) may still set them via the admin console.
  const RAW_PROVIDER_URL_FIELDS = [
    "xttsUrl",
    "coquiXttsUrl",
    "kokoroUrl",
    "chatterboxUrl",
    "qwen3TtsUrl",
    "misoTtsUrl",
    "magpieTtsUrl",
    "meloTtsUrl",
  ] as const;
  const clientSubmittedRawUrls = RAW_PROVIDER_URL_FIELDS.some(
    (k) => typeof (body as any)[k] === "string" && (body as any)[k].trim().length > 0
  );
  const isSuperAdmin = req.ctx?.isSuperAdmin === true;
  if (clientSubmittedRawUrls && !isSuperAdmin) {
    return res.status(403).json({
      error: "provider_url_admin_only",
      message:
        "Provider URLs (TTS engine endpoints) are infrastructure and can only be configured by a platform admin. Pick a provider mode and the platform will route to the configured backend.",
    });
  }
  const xttsUrl = isSuperAdmin ? body.xttsUrl : undefined;
  const coquiXttsUrl = isSuperAdmin ? body.coquiXttsUrl : undefined;
  const kokoroUrl = isSuperAdmin ? body.kokoroUrl : undefined;
  const chatterboxUrl = isSuperAdmin ? body.chatterboxUrl : undefined;
  const qwen3TtsUrl = isSuperAdmin ? body.qwen3TtsUrl : undefined;
  const misoTtsUrl = isSuperAdmin ? body.misoTtsUrl : undefined;
  const magpieTtsUrl = isSuperAdmin ? body.magpieTtsUrl : undefined;
  const meloTtsUrl = isSuperAdmin ? body.meloTtsUrl : undefined;

  // Determine the TTS URL based on mode (admin-supplied or undefined → keep existing)
  const urlCandidate = coquiXttsUrl || kokoroUrl || xttsUrl || chatterboxUrl || qwen3TtsUrl || misoTtsUrl || magpieTtsUrl || meloTtsUrl;
  let ttsUrlValue: string | undefined;
  if (typeof urlCandidate === "string" && urlCandidate.trim().length > 0) {
    const u = urlCandidate.trim();
    try {
      new URL(u);
      ttsUrlValue = u;
    } catch {
      return res.status(400).json({ error: "invalid_tts_url", message: "TTS URL must be a valid URL." });
    }
  }

  let presetValue: VoicePreset | undefined;
  if (preset && typeof preset === "string") {
    const lower = preset.toLowerCase() as VoicePreset;
    if (["neutral", "warm", "energetic", "calm"].includes(lower)) {
      presetValue = lower;
    }
  }

  const safeRateRaw = toFiniteNumber(rate);
  const safeRate =
    safeRateRaw !== undefined ? clamp(safeRateRaw, 0.8, 1.2) : undefined;

  // Build the extended config object (bounded strings — avoids huge payloads / DB surprises)
  const configUpdate: any = {
    xttsUrl: ttsUrlValue,
    voiceId: coerceKokoroVoiceId(sanitizeTtsShortText(voiceId, 100) || undefined),
    language: sanitizeTtsShortText(language, 32),
    rate: safeRate,
    preset: presetValue,
    ttsMode: "kokoro_http",
    kokoroUrl: ttsUrlValue,
    chatterboxUrl: undefined,
    chatterboxVariant: undefined,
    qwen3TtsUrl: undefined,
    misoTtsUrl: undefined,
    qwen3Instruct: undefined,
    defaultVoiceMode: "preset",
    clonedVoice: undefined,
  };
  clearQwen3GenFields(configUpdate);
  clearMisoGenFields(configUpdate);
  clearCoquiGenFields(configUpdate);

  const updated = tenant.config.setTtsConfig(configUpdate);

  tenants.persistConfig(tenant.id);

  /** Push TTS/STT to Redis so live PSTN calls match what was just saved (same as Publish to voice runtime). */
  let runtimePublish:
    | { ok: true }
    | { ok: false; error: string; message: string }
    | undefined;
  if (ENABLE_RUNTIME_ADMIN) {
    try {
      await syncTenantRuntimeConfigForLimits(tenant.id);
      runtimePublish = { ok: true };
    } catch (err: unknown) {
      if (err instanceof BuildRuntimeConfigError) {
        runtimePublish = {
          ok: false,
          error: err.code,
          message: err.message,
        };
      } else {
        const msg = err instanceof Error ? err.message : String(err);
        runtimePublish = {
          ok: false,
          error: "runtime_publish_failed",
          message: msg,
        };
      }
      console.warn("[POST /api/tts/config] voice runtime Redis publish failed:", err);
    }
  }

  const diagnostics =
    typeof req.query?.diagnostics === "string" && req.query.diagnostics === "1" && req.ctx?.isSuperAdmin;

  if (req.ctx?.isSuperAdmin) {
    const response: ExtendedTtsConfig = {
      ...updated,
      mode: configUpdate.ttsMode,
      ttsMode: configUpdate.ttsMode,
      defaultVoiceMode: configUpdate.defaultVoiceMode,
      clonedVoice: configUpdate.clonedVoice,
      coquiXttsUrl: configUpdate.coquiXttsUrl,
      kokoroUrl: configUpdate.kokoroUrl,
      chatterboxUrl: configUpdate.chatterboxUrl,
      chatterboxVariant: configUpdate.chatterboxVariant,
      qwen3TtsUrl: configUpdate.qwen3TtsUrl,
      misoTtsUrl: configUpdate.misoTtsUrl,
      magpieTtsUrl: configUpdate.magpieTtsUrl,
      meloTtsUrl: configUpdate.meloTtsUrl,
      qwen3Instruct: configUpdate.qwen3Instruct,
    };
    const payload: Record<string, unknown> = {
      ...response,
      ...(runtimePublish ? { runtimePublish } : {}),
    };
    if (diagnostics) {
      payload.diagnostics = ttsDiagnosticsPayload(updated);
    }
    res.json(payload);
    return;
  }

  const safeOut = tenant.config.getSafeTtsConfig();
  const payload: Record<string, unknown> = {
    ...safeOut,
    mode: safeOut.ttsMode,
    ...(runtimePublish ? { runtimePublish } : {}),
  };
  if (diagnostics) {
    payload.diagnostics = ttsDiagnosticsPayload(updated);
  }

  res.json(payload);
});

app.post("/api/tts/preview", async (req, res) => {
  const tenant = getTenantForAdmin(req as AuthedRequest, res);
  if (!tenant) return;

  let responseStarted = false;
  try {
    const raw = req.body as { text?: unknown };
    const text = resolvePreviewText(raw?.text);
    const cfg = applyPreviewOverrides(tenant.config.getTtsConfig(), raw);

    // Send headers before waiting on TTS so reverse proxies (e.g. Cloudflare) see an
    // immediate response and are less likely to return 502 while synthesis runs.
    res.status(200);
    res.setHeader("Content-Type", "audio/wav");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Accel-Buffering", "no");
    if (typeof res.flushHeaders === "function") {
      res.flushHeaders();
    }
    responseStarted = true;

    const { body: audio } = await synthesizeTtsPreview(cfg, text);
    res.end(audio);
  } catch (err: unknown) {
    if (responseStarted) {
      logger.error("POST /api/tts/preview failed after headers sent", {
        err,
        tenantId: tenant.id,
      });
      res.destroy();
      return;
    }
    const msg = err instanceof Error ? err.message : String(err);
    if (msg === "tts_url_missing" || msg.includes("tts_url_missing")) {
      return res.status(400).json({
        error: "tts_url_missing",
        message: "Set the TTS server URL in Step 3 Voice for this business.",
      });
    }
    logger.error("POST /api/tts/preview failed", { err, tenantId: tenant.id });
    return res.status(502).json({
      error: "tts_preview_failed",
      message: msg,
    });
  }
});

/** Fast 202 + poll — avoids Cloudflare/proxy timeouts on long single responses. */
app.post("/api/tts/preview/async", async (req, res) => {
  const tenant = getTenantForAdmin(req as AuthedRequest, res);
  if (!tenant) return;

  try {
    const raw = req.body as { text?: unknown };
    const text = resolvePreviewText(raw?.text);
    const cfg = applyPreviewOverrides(tenant.config.getTtsConfig(), raw);
    const id = await createPreviewJob(tenant.id, cfg, text);
    res.status(202).json({ id });
  } catch (err: unknown) {
    const m = err instanceof Error ? err.message : String(err);
    if (m === "tts_preview_jobs_busy") {
      return res.status(503).json({
        error: "tts_preview_jobs_busy",
        message: "Too many preview jobs in flight; wait a moment and try again.",
      });
    }
    throw err;
  }
});

/** Poll responses use HTTP 200 + JSON even for failures so CDNs (e.g. Cloudflare) do not replace JSON with HTML error pages. */
app.get("/api/tts/preview/async/:id", async (req, res) => {
  const tenant = getTenantForAdmin(req as AuthedRequest, res);
  if (!tenant) return;

  const { id } = req.params;
  if (!id || !isUuid(id)) {
    return res.status(400).json({ error: "invalid_id" });
  }

  const result = await pollPreviewJob(id, tenant.id);
  switch (result.kind) {
    case "not_found":
      return res.status(200).json({
        status: "failed",
        error: "not_found",
        message:
          "Preview job not found (expired or created on another server). With multiple control-plane replicas, REDIS_URL must be set so jobs are shared in Redis.",
      });
    case "forbidden":
      return res.status(200).json({
        status: "failed",
        error: "forbidden",
        message: "Not allowed to read this preview job.",
      });
    case "pending":
      return res.status(200).json({ status: "pending" });
    case "error": {
      const msg =
        result.code === "tts_url_missing"
          ? "Set the TTS server URL in Step 3 Voice for this business."
          : result.message;
      return res.status(200).json({
        status: "failed",
        error: result.code,
        message: msg,
      });
    }
    case "done": {
      // JSON + base64 avoids binary audio/wav through some proxies (e.g. Cloudflare quirks).
      const accept = String(req.headers.accept || "").toLowerCase();
      const wantJson = accept.split(",").some((part) => {
        const p = (part.trim().split(";")[0] || "").trim();
        return p === "application/json";
      });
      if (wantJson) {
        return res.status(200).json({
          status: "done",
          encoding: "base64",
          audioWavBase64: result.body.toString("base64"),
        });
      }
      res.setHeader("Content-Type", "audio/wav");
      res.setHeader("Cache-Control", "no-store");
      return res.send(result.body);
    }
  }
});

/* ────────────────────────────────────────────────
   Admin – health / analytics / calls / telephony secret
   ──────────────────────────────────────────────── */

app.get("/api/admin/telephony/secret", (req, res) => {
  const tenant = getTenantForAdmin(req as AuthedRequest, res);
  if (!tenant) return;

  void secretStore
    .hasSecret(tenant.id, "telephony_hmac_secret")
    .then((has) => res.json({ hasSecret: has }))
    .catch((err) => {
      console.error("GET /api/admin/telephony/secret error:", err);
      res.status(500).json({ error: "internal_error" });
    });
});

app.post("/api/admin/telephony/secret", (req, res) => {
  const tenant = getTenantForAdmin(req as AuthedRequest, res);
  if (!tenant) return;

  const { secret } = req.body as { secret?: string };
  const sanitized = sanitizeEnvValue(secret);
  if (!sanitized) {
    return res.status(400).json({ error: "secret_required" });
  }

  void secretStore
    .setSecret(tenant.id, "telephony_hmac_secret", sanitized)
    .then(() => res.json({ status: "ok" }))
    .catch((err) => {
      console.error("POST /api/admin/telephony/secret error:", err);
      res.status(500).json({ error: "internal_error" });
    });
});

/* ────────────────────────────────────────────────
   Admin – Cloudflare Tunnel Token (read-only status)
   ────────────────────────────────────────────────
   The Cloudflare tunnel token is global infrastructure used by the cloudflared
   sidecar at process boot. It must be set out-of-band (env / orchestrator /
   secret manager) before the tunnel starts; mutating process.env from a request
   handler is unsafe (multi-worker incoherence, no persistence across restarts,
   and previously was reachable by any tenant viewer JWT).

   GET is restricted to superadmin and only reports whether a token is present.
   POST is intentionally disabled and returns 410 with operator instructions. */

app.get("/api/admin/cloudflare/token", adminGuard("admin"), (req: AuthedRequest, res) => {
  if (!requireSuperAdminCtx(req, res)) return;
  const current = (process.env.CLOUDFLARE_TUNNEL_TOKEN || "").trim();
  res.json({ hasToken: current.length > 0 });
});

app.post("/api/admin/cloudflare/token", adminGuard("admin"), (req: AuthedRequest, res) => {
  if (!requireSuperAdminCtx(req, res)) return;
  res.status(410).json({
    error: "cloudflare_token_set_via_env",
    message:
      "Set CLOUDFLARE_TUNNEL_TOKEN in the deploy environment (.env / orchestrator secret) and restart the cloudflared sidecar. The control plane no longer mutates global process.env from a request handler.",
  });
});

// ────────────────────────────────────────────────
// Voice Recording Upload Endpoint
// ────────────────────────────────────────────────
app.post(
  "/api/admin/voice-recordings",
  voiceRecordingUpload.single("audio"),
  (req, res) => {
    const tenant = getTenantForAdmin(req as AuthedRequest, res);
    if (!tenant) return;

    if (!req.file) {
      return res.status(400).json({ error: "no_file", message: "No audio file uploaded" });
    }

    // Construct URL for the uploaded file
    // In production, this should be a CDN or S3 URL
    const baseUrl = process.env.VOICE_RECORDINGS_BASE_URL || `${req.protocol}://${req.get("host")}`;
    const relativePath = path.relative(path.join(__dirname, "..", "public"), req.file.path);
    const fileUrl = `${baseUrl}/${relativePath.replace(/\\/g, "/")}`;

    // Log the upload for audit
    void recordAudit({
      tenantId: tenant.id,
      action: "voice_recording_uploaded",
      path: "/api/admin/voice-recordings",
      status: "success",
    });

    res.json({
      status: "ok",
      url: fileUrl,
      filename: req.file.filename,
      size: req.file.size,
    });
  }
);

// Error handler for multer
app.use((err: any, _req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (err instanceof multer.MulterError) {
    if (err.code === "LIMIT_FILE_SIZE") {
      return res.status(400).json({ error: "file_too_large", message: "File size exceeds 10MB limit" });
    }
    return res.status(400).json({ error: "upload_error", message: err.message });
  }
  if (err && err.message === "Only WAV files are allowed") {
    return res.status(400).json({ error: "invalid_file_type", message: err.message });
  }
  next(err);
});

app.get("/api/admin/health", (req, res) => {
  const tenant = getTenantForAdmin(req as AuthedRequest, res);
  if (!tenant) return;

  const ar = req as AuthedRequest;
  const cfg = tenant.config.get();
  const safeTts = tenant.config.getSafeTtsConfig();
  const safeStt = tenant.config.getSafeSttPublic();

  const hasOpenAIApiKey =
    hasUsableApiKey(cfg.openaiApiKey) || hasUsableApiKey(process.env.OPENAI_API_KEY);
  const localLlmConfigured = Boolean((cfg.localUrl || process.env.LOCAL_LLM_URL || "").trim());

  const llmStatus =
    cfg.provider === "openai"
      ? hasOpenAIApiKey
        ? "ready"
        : "missing_api_key"
      : localLlmConfigured
        ? "configured"
        : "defaulting";

  const activeCallsByTenant: Record<string, number> = {};
  let activeCallsGlobal = 0;

  for (const meta of tenants.listMetas()) {
    const t = tenants.getOrCreate(meta.id);
    const n = t.calls.countLiveCalls();
    activeCallsByTenant[t.id] = n;
    activeCallsGlobal += n;
  }

  const ttsAny =
    safeTts.xttsEndpointConfigured ||
    safeTts.coquiXttsEndpointConfigured ||
    safeTts.kokoroEndpointConfigured ||
    safeTts.chatterboxEndpointConfigured ||
    safeTts.qwen3EndpointConfigured ||
    safeTts.misoEndpointConfigured ||
    safeTts.ttsMode === "openai_tts" ||
    safeTts.ttsMode === "elevenlabs";

  const llmOk = llmStatus === "ready" || llmStatus === "configured" || llmStatus === "defaulting";
  const sttOk = Boolean(safeStt.whisperEndpointConfigured);
  const servicesOk = llmOk && sttOk && ttsAny;

  const payload: Record<string, unknown> = {
    status: servicesOk ? "ok" : "degraded",
    server: "ok",
    timestamp: new Date().toISOString(),
    serverUptimeSec: Math.floor(process.uptime()),
    activeCalls: activeCallsGlobal,
    activeCallsGlobal,
    activeCallsByTenant,
    llm: {
      provider: cfg.provider,
      status: llmStatus,
      model: cfg.openaiModel,
      hasOpenAIApiKey,
      localLlmEndpointConfigured: localLlmConfigured,
    },
    stt: {
      status: safeStt.whisperEndpointConfigured ? "configured" : "missing",
      whisperEndpointConfigured: safeStt.whisperEndpointConfigured,
    },
    tts: {
      status: ttsAny ? "configured" : "missing",
      ttsMode: safeTts.ttsMode,
      voiceId: safeTts.voiceId,
      language: safeTts.language,
      preset: safeTts.preset,
      rate: safeTts.rate,
      chatterboxVariant: safeTts.chatterboxVariant,
      xttsEndpointConfigured: safeTts.xttsEndpointConfigured,
      kokoroEndpointConfigured: safeTts.kokoroEndpointConfigured,
      coquiXttsEndpointConfigured: safeTts.coquiXttsEndpointConfigured,
      chatterboxEndpointConfigured: safeTts.chatterboxEndpointConfigured,
      qwen3EndpointConfigured: safeTts.qwen3EndpointConfigured,
      misoEndpointConfigured: safeTts.misoEndpointConfigured,
      openaiTtsConfigured: safeTts.openaiTtsConfigured,
      elevenlabsConfigured: safeTts.elevenlabsConfigured,
    },
  };

  const diagnostics =
    typeof ar.query?.diagnostics === "string" && ar.query.diagnostics === "1" && ar.ctx?.isSuperAdmin;
  if (diagnostics) {
    const fullTts = tenant.config.getTtsConfig();
    const fullStt = tenant.config.getSttConfig();
    payload.diagnostics = {
      stt: { whisperUrl: redactHttpUrlToPlaceholder(fullStt.whisperUrl) },
      tts: ttsDiagnosticsPayload(fullTts),
      llm: { localUrl: redactHttpUrlToPlaceholder(cfg.localUrl) },
    };
  }

  res.json(payload);
});

app.get(
  "/api/admin/analytics",
  asyncHandler(async (req: AuthedRequest, res) => {
    const tenant = getTenantForAdmin(req, res);
    if (!tenant) return;
    if (!(await requireTenantFeature(req, res, tenant.id, "advancedAnalytics"))) return;
    res.setHeader("Cache-Control", "no-store, private");
    res.setHeader("Pragma", "no-cache");
    const daysRaw = Number(req.query.days);
    const days = Number.isFinite(daysRaw) ? Math.min(90, Math.max(1, Math.round(daysRaw))) : 30;
    const payload = await getCallAnalyticsPayloadForTenant(tenant.id, days);
    res.json(payload);
  }),
);

/**
 * POST endpoint for the voice runtime to report analytics events.
 * Accepts: { tenantId, event: "call_started" | "caller_message", text?: string }
 */
app.post("/api/runtime/analytics", adminGuard("admin"), (req: AuthedRequest, res) => {
  const { tenantId, event, text } = req.body as {
    tenantId?: string;
    event?: string;
    text?: string;
  };

  if (!tenantId || typeof tenantId !== "string") {
    return res.status(400).json({ error: "tenant_id_required" });
  }

  // Tenant binding: only superadmin (env/master/db admin key, used by the voice runtime)
  // may publish analytics for arbitrary tenants. JWT users are scoped to their own tenant.
  if (!ensureTenantAccess(req, res, tenantId)) return;

  const tenant = tenants.getOrCreate(tenantId);

  if (event === "call_started") {
    tenant.analytics.recordNewCall();
    return res.json({ status: "ok", event: "call_started" });
  }

  if (event === "caller_message") {
    if (typeof text === "string" && text.trim()) {
      tenant.analytics.recordCallerMessage(text.trim());
    }
    return res.json({ status: "ok", event: "caller_message" });
  }

  return res.status(400).json({ error: "invalid_event", validEvents: ["call_started", "caller_message"] });
});

app.get(
  "/api/admin/calls",
  asyncHandler(async (req: AuthedRequest, res) => {
    const tenant = getTenantForAdmin(req, res);
    if (!tenant) return;
    res.setHeader("Cache-Control", "no-store, private");
    res.setHeader("Pragma", "no-cache");
    const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 200);
    const filter = typeof req.query.filter === "string" ? req.query.filter : "all";
    const fetchLimit = Math.min(200, Math.max(limit * 2, limit));
    const rows = dedupeCallHistoryRows(await listCallsForTenantDb(tenant.id, fetchLimit)).slice(0, limit);
    const limits = await getTenantLimits(tenant.id);
    const presented = await Promise.all(
      rows.map(async (row) => {
        const lead =
          row.lead && typeof row.lead === "object"
            ? (row.lead as Record<string, unknown>)
            : {};
        const callControlId =
          typeof lead.voiceCallControlId === "string" ? lead.voiceCallControlId.trim() : "";
        let quality: Record<string, unknown> | null = null;
        if (callControlId) {
          const got = await getCallQualitySummaryForCall(tenant.id, callControlId);
          if (got?.summary && typeof got.summary === "object") {
            quality = got.summary as Record<string, unknown>;
          }
        }
        return presentAdminCall(row, quality, { includeRecording: Boolean(limits.callRecording) });
      }),
    );
    const missed = presented.filter((call) => call.missed).length;
    const calls = filter === "missed" ? presented.filter((call) => call.missed) : presented;
    res.json({
      calls,
      tenantId: tenant.id,
      limit,
      counts: { total: presented.length, missed },
    });
  }),
);

/** Superadmin-only: confirm Postgres has recent call rows for a tenant (no PII). */
app.get(
  "/api/admin/diagnostics/call-db-check",
  adminGuard("admin"),
  asyncHandler(async (req: AuthedRequest, res) => {
    if (!requireSuperAdminCtx(req, res)) return;
    const rawTid = typeof req.query.tenantId === "string" ? req.query.tenantId.trim() : "";
    const tenantId = rawTid || DEFAULT_TENANT_ID;
    if (!ensureTenantAccess(req, res, tenantId)) return;
    res.setHeader("Cache-Control", "no-store, private");
    const rows = await listCallsForTenantDb(tenantId, 1);
    res.json({
      tenantId,
      hasRows: rows.length > 0,
      latestCallId: rows[0]?.id ?? null,
      latestUpdatedAt: rows[0]?.updated_at ?? null,
    });
  }),
);

/**
 * POST endpoint for the voice runtime to report call state updates.
 * Accepts: { tenantId, callId, action: "start" | "update" | "end", callState?: CallState }
 */
app.post("/api/runtime/calls", adminGuard("admin"), async (req: AuthedRequest, res) => {
  const { tenantId, callId, action, callState } = req.body as {
    tenantId?: string;
    callId?: string;
    action?: string;
    callState?: {
      callerId?: string;
      stage?: string;
      lead?: Record<string, unknown>;
      history?: Array<{ role: string; content: string }>;
    };
  };

  if (!tenantId || typeof tenantId !== "string") {
    return res.status(400).json({ error: "tenant_id_required" });
  }

  // Tenant binding: only superadmin (env/master/db admin key, used by the voice runtime)
  // may publish call state for arbitrary tenants. JWT users are scoped to their own tenant.
  if (!ensureTenantAccess(req, res, tenantId)) return;

  const tenant = tenants.getOrCreate(tenantId);

  if (action === "start") {
    const limits = await getTenantLimits(tenantId);
    if (limits.billingStatus === "suspended" || limits.billingStatus === "canceled") {
      return res.status(403).json({ error: "tenant_billing_suspended" });
    }
    const callerId = callState?.callerId || undefined;
    const call = tenant.calls.createCall(callerId, callId);
    tenant.analytics.recordNewCall();
    await recordTenantCallStarted(tenantId);
    await upsertCallRowMerge({
      id: call.id,
      tenant_id: tenantId,
      caller_id: callerId ?? null,
      stage: call.stage,
      lead: call.lead,
      history: [],
    });
    await upsertCutoverItem(
      tenantId,
      "did_inbound",
      true,
      "Verified by a runtime inbound call start",
    );
    return res.json({ status: "ok", callId: call.id });
  }

  if (action === "update" && callId) {
    const existing = tenant.calls.getCall(callId);
    if (!existing) {
      return res.status(404).json({ error: "call_not_found" });
    }
    const updated = tenant.calls.save({
      ...existing,
      ...(callState?.stage ? { stage: callState.stage as any } : {}),
      ...(callState?.lead ? { lead: { ...existing.lead, ...callState.lead } } : {}),
      ...(callState?.history ? { history: callState.history as any } : {}),
    });
    return res.json({ status: "ok", call: updated });
  }

  if (action === "end" && callId) {
    const ccLog = String(callId).trim().slice(0, 120);
    logger.info("call_history_store_attempt", {
      event: "call_history_store_attempt",
      tenantId,
      callControlId: ccLog,
    });

    const endingCall = callId ? tenant.calls.getCall(callId) : undefined;
    let persistId = endingCall?.id;
    if (!persistId && callId) {
      persistId = (await findCallByVoiceControlId(tenantId, callId))?.id;
    }
    if (!persistId && (callState?.callerId || endingCall?.callerId)) {
      persistId = (await findOpenGreetingCall(
        tenantId,
        String(callState?.callerId || endingCall?.callerId || ""),
      ))?.id;
    }
    const historyForDb = Array.isArray(callState?.history)
      ? (callState!.history as unknown[])
      : endingCall
        ? (endingCall.history as unknown[])
        : [];
    const durationMsForStore =
      endingCall?.createdAt != null ? Math.max(0, Date.now() - endingCall.createdAt) : undefined;
    const mergedLeadForEnd = {
      ...(typeof endingCall?.lead === "object" && endingCall.lead
        ? (endingCall.lead as Record<string, unknown>)
        : {}),
      ...(typeof callState?.lead === "object" && callState.lead
        ? callState.lead
        : {}),
      voiceCallControlId: callId,
      ...(durationMsForStore != null ? { durationMs: durationMsForStore } : {}),
    };

    try {
      if (persistId) {
        await upsertCallRowMerge({
          id: persistId,
          tenant_id: tenantId,
          caller_id: callState?.callerId ?? endingCall?.callerId ?? null,
          stage: "end",
          lead: mergedLeadForEnd,
          history: historyForDb,
        });
        if (callId) tenant.calls.deleteCall(callId);
        else tenant.calls.deleteCall(persistId);
      } else {
        await upsertCallRowMerge({
          id: randomUUID(),
          tenant_id: tenantId,
          caller_id: callState?.callerId ?? null,
          stage: "end",
          lead: mergedLeadForEnd,
          history: historyForDb,
        });
      }
      logger.info("call_history_store_success", {
        event: "call_history_store_success",
        tenantId,
        callControlId: ccLog,
      });
    } catch (err) {
      logger.error("call_history_store_failed", {
        event: "call_history_store_failed",
        tenantId,
        callControlId: ccLog,
        err: err instanceof Error ? err.message : String(err),
      });
      return res.status(500).json({ error: "call_history_persist_failed" });
    }

    const durationMs =
      endingCall?.createdAt != null
        ? Date.now() - endingCall.createdAt
        : undefined;
    await recordTenantCallEnded({
      tenantId,
      durationMs,
      fallbackUsed: String((req.body as { replySource?: string })?.replySource || "").includes(
        "fallback",
      ),
    });
    const workflowEvent: CallEndedEvent = {
      type: "call_ended",
      tenantId,
      callId,
      callerId: endingCall?.callerId ?? callState?.callerId,
      durationMs,
      turns: (historyForDb as any) ?? [],
      transcript: (req.body as { transcript?: string }).transcript,
      lead: mergedLeadForEnd,
      timestamp: new Date().toISOString(),
    };
    await handleCallEnded(workflowEvent);

    return res.json({ status: "ok", ended: true });
  }

  return res.status(400).json({ error: "invalid_action", validActions: ["start", "update", "end"] });
});

app.post(
  "/api/runtime/call-quality-summary",
  adminGuard("admin"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const { tenantId, callControlId, summary } = req.body as {
      tenantId?: string;
      callControlId?: string;
      summary?: unknown;
    };
    if (!tenantId || typeof tenantId !== "string") {
      return res.status(400).json({ error: "tenant_id_required" });
    }
    if (!ensureTenantAccess(req, res, tenantId)) return;
    if (!callControlId || typeof callControlId !== "string") {
      return res.status(400).json({ error: "call_control_id_required" });
    }
    if (summary === undefined || summary === null || typeof summary !== "object") {
      return res.status(400).json({ error: "summary_required" });
    }
    const stored = await upsertCallQualitySummary({ tenantId, callControlId, summary });
    if (!stored) {
      return res.status(400).json({ error: "invalid_call_control_id" });
    }
    void recordAudit({
      action: "call_quality_summary_upserted",
      path: req.path,
      tenantId,
      status: "ok",
      details: { callControlId },
    });
    res.json({ status: "ok" });
  }),
);

app.post(
  "/api/runtime/tenants/:tenantId/diagnostics/consume-next-call-arm",
  adminGuard("admin"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const { tenantId } = req.params;
    if (!tenantId || typeof tenantId !== "string") {
      return res.status(400).json({ error: "tenant_id_required" });
    }
    if (!ensureTenantAccess(req, res, tenantId)) return;
    const prev = await getTenantCallQualitySettings(tenantId);
    const next = await consumeTenantNextCallDiagnostics(tenantId);
    const runtimeSyncOk = await trySyncTenantRuntimeConfigForLimits(tenantId);
    void recordAudit({
      action: "raw_audio_diagnostics_next_call_consumed",
      path: req.path,
      tenantId,
      status: "ok",
      details: { previousPending: prev.raw_audio_diagnostics_next_call_pending },
    });
    res.json({ tenantId, settings: callQualityRowToApi(next, false), runtimeSyncOk });
  }),
);

/* ────────────────────────────────────────────────
   Admin – tenant registry
   ──────────────────────────────────────────────── */

app.get("/api/admin/tenants", (req: AuthedRequest, res) => {
  const ctx = req.ctx;
  const all = tenants.listMetas();
  // Superadmin (env/master/db admin key) sees everything.
  if (ctx?.isSuperAdmin) {
    return res.json({ tenants: all });
  }
  // JWT users see only the tenants they are a member of.
  // ctx.tenantIds is populated by adminGuard from tenant_memberships.
  const allowed = new Set(ctx?.tenantIds ?? (ctx?.tenantId ? [ctx.tenantId] : []));
  if (allowed.size === 0) {
    return res.status(403).json({ error: "tenant_context_missing" });
  }
  res.json({ tenants: all.filter((t) => allowed.has(t.id)) });
});

/** Client portal readiness: legacy passcode and/or email login. */
app.get(
  "/api/admin/tenants/:tenantId/owner-portal-status",
  asyncHandler(async (req: AuthedRequest, res) => {
    const { tenantId } = req.params;
    if (!tenantId || typeof tenantId !== "string") {
      return res.status(400).json({ error: "tenant_id_required" });
    }
    if (!ensureTenantAccess(req, res, tenantId)) return;
    const [hash, cred] = await Promise.all([
      getOwnerPasscodeHash(tenantId),
      getOwnerPortalCredentialRow(tenantId),
    ]);
    res.json({
      passcodeSet: Boolean(hash),
      emailLoginSet: Boolean(cred),
      email: cred?.emailNorm ?? null,
    });
  })
);

app.get(
  "/api/admin/tenants/:tenantId/business-hours",
  adminGuard("admin"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const tenantId = req.params.tenantId?.trim();
    if (!tenantId) return res.status(400).json({ error: "tenant_id_required" });
    if (!ensureTenantAccess(req, res, tenantId)) return;
    const ctx = tenants.getOrCreate(tenantId);
    const ev = evaluateBusinessHours(ctx.businessHours);
    res.json({ businessHours: ctx.businessHours, openNow: ev.isOpen, summary: ev.summary });
  }),
);

app.patch(
  "/api/admin/tenants/:tenantId/business-hours",
  adminGuard("admin"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const tenantId = req.params.tenantId?.trim();
    if (!tenantId) return res.status(400).json({ error: "tenant_id_required" });
    if (!ensureTenantAccess(req, res, tenantId)) return;
    const parsed = businessHoursSchema.safeParse(req.body || {});
    if (!parsed.success) {
      return res.status(400).json({ error: "invalid_business_hours", details: parsed.error.issues });
    }
    logger.info("tenant_settings_save_attempt", {
      event: "tenant_settings_save_attempt",
      tenantId,
      settingArea: "business_hours",
      actorRole: adminActorRole(req),
    });
    tenants.setBusinessHours(tenantId, parsed.data);
    const ev = evaluateBusinessHours(parsed.data);
    logger.info("tenant_settings_save_success", {
      event: "tenant_settings_save_success",
      tenantId,
      settingArea: "business_hours",
      actorRole: adminActorRole(req),
    });
    await upsertCutoverItem(
      tenantId,
      "hours_published",
      false,
      "Publish pending",
    );
    const publish = await autoPublishTenantRuntimeAfterSave(tenantId, {
      settingArea: "business_hours",
      actorRole: adminActorRole(req),
    });
    if (publish.published) {
      await upsertCutoverItem(
        tenantId,
        "hours_published",
        true,
        "Automatically verified after runtime publish",
      );
    }
    res.json({
      businessHours: parsed.data,
      openNow: ev.isOpen,
      summary: ev.summary,
      saved: true,
      published: publish.published,
      lastRuntimePublishedAt: publish.lastRuntimePublishedAt,
      ...(publish.publishError ? { publishError: publish.publishError } : {}),
      ...(publish.publishSkippedReason ? { publishSkippedReason: publish.publishSkippedReason } : {}),
    });
  }),
);

app.get(
  "/api/admin/tenants/:tenantId/operator-state",
  adminGuard("admin"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const tenantId = req.params.tenantId?.trim();
    if (!tenantId) return res.status(400).json({ error: "tenant_id_required" });
    if (!ensureTenantAccess(req, res, tenantId)) return;
    const ctx = tenants.getOrCreate(tenantId);
    res.json({ operatorState: ctx.operatorState });
  }),
);

app.post(
  "/api/admin/tenants/:tenantId/operator-test-call/complete",
  adminGuard("admin"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const tenantId = req.params.tenantId?.trim();
    if (!tenantId) return res.status(400).json({ error: "tenant_id_required" });
    if (!ensureTenantAccess(req, res, tenantId)) return;
    const who = req.ctx?.idpSub || req.ctx?.userId || "admin";
    const ctx = tenants.mergeOperatorState(tenantId, {
      testCall: { completedAt: new Date().toISOString(), completedBy: String(who) },
    });
    await upsertCutoverItem(
      tenantId,
      "test_call",
      true,
      "Marked complete by installer",
    );
    res.json({ operatorState: ctx.operatorState });
  }),
);

app.get("/api/owner/business-hours", async (req, res) => {
  try {
    const raw = getAdminToken(req);
    if (!raw) return res.status(401).json({ error: "auth_required" });
    const session = await verifyOwnerPortalToken(raw);
    if (!session) return res.status(401).json({ error: "invalid_or_expired_session" });
    const ctx = tenants.getOrCreate(session.tenantId);
    const ev = evaluateBusinessHours(ctx.businessHours);
    res.json({ businessHours: ctx.businessHours, openNow: ev.isOpen, summary: ev.summary });
  } catch (err) {
    console.error("GET /api/owner/business-hours error:", err);
    res.status(500).json({ error: "business_hours_read_failed" });
  }
});

app.patch("/api/owner/business-hours", async (req, res) => {
  try {
    const raw = getAdminToken(req);
    if (!raw) return res.status(401).json({ error: "auth_required" });
    const session = await verifyOwnerPortalToken(raw);
    if (!session) return res.status(401).json({ error: "invalid_or_expired_session" });
    const parsed = businessHoursSchema.safeParse(req.body || {});
    if (!parsed.success) {
      return res.status(400).json({ error: "invalid_business_hours", details: parsed.error.issues });
    }
    const tenantId = session.tenantId;
    const playbookRow = await getShopPlaybookRow(tenantId);
    if (!playbookRow?.ownerCanEdit) {
      return res.status(403).json({ error: "owner_rules_read_only" });
    }
    logger.info("tenant_settings_save_attempt", {
      event: "tenant_settings_save_attempt",
      tenantId,
      settingArea: "business_hours",
      actorRole: "owner_portal",
    });
    tenants.setBusinessHours(tenantId, parsed.data);
    const ev = evaluateBusinessHours(parsed.data);
    logger.info("tenant_settings_save_success", {
      event: "tenant_settings_save_success",
      tenantId,
      settingArea: "business_hours",
      actorRole: "owner_portal",
    });
    await upsertCutoverItem(
      tenantId,
      "hours_published",
      false,
      "Publish pending",
    );
    const publish = await autoPublishTenantRuntimeAfterSave(tenantId, {
      settingArea: "business_hours",
      actorRole: "owner_portal",
    });
    if (publish.published) {
      await upsertCutoverItem(
        tenantId,
        "hours_published",
        true,
        "Automatically verified after owner save and runtime publish",
      );
    }
    res.json({
      businessHours: parsed.data,
      openNow: ev.isOpen,
      summary: ev.summary,
      saved: true,
      published: publish.published,
      lastRuntimePublishedAt: publish.lastRuntimePublishedAt,
      ...(publish.publishError ? { publishError: publish.publishError } : {}),
      ...(publish.publishSkippedReason ? { publishSkippedReason: publish.publishSkippedReason } : {}),
    });
  } catch (err) {
    console.error("PATCH /api/owner/business-hours error:", err);
    res.status(500).json({ error: "business_hours_write_failed" });
  }
});

app.get("/api/owner/calls", async (req, res) => {
  try {
    const raw = getAdminToken(req);
    if (!raw) return res.status(401).json({ error: "auth_required" });
    const session = await verifyOwnerPortalToken(raw);
    if (!session) return res.status(401).json({ error: "invalid_or_expired_session" });
    res.setHeader("Cache-Control", "no-store, private");
    res.setHeader("Pragma", "no-cache");
    const lim = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
    const filter = typeof req.query.filter === "string" ? req.query.filter : "all";
    const rows = dedupeCallHistoryRows(
      await listCallsForTenantDb(session.tenantId, Math.min(200, Math.max(lim * 2, lim))),
    ).slice(0, lim);
    const limits = await getTenantLimits(session.tenantId);
    const mapped = rows.map((row) => {
      const lead =
        row.lead && typeof row.lead === "object"
          ? (row.lead as Record<string, any>)
          : {};
      return {
        id: row.id,
        callerDisplay: maskCallerId(row.caller_id),
        stage: row.stage || "unknown",
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        transcriptSummary: summarizeHistory(row.history),
        missed: isMissedCallRow({ stage: row.stage, lead: row.lead }),
        completion:
          typeof lead.completion === "string" ? lead.completion : null,
        existingCustomer:
          typeof lead.existingCustomer === "string"
            ? lead.existingCustomer
            : null,
        openJobs: Array.isArray(lead.openJobs) ? lead.openJobs : [],
        membership:
          typeof lead.membership === "string" ? lead.membership : null,
        warranty: typeof lead.warranty === "string" ? lead.warranty : null,
        recordingUrl:
          limits.callRecording &&
          typeof (lead.recordingUrl || lead.recording_url) === "string"
            ? lead.recordingUrl || lead.recording_url
            : null,
      };
    });
    const calls = filter === "missed" ? mapped.filter((c) => c.missed) : mapped;
    res.json({ calls });
  } catch (err) {
    console.error("GET /api/owner/calls error:", err);
    res.status(500).json({ error: "calls_read_failed" });
  }
});

app.get("/api/owner/calls/:callId", async (req, res) => {
  try {
    const raw = getAdminToken(req);
    if (!raw) return res.status(401).json({ error: "auth_required" });
    const session = await verifyOwnerPortalToken(raw);
    if (!session) return res.status(401).json({ error: "invalid_or_expired_session" });
    res.setHeader("Cache-Control", "no-store, private");
    res.setHeader("Pragma", "no-cache");
    const callId = req.params.callId?.trim();
    if (!callId) return res.status(400).json({ error: "call_id_required" });
    const row = await getCallByIdForTenantDb(session.tenantId, callId);
    if (!row) return res.status(404).json({ error: "call_not_found" });
    const cqRow = await getTenantCallQualitySettings(session.tenantId).catch(() => null);
    const limits = await getTenantLimits(session.tenantId);
    const ownerLead =
      row.lead && typeof row.lead === "object"
        ? (row.lead as Record<string, any>)
        : {};
    const voiceCc =
      row.lead && typeof (row.lead as any).voiceCallControlId === "string"
        ? String((row.lead as any).voiceCallControlId).trim()
        : "";
    let clientQuality: Record<string, unknown> | null = null;
    if (cqRow?.quality_summary_visible_to_client && voiceCc) {
      const got = await getCallQualitySummaryForCall(session.tenantId, voiceCc);
      if (got?.summary && typeof got.summary === "object") {
        clientQuality = mapOwnerPortalCallQuality(got.summary as Record<string, unknown>);
      }
    }
    res.json({
      id: row.id,
      callerDisplay: maskCallerId(row.caller_id),
      stage: row.stage || "unknown",
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      transcriptSummary: summarizeHistory(row.history),
      missed: isMissedCallRow({ stage: row.stage, lead: row.lead }),
      completion:
        typeof ownerLead.completion === "string"
          ? ownerLead.completion
          : null,
      existingCustomer:
        typeof ownerLead.existingCustomer === "string"
          ? ownerLead.existingCustomer
          : null,
      openJobs: Array.isArray(ownerLead.openJobs)
        ? ownerLead.openJobs
        : [],
      membership:
        typeof ownerLead.membership === "string"
          ? ownerLead.membership
          : null,
      warranty:
        typeof ownerLead.warranty === "string"
          ? ownerLead.warranty
          : null,
      recordingUrl:
        limits.callRecording &&
        typeof (ownerLead.recordingUrl || ownerLead.recording_url) === "string"
          ? ownerLead.recordingUrl || ownerLead.recording_url
          : null,
      transcriptsDisabled: cqRow ? !cqRow.transcript_storage_enabled : false,
      callQuality: clientQuality,
    });
  } catch (err) {
    console.error("GET /api/owner/calls/:callId error:", err);
    res.status(500).json({ error: "call_read_failed" });
  }
});

app.get("/api/owner/call-quality-summary/:callControlId", async (req, res) => {
  try {
    const raw = getAdminToken(req);
    if (!raw) return res.status(401).json({ error: "auth_required" });
    const session = await verifyOwnerPortalToken(raw);
    if (!session) return res.status(401).json({ error: "invalid_or_expired_session" });
    const callControlId = req.params.callControlId?.trim();
    if (!callControlId) return res.status(400).json({ error: "call_control_id_required" });
    const cqRow = await getTenantCallQualitySettings(session.tenantId);
    if (!cqRow.quality_summary_visible_to_client) {
      return res.json({ visible: false });
    }
    if (!cqRow.transcript_storage_enabled) {
      return res.json({
        visible: true,
        transcriptsDisabled: true,
        message: "Transcripts are disabled for this business.",
      });
    }
    const got = await getCallQualitySummaryForCall(session.tenantId, callControlId);
    if (!got?.summary || typeof got.summary !== "object") {
      return res.json({ visible: true, summary: null });
    }
    res.json({
      visible: true,
      summary: mapOwnerPortalCallQuality(got.summary as Record<string, unknown>),
    });
  } catch (err) {
    console.error("GET /api/owner/call-quality-summary error:", err);
    res.status(500).json({ error: "call_quality_read_failed" });
  }
});

app.post("/api/owner/operator-test-call/complete", async (req, res) => {
  try {
    const raw = getAdminToken(req);
    if (!raw) return res.status(401).json({ error: "auth_required" });
    const session = await verifyOwnerPortalToken(raw);
    if (!session) return res.status(401).json({ error: "invalid_or_expired_session" });
    const ctx = tenants.mergeOperatorState(session.tenantId, {
      testCall: { completedAt: new Date().toISOString(), completedBy: "owner-portal" },
    });
    await upsertCutoverItem(
      session.tenantId,
      "test_call",
      true,
      "Marked complete in owner portal",
    );
    res.json({ operatorState: ctx.operatorState });
  } catch (err) {
    console.error("POST /api/owner/operator-test-call/complete error:", err);
    res.status(500).json({ error: "operator_state_write_failed" });
  }
});

app.get("/api/owner/operator-state", async (req, res) => {
  try {
    const raw = getAdminToken(req);
    if (!raw) return res.status(401).json({ error: "auth_required" });
    const session = await verifyOwnerPortalToken(raw);
    if (!session) return res.status(401).json({ error: "invalid_or_expired_session" });
    const ctx = tenants.getOrCreate(session.tenantId);
    res.json({ operatorState: ctx.operatorState });
  } catch (err) {
    console.error("GET /api/owner/operator-state error:", err);
    res.status(500).json({ error: "operator_state_read_failed" });
  }
});

app.get("/api/owner/voice-runtime-sync", async (req, res) => {
  try {
    const raw = getAdminToken(req);
    if (!raw) return res.status(401).json({ error: "auth_required" });
    const session = await verifyOwnerPortalToken(raw);
    if (!session) return res.status(401).json({ error: "invalid_or_expired_session" });
    try {
      const cfg = await getTenantConfig(session.tenantId);
      return res.json({
        lastRuntimePublishedAt: cfg?.lastRuntimePublishedAt ?? null,
      });
    } catch {
      return res.json({ lastRuntimePublishedAt: null });
    }
  } catch (err) {
    console.error("GET /api/owner/voice-runtime-sync error:", err);
    res.status(500).json({ error: "voice_runtime_sync_read_failed" });
  }
});

const tenantLimitsPatchSchema = tenantLimitsSchema.partial().extend({
  planTier: planTierSchema.optional(),
  billingStatus: billingStatusSchema.optional(),
});

app.get(
  "/api/admin/tenants/:tenantId/limits",
  adminGuard("admin"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const { tenantId } = req.params;
    if (!tenantId || typeof tenantId !== "string") {
      return res.status(400).json({ error: "tenant_id_required" });
    }
    if (!ensureTenantAccess(req, res, tenantId)) return;
    const limits = await getTenantLimits(tenantId);
    res.json({ tenantId, limits });
  }),
);

app.patch(
  "/api/admin/tenants/:tenantId/limits",
  adminGuard("admin"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const { tenantId } = req.params;
    if (!tenantId || typeof tenantId !== "string") {
      return res.status(400).json({ error: "tenant_id_required" });
    }
    if (!ensureTenantAccess(req, res, tenantId)) return;
    const parsed = tenantLimitsPatchSchema.safeParse(req.body || {});
    if (!parsed.success) {
      return res.status(400).json({ error: "invalid_limits", details: parsed.error.issues });
    }
    const patch = parsed.data as Record<string, unknown>;
    if (patch.transcriptRetention === false) {
      return res.status(400).json({ error: "invalid_limits", message: "transcriptRetention cannot be disabled for safety/audit baseline" });
    }
    const updatedBy = req.ctx?.idpSub || req.ctx?.userId || "admin";
    const limits = await upsertTenantLimits(tenantId, parsed.data, updatedBy);
    const runtimeSyncOk = await trySyncTenantRuntimeConfigForLimits(tenantId);
    void recordAudit({
      action: "tenant_limits_updated",
      path: req.path,
      tenantId,
      status: "ok",
    });
    res.json({ tenantId, limits, runtimeSyncOk });
  }),
);

app.post(
  "/api/admin/tenants/:tenantId/limits/reset-to-plan-defaults",
  adminGuard("admin"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const { tenantId } = req.params;
    if (!tenantId || typeof tenantId !== "string") {
      return res.status(400).json({ error: "tenant_id_required" });
    }
    if (!ensureTenantAccess(req, res, tenantId)) return;
    const planTierRaw = typeof req.body?.planTier === "string" ? req.body.planTier : RECOMMENDED_DEFAULT_PLAN_TIER;
    const planTierParsed = planTierSchema.safeParse(planTierRaw);
    if (!planTierParsed.success) {
      return res.status(400).json({ error: "invalid_plan_tier" });
    }
    const updatedBy = req.ctx?.idpSub || req.ctx?.userId || "admin";
    const limits = await resetTenantLimitsToPlanDefaults(tenantId, planTierParsed.data, updatedBy);
    const runtimeSyncOk = await trySyncTenantRuntimeConfigForLimits(tenantId);
    void recordAudit({
      action: "tenant_limits_reset_to_plan_defaults",
      path: req.path,
      tenantId,
      status: "ok",
    });
    res.json({ tenantId, limits, runtimeSyncOk });
  }),
);

app.post(
  "/api/admin/tenants/:tenantId/billing-status",
  adminGuard("admin"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const { tenantId } = req.params;
    if (!tenantId || typeof tenantId !== "string") {
      return res.status(400).json({ error: "tenant_id_required" });
    }
    if (!ensureTenantAccess(req, res, tenantId)) return;
    const statusParsed = billingStatusSchema.safeParse(req.body?.billingStatus);
    if (!statusParsed.success) {
      return res.status(400).json({ error: "invalid_billing_status" });
    }
    const updatedBy = req.ctx?.idpSub || req.ctx?.userId || "admin";
    const limits = await setTenantBillingStatus(tenantId, statusParsed.data, updatedBy);
    const runtimeSyncOk = await trySyncTenantRuntimeConfigForLimits(tenantId);
    void recordAudit({
      action: "tenant_billing_status_updated",
      path: req.path,
      tenantId,
      status: "ok",
    });
    res.json({ tenantId, limits, runtimeSyncOk });
  }),
);

app.get(
  "/api/admin/tenants/:tenantId/usage",
  adminGuard("admin"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const { tenantId } = req.params;
    if (!tenantId || typeof tenantId !== "string") {
      return res.status(400).json({ error: "tenant_id_required" });
    }
    if (!ensureTenantAccess(req, res, tenantId)) return;
    const usage = await getTenantUsageSnapshot(tenantId);
    const liveNow = tenants.getOrCreate(tenantId).calls.countLiveCalls();
    const concurrentNow = Math.max(usage.activeCalls, liveNow);
    const phoneNumbers = tenants.getOrCreate(tenantId).meta.numbers?.length ?? 0;
    const limits = await getTenantLimits(tenantId);
    const overageMinutes = Math.max(0, usage.monthlyBillableMinutes - limits.includedMonthlyMinutes);
    res.json({
      tenantId,
      usage: {
        ...usage,
        activeCalls: concurrentNow,
        concurrentCallsNow: concurrentNow,
        phoneNumbers,
      },
      overageMinutes,
      hardCapRemainingMinutes: Math.max(0, limits.maxMonthlyMinutesHardCap - usage.monthlyBillableMinutes),
      includedMinutesRemaining: Math.max(0, limits.includedMonthlyMinutes - usage.monthlyBillableMinutes),
    });
  }),
);

app.get(
  "/api/admin/tenants/:tenantId/billing-summary",
  adminGuard("admin"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const { tenantId } = req.params;
    if (!tenantId || typeof tenantId !== "string") {
      return res.status(400).json({ error: "tenant_id_required" });
    }
    if (!ensureTenantAccess(req, res, tenantId)) return;
    const month = typeof req.query.month === "string" && /^\d{4}-\d{2}$/.test(req.query.month)
      ? req.query.month
      : new Date().toISOString().slice(0, 7);
    const summary = await getTenantBillingSummary(tenantId, month);
    res.json({ tenantId, summary });
  }),
);

app.get(
  "/api/admin/tenants/:tenantId/call-quality-settings",
  adminGuard("viewer"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const { tenantId } = req.params;
    if (!tenantId || typeof tenantId !== "string") {
      return res.status(400).json({ error: "tenant_id_required" });
    }
    if (!ensureTenantAccess(req, res, tenantId)) return;
    const row = await getTenantCallQualitySettings(tenantId);
    const viewer = req.ctx?.role === "tenant-viewer";
    res.json({ tenantId, settings: callQualityRowToApi(row, viewer) });
  }),
);

app.patch(
  "/api/admin/tenants/:tenantId/call-quality-settings",
  adminGuard("admin"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const { tenantId } = req.params;
    if (!tenantId || typeof tenantId !== "string") {
      return res.status(400).json({ error: "tenant_id_required" });
    }
    if (!ensureTenantAccess(req, res, tenantId)) return;
    const parsed = callQualitySettingsPatchSchema.safeParse(req.body || {});
    if (!parsed.success) {
      return res.status(400).json({ error: "invalid_body", details: parsed.error.issues });
    }
    const body = parsed.data;
    const superadmin = !!req.ctx?.isSuperAdmin;
    const prev = await getTenantCallQualitySettings(tenantId);

    if (!superadmin) {
      const forbiddenKeys = [
        "rawAudioDiagnosticsMode",
        "rawAudioDiagnosticsExpiresAt",
        "rawAudioDiagnosticsEnabledBy",
        "rawAudioDiagnosticsReason",
        "rawAudioDiagnosticsNextCallPending",
        "rawArtifactsVisibleToClient",
      ] as const;
      for (const k of forbiddenKeys) {
        if (k in (req.body || {}) && (req.body as any)[k] !== undefined) {
          return res.status(403).json({ error: "raw_diagnostics_superadmin_only", field: k });
        }
      }
    }

    if (body.rawArtifactsVisibleToClient === true && !superadmin) {
      return res.status(403).json({ error: "raw_artifacts_client_visibility_superadmin_only" });
    }

    if (
      body.rawAudioDiagnosticsMode === "all_calls_temporary" &&
      !body.rawAudioDiagnosticsExpiresAt &&
      !prev.raw_audio_diagnostics_expires_at
    ) {
      return res.status(400).json({ error: "expires_at_required_for_all_calls_temporary" });
    }

    const next = await updateTenantCallQualitySettings(tenantId, {
      callQualityAnalyticsEnabled: body.callQualityAnalyticsEnabled,
      transcriptStorageEnabled: body.transcriptStorageEnabled,
      transcriptRetentionDays: body.transcriptRetentionDays,
      rawAudioDiagnosticsMode: body.rawAudioDiagnosticsMode,
      rawAudioDiagnosticsExpiresAt: body.rawAudioDiagnosticsExpiresAt,
      rawAudioDiagnosticsEnabledBy: body.rawAudioDiagnosticsEnabledBy,
      rawAudioDiagnosticsReason: body.rawAudioDiagnosticsReason,
      rawAudioDiagnosticsNextCallPending: body.rawAudioDiagnosticsNextCallPending,
      qualitySummaryVisibleToClient: body.qualitySummaryVisibleToClient,
      rawArtifactsVisibleToClient: body.rawArtifactsVisibleToClient,
    });

    const runtimeSyncOk = await trySyncTenantRuntimeConfigForLimits(tenantId);
    void recordAudit({
      action: "tenant_call_quality_settings_updated",
      path: req.path,
      tenantId,
      status: "ok",
      details: {
        previous: callQualityRowToApi(prev, false),
        next: callQualityRowToApi(next, false),
      },
    });
    res.json({
      tenantId,
      settings: callQualityRowToApi(next, false),
      runtimeSyncOk,
    });
  }),
);

app.post(
  "/api/admin/tenants/:tenantId/raw-audio-diagnostics/enable-next-call",
  adminGuard("admin"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const { tenantId } = req.params;
    if (!tenantId || typeof tenantId !== "string") {
      return res.status(400).json({ error: "tenant_id_required" });
    }
    if (!ensureTenantAccess(req, res, tenantId)) return;
    if (!requireSuperAdminCtx(req, res)) return;
    const parsed = rawDiagEnableBodySchema.safeParse(req.body || {});
    if (!parsed.success) {
      return res.status(400).json({ error: "invalid_body", details: parsed.error.issues });
    }
    const actor = req.ctx?.idpSub || req.ctx?.email || req.ctx?.userId || "operator";
    const prev = await getTenantCallQualitySettings(tenantId);
    const mode = parsed.data.mode;
    const pending = mode === "next_call_only" || mode === "failed_calls_only";
    const next = await updateTenantCallQualitySettings(tenantId, {
      rawAudioDiagnosticsMode: mode,
      rawAudioDiagnosticsExpiresAt: parsed.data.expiresAt,
      rawAudioDiagnosticsEnabledBy: String(actor).slice(0, 512),
      rawAudioDiagnosticsReason: parsed.data.reason,
      rawAudioDiagnosticsNextCallPending: pending,
    });
    const runtimeSyncOk = await trySyncTenantRuntimeConfigForLimits(tenantId);
    void recordAudit({
      action: "raw_audio_diagnostics_enabled",
      path: req.path,
      tenantId,
      status: "ok",
      details: {
        reason: parsed.data.reason,
        expiresAt: parsed.data.expiresAt,
        mode,
        previousMode: prev.raw_audio_diagnostics_mode,
      },
    });
    res.json({ tenantId, settings: callQualityRowToApi(next, false), runtimeSyncOk });
  }),
);

app.post(
  "/api/admin/tenants/:tenantId/raw-audio-diagnostics/disable",
  adminGuard("admin"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const { tenantId } = req.params;
    if (!tenantId || typeof tenantId !== "string") {
      return res.status(400).json({ error: "tenant_id_required" });
    }
    if (!ensureTenantAccess(req, res, tenantId)) return;
    if (!requireSuperAdminCtx(req, res)) return;
    const parsed = rawDiagDisableBodySchema.safeParse(req.body || {});
    if (!parsed.success) {
      return res.status(400).json({ error: "invalid_body", details: parsed.error.issues });
    }
    const prev = await getTenantCallQualitySettings(tenantId);
    const next = await updateTenantCallQualitySettings(tenantId, {
      rawAudioDiagnosticsMode: "off",
      rawAudioDiagnosticsExpiresAt: null,
      rawAudioDiagnosticsEnabledBy: null,
      rawAudioDiagnosticsReason: null,
      rawAudioDiagnosticsNextCallPending: false,
    });
    const runtimeSyncOk = await trySyncTenantRuntimeConfigForLimits(tenantId);
    void recordAudit({
      action: "raw_audio_diagnostics_disabled",
      path: req.path,
      tenantId,
      status: "ok",
      details: { reason: parsed.data.reason, previousMode: prev.raw_audio_diagnostics_mode },
    });
    res.json({ tenantId, settings: callQualityRowToApi(next, false), runtimeSyncOk });
  }),
);

app.post("/api/admin/tenants", adminGuard("admin"), async (req: AuthedRequest, res) => {
  const { id, name, numbers, businessNumber } = req.body as {
    id?: string;
    name?: string;
    numbers?: string[] | string;
    businessNumber?: string;
  };

  if (!id || typeof id !== "string" || !id.trim() || id.length > 64) {
    return res.status(400).json({ error: "tenant_id_required" });
  }

  let numberList: string[] | undefined;
  if (Array.isArray(numbers)) {
    numberList = numbers.map((n) => String(n || ""));
  } else if (typeof numbers === "string") {
    numberList = numbers
      .split(/[, \n]+/)
      .map((n) => n.trim())
      .filter(Boolean);
  }

  const tenantId = id.trim();
  if (!(req.ctx?.isSuperAdmin ?? false) && req.ctx?.tenantId && req.ctx.tenantId !== tenantId) {
    return res.status(403).json({ error: "tenant_forbidden" });
  }

  const limits = await getTenantLimits(tenantId);
  if (numberList && numberList.length > limits.maxPhoneNumbers) {
    return res.status(400).json({
      error: "max_phone_numbers_exceeded",
      message: `This plan allows up to ${limits.maxPhoneNumbers} phone numbers.`,
    });
  }

  const updated = tenants.upsertMeta(tenantId, {
    name: typeof name === "string" ? name : undefined,
    numbers: numberList,
    businessNumber: typeof businessNumber === "string" ? businessNumber : undefined,
  });

  try {
    await ensureTenantWorkflows(tenantId);
  } catch (err) {
    console.warn("[tenants] default workflow seed failed", tenantId, err);
  }

  res.json(updated.meta);
});

app.delete(
  "/api/admin/tenants/:tenantId",
  adminGuard("admin"),
  asyncHandler(async (req: AuthedRequest, res) => {
    if (!(req.ctx?.isSuperAdmin ?? false)) {
      return res.status(403).json({ error: "superadmin_required" });
    }
    const tenantId = req.params.tenantId?.trim();
    if (!tenantId) return res.status(400).json({ error: "tenant_id_required" });

    const result = await tenants.deleteTenant(tenantId);
    if (!result.deleted) {
      const status = result.error === "tenant_not_found" ? 404 : 400;
      return res.status(status).json({
        error: result.error,
        message:
          result.error === "default_tenant_protected"
            ? "The default tenant cannot be deleted."
            : undefined,
      });
    }

    if (ENABLE_RUNTIME_ADMIN) {
      for (const n of result.numbers) {
        try {
          await unmapDid(n);
        } catch (err) {
          console.warn("[tenants] unmapDid after delete failed", n, err);
        }
      }
      try {
        await unpublishTenantConfig(tenantId);
      } catch (err) {
        console.warn("[tenants] unpublish after delete failed", tenantId, err);
      }
    }

    void recordAudit({
      action: "tenant_deleted",
      path: req.path,
      tenantId,
      status: "200",
      details: { tenantId, numbers: result.numbers },
    });
    res.json({ status: "ok", deleted: tenantId });
  }),
);

/* ────────────────────────────────────────────────
   Admin – Telnyx phone number management
   ──────────────────────────────────────────────── */

import * as telnyx from "./telnyx";

/*
 * Carrier-level Telnyx routes. These touch the entire Telnyx account (numbers,
 * orders, connections) — they are NOT tenant-scoped. They must therefore be
 * gated on superadmin/carrier authority, not the default viewer the
 * /api/admin mount grants and not a tenant-admin JWT. Without this any tenant
 * JWT could enumerate or mutate the shared carrier configuration.
 *
 * adminGuard("admin") blocks viewer JWTs; the additional requireSuperAdminCtx
 * check below blocks tenant-admin JWTs from carrier-level mutation/probing.
 */
function requireSuperAdminCtx(
  req: AuthedRequest,
  res: express.Response
): boolean {
  if (req.ctx?.isSuperAdmin) return true;
  res.status(403).json({ error: "carrier_admin_required" });
  return false;
}

registerPipelineRoutes(app, {
  adminGuard,
  requireSuperAdmin: (req, res) => requireSuperAdminCtx(req as AuthedRequest, res),
  ensureTenantAccess,
});

registerNightDeskRoutes(app, {
  adminGuard,
  ensureTenantAccess,
});

// Check Telnyx configuration status
app.get("/api/admin/telnyx/status", adminGuard("admin"), (req: AuthedRequest, res) => {
  if (!requireSuperAdminCtx(req, res)) return;
  res.json(telnyx.getConfigStatus());
});

// List all phone numbers in the Telnyx account
app.get("/api/admin/telnyx/numbers", adminGuard("admin"), async (req: AuthedRequest, res) => {
  if (!requireSuperAdminCtx(req, res)) return;
  if (!telnyx.isTelnyxConfigured()) {
    return res.status(400).json({ error: "telnyx_not_configured", message: "TELNYX_API_KEY not set" });
  }
  try {
    const numbers = await telnyx.listPhoneNumbers();
    // Add provisioning status
    const connectionId = process.env.TELNYX_CONNECTION_ID;
    const enriched = numbers.map((n) => ({
      ...n,
      provisioned: connectionId ? n.connection_id === connectionId : false,
    }));
    res.json({ numbers: enriched });
  } catch (err: any) {
    console.error("[telnyx] listPhoneNumbers error:", err);
    res.status(500).json({ error: "telnyx_api_error", message: err.message });
  }
});

// Search for available numbers to purchase
app.get("/api/admin/telnyx/available", adminGuard("admin"), async (req: AuthedRequest, res) => {
  if (!requireSuperAdminCtx(req, res)) return;
  if (!telnyx.isTelnyxConfigured()) {
    return res.status(400).json({ error: "telnyx_not_configured", message: "TELNYX_API_KEY not set" });
  }
  const country = (req.query.country as string) || "US";
  const state = req.query.state as string | undefined;
  const city = req.query.city as string | undefined;
  const contains = req.query.contains as string | undefined;
  const limit = Math.min(Number(req.query.limit) || 10, 50);

  try {
    const numbers = await telnyx.searchAvailableNumbers({
      country_code: country,
      administrative_area: state,
      locality: city,
      contains,
      limit,
      features: ["voice"],
    });
    // `numbers` keeps the raw Telnyx records for the legacy owner portal.
    // `available` is the shape the Numbers workflow already reads.
    res.json({
      numbers,
      available: numbers.map((number) => telnyx.presentAvailableNumber(number)),
    });
  } catch (err: any) {
    console.error("[telnyx] searchAvailableNumbers error:", err);
    res.status(500).json({ error: "telnyx_api_error", message: err.message });
  }
});

// Provision an existing number (assign to app Telnyx connection)
app.post("/api/admin/telnyx/provision", adminGuard("admin"), async (req: AuthedRequest, res) => {
  if (!requireSuperAdminCtx(req, res)) return;
  if (!telnyx.isTelnyxConfigured()) {
    return res.status(400).json({ error: "telnyx_not_configured", message: "TELNYX_API_KEY not set" });
  }
  const { phone_number } = req.body as { phone_number?: string };
  if (!phone_number) {
    return res.status(400).json({ error: "phone_number_required" });
  }

  try {
    const updated = await telnyx.provisionExistingNumber(phone_number);
    res.json({ status: "ok", phone_number: updated });
  } catch (err: any) {
    console.error("[telnyx] provisionExistingNumber error:", err);
    res.status(500).json({ error: "telnyx_api_error", message: err.message });
  }
});

// Purchase a new number
app.post("/api/admin/telnyx/purchase", adminGuard("admin"), async (req: AuthedRequest, res) => {
  if (!requireSuperAdminCtx(req, res)) return;
  if (!telnyx.isTelnyxConfigured()) {
    return res.status(400).json({ error: "telnyx_not_configured", message: "TELNYX_API_KEY not set" });
  }
  const { phone_number } = req.body as { phone_number?: string };
  if (!phone_number) {
    return res.status(400).json({ error: "phone_number_required" });
  }

  try {
    const result = await telnyx.purchaseAndProvisionNumber(phone_number);
    res.json({
      status: "ok",
      order: result.order,
      phone_number: result.phoneNumber,
    });
  } catch (err: any) {
    console.error("[telnyx] purchaseAndProvisionNumber error:", err);
    res.status(500).json({ error: "telnyx_api_error", message: err.message });
  }
});

// List available connections (for debugging/setup)
app.get("/api/admin/telnyx/connections", adminGuard("admin"), async (req: AuthedRequest, res) => {
  if (!requireSuperAdminCtx(req, res)) return;
  if (!telnyx.isTelnyxConfigured()) {
    return res.status(400).json({ error: "telnyx_not_configured", message: "TELNYX_API_KEY not set" });
  }
  try {
    const connections = await telnyx.listConnections();
    res.json({ connections });
  } catch (err: any) {
    console.error("[telnyx] listConnections error:", err);
    res.status(500).json({ error: "telnyx_api_error", message: err.message });
  }
});

/* ────────────────────────────────────────────────
   Admin – runtime provisioning
   ──────────────────────────────────────────────── */

app.post(
  "/api/admin/runtime/tenants/:tenantId/config",
  adminGuard("admin"),
  async (req, res) => {
    if (!ensureRuntimeAdminEnabled(res)) return;

    const tenantId = req.params.tenantId?.trim();
    if (!tenantId) return res.status(400).json({ error: "tenant_id_required" });
    if (!ensureTenantAccess(req as AuthedRequest, res, tenantId)) return;

    let parsed: RuntimeTenantConfig;
    try {
      parsed = parseRuntimeTenantConfig(req.body);
    } catch (err: any) {
      return res.status(400).json({
        error: "invalid_runtime_config",
        details: err?.issues ?? String(err),
      });
    }

    if (parsed.tenantId !== tenantId) {
      return res.status(400).json({ error: "tenant_id_mismatch" });
    }

    try {
      await publishTenantConfig(tenantId, parsed);
    } catch (err) {
      console.error("POST /api/admin/runtime/tenants/:tenantId/config error:", err);
      return res.status(500).json({ error: "runtime_publish_failed" });
    }

    const includeSecrets = shouldIncludeRuntimeSecrets(req);
    const config = includeSecrets ? parsed : redactRuntimeConfig(parsed);
    return res.json({ status: "ok", config });
  }
);

/**
 * Build full runtime JSON from Postgres tenant state (TTS/STT, DIDs, LLM context) and publish to Redis.
 * Preserves webhook secret, quick replies, assistantContext, transferProfiles, and callForwarding from existing Redis config when present.
 */
app.post(
  "/api/admin/runtime/tenants/:tenantId/publish-from-tenant",
  adminGuard("admin"),
  async (req, res) => {
    if (!ensureRuntimeAdminEnabled(res)) return;

    const tenantId = req.params.tenantId?.trim();
    if (!tenantId) return res.status(400).json({ error: "tenant_id_required" });
    if (!ensureTenantAccess(req as AuthedRequest, res, tenantId)) return;

    try {
      await syncTenantRuntimeConfigForLimits(tenantId);
    } catch (err: unknown) {
      if (err instanceof BuildRuntimeConfigError) {
        return res.status(400).json({
          error: err.code,
          message: err.message,
        });
      }
      console.error("POST /api/admin/runtime/tenants/:tenantId/publish-from-tenant error:", err);
      return res.status(500).json({ error: "runtime_publish_failed" });
    }

    let parsed: RuntimeTenantConfig | null;
    try {
      parsed = await getTenantConfig(tenantId);
    } catch (err) {
      console.error("POST /api/admin/runtime/tenants/:tenantId/publish-from-tenant getTenantConfig:", err);
      return res.status(500).json({ error: "runtime_config_read_failed" });
    }
    if (!parsed) {
      return res.status(500).json({
        error: "runtime_publish_failed",
        message: "Published config could not be read back from Redis.",
      });
    }

    const includeSecrets = shouldIncludeRuntimeSecrets(req);
    const config = includeSecrets ? parsed : redactRuntimeConfig(parsed);
    return res.json({ status: "ok", config });
  }
);

app.get("/api/admin/runtime/tenants/:tenantId/config", async (req, res) => {
  if (!ensureRuntimeAdminEnabled(res)) return;

  const tenantId = req.params.tenantId?.trim();
  if (!tenantId) return res.status(400).json({ error: "tenant_id_required" });
  if (!ensureTenantAccess(req as AuthedRequest, res, tenantId)) return;

  try {
    const config = await getTenantConfig(tenantId);
    if (!config) return res.status(404).json({ error: "runtime_config_not_found" });
    const includeSecrets = shouldIncludeRuntimeSecrets(req);
    return res.json({
      config: includeSecrets ? config : redactRuntimeConfig(config),
    });
  } catch (err) {
    console.error("GET /api/admin/runtime/tenants/:tenantId/config error:", err);
    return res.status(500).json({ error: "runtime_config_read_failed" });
  }
});

const quickRepliesPutBodySchema = z.object({
  quickReplies: z.array(quickReplyIntentSchema).max(200),
});

/**
 * AI-proposed quick replies from tenant-facing text (portal prompts, pricing, etc.).
 * Requires OPENAI_API_KEY on the control plane. Does not write Redis.
 */
app.post("/api/admin/quick-replies/suggest", adminGuard("admin"), async (req, res) => {
  const apiKey = (process.env.OPENAI_API_KEY || "").trim();
  if (!apiKey || apiKey === "CHANGE_ME") {
    return res.status(503).json({
      error: "openai_not_configured",
      message:
        "Set OPENAI_API_KEY for the control plane (not CHANGE_ME) to use AI quick-reply suggestions.",
    });
  }

  const parsed = quickRepliesSuggestBodySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: "invalid_body",
      details: parsed.error.flatten(),
    });
  }

  const tenantId = extractTenantId(req)?.trim();
  if (!tenantId) {
    return res.status(400).json({
      error: "tenant_id_required",
      message: "Send X-Tenant-ID (or active-tenant) so suggestions are tenant-scoped in audit.",
    });
  }
  if (!ensureTenantAccess(req as AuthedRequest, res, tenantId)) return;

  const model = process.env.OPENAI_MODEL || "gpt-4o-mini";
  try {
    const { quickReplies, dropped } = await suggestQuickRepliesWithOpenAI(
      apiKey,
      model,
      parsed.data,
    );
    return res.json({ quickReplies, dropped, model });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("POST /api/admin/quick-replies/suggest error:", err);
    return res.status(502).json({
      error: "quick_replies_suggest_failed",
      message,
    });
  }
});

app.get("/api/admin/runtime/tenants/:tenantId/quick-replies", async (req, res) => {
  if (!ensureRuntimeAdminEnabled(res)) return;

  const tenantId = req.params.tenantId?.trim();
  if (!tenantId) return res.status(400).json({ error: "tenant_id_required" });
  if (!ensureTenantAccess(req as AuthedRequest, res, tenantId)) return;

  try {
    const config = await getTenantConfig(tenantId);
    if (!config) {
      return res.json({ quickReplies: [], runtimeConfigMissing: true });
    }
    return res.json({
      quickReplies: config.quickReplies ?? [],
      runtimeConfigMissing: false,
    });
  } catch (err) {
    console.error("GET /api/admin/runtime/tenants/:tenantId/quick-replies error:", err);
    return res.status(500).json({ error: "runtime_quick_replies_read_failed" });
  }
});

app.put(
  "/api/admin/runtime/tenants/:tenantId/quick-replies",
  adminGuard("admin"),
  async (req, res) => {
    if (!ensureRuntimeAdminEnabled(res)) return;

    const tenantId = req.params.tenantId?.trim();
    if (!tenantId) return res.status(400).json({ error: "tenant_id_required" });
    if (!ensureTenantAccess(req as AuthedRequest, res, tenantId)) return;

    const parsedBody = quickRepliesPutBodySchema.safeParse(req.body);
    if (!parsedBody.success) {
      return res.status(400).json({
        error: "invalid_quick_replies",
        details: parsedBody.error.flatten(),
      });
    }

    try {
      const existing = await getTenantConfig(tenantId);
      if (!existing) {
        return res.status(404).json({
          error: "runtime_config_not_found",
          message:
            "Publish tenant config to Redis first (admin: Step 3 Voice → Publish to voice runtime, or POST /api/admin/runtime/tenants/:tenantId/publish-from-tenant), then quick replies can be saved.",
        });
      }

      const merged: RuntimeTenantConfig = parseRuntimeTenantConfig({
        ...existing,
        quickReplies: parsedBody.data.quickReplies,
      });

      await publishTenantConfig(tenantId, merged);
      return res.json({
        status: "ok",
        quickReplies: merged.quickReplies ?? [],
      });
    } catch (err: any) {
      if (err?.issues) {
        return res.status(400).json({
          error: "invalid_runtime_config_after_merge",
          details: err.issues,
        });
      }
      console.error("PUT /api/admin/runtime/tenants/:tenantId/quick-replies error:", err);
      return res.status(500).json({ error: "runtime_quick_replies_write_failed" });
    }
  }
);

app.post("/api/admin/runtime/dids/map", adminGuard("admin"), async (req, res) => {
  if (!ensureRuntimeAdminEnabled(res)) return;

  const { didE164, tenantId } = req.body as {
    didE164?: string;
    tenantId?: string;
  };

  if (!didE164 || typeof didE164 !== "string") {
    return res.status(400).json({ error: "did_required" });
  }
  let did: string;
  try {
    did = normalizeE164(didE164);
  } catch (err) {
    const message = String(err);
    const error =
      message.includes("did_empty") ? "did_required" : "invalid_did_e164";
    return res.status(400).json({ error });
  }
  if (did !== didE164) {
    console.debug("[runtime-admin] normalized DID", {
      original: didE164,
      normalized: did,
    });
  }

  if (!tenantId || typeof tenantId !== "string") {
    return res.status(400).json({ error: "tenant_id_required" });
  }
  const targetTenantId = tenantId.trim();
  if (!ensureTenantAccess(req as AuthedRequest, res, targetTenantId)) return;

  try {
    // Postgres `tenant_numbers` is canonical; setTenantNumbers syncs Redis.
    await addTenantNumberIfMissing(targetTenantId, did);
    return res.json({ status: "ok" });
  } catch (err) {
    console.error("POST /api/admin/runtime/dids/map error:", err);
    return res.status(500).json({ error: "runtime_map_failed" });
  }
});

app.post(
  "/api/admin/runtime/dids/unmap",
  adminGuard("admin"),
  async (req, res) => {
    if (!ensureRuntimeAdminEnabled(res)) return;

    const { didE164 } = req.body as { didE164?: string };
    if (!didE164 || typeof didE164 !== "string") {
      return res.status(400).json({ error: "did_required" });
    }
    let did: string;
    try {
      did = normalizeE164(didE164);
    } catch (err) {
      const message = String(err);
      const error =
        message.includes("did_empty") ? "did_required" : "invalid_did_e164";
      return res.status(400).json({ error });
    }
    if (did !== didE164) {
      console.debug("[runtime-admin] normalized DID", {
        original: didE164,
        normalized: did,
      });
    }

    try {
      const mappedTenant = await findTenantIdByInboundNumberE164(did);
      if (!mappedTenant) {
        return res.status(404).json({ error: "did_unmapped" });
      }
      if (!ensureTenantAccess(req as AuthedRequest, res, mappedTenant)) return;
      const nums = await getTenantNumbers(mappedTenant);
      const next = nums.filter((n) => {
        try {
          return normalizeE164(n) !== did;
        } catch {
          return true;
        }
      });
      await setTenantNumbers(mappedTenant, next);
      return res.json({ status: "ok", tenantId: mappedTenant });
    } catch (err) {
      console.error("POST /api/admin/runtime/dids/unmap error:", err);
      return res.status(500).json({ error: "runtime_unmap_failed" });
    }
  }
);

app.get("/api/admin/runtime/dids/:didE164", async (req, res) => {
  if (!ensureRuntimeAdminEnabled(res)) return;

  const didParam = req.params.didE164;
  if (!didParam) return res.status(400).json({ error: "did_required" });
  let did: string;
  try {
    did = normalizeE164(didParam);
  } catch (err) {
    const message = String(err);
    const error =
      message.includes("did_empty") ? "did_required" : "invalid_did_e164";
    return res.status(400).json({ error });
  }
  if (did !== didParam) {
    console.debug("[runtime-admin] normalized DID", {
      original: didParam,
      normalized: did,
    });
  }

  try {
    const tenantId = await findTenantIdByInboundNumberE164(did);
    if (!tenantId) return res.status(404).json({ error: "did_unmapped" });
    if (!ensureTenantAccess(req as AuthedRequest, res, tenantId)) return;
    return res.json({ didE164: did, tenantId });
  } catch (err) {
    console.error("GET /api/admin/runtime/dids/:didE164 error:", err);
    return res.status(500).json({ error: "runtime_lookup_failed" });
  }
});

app.get("/api/admin/runtime/health", async (_req, res) => {
  if (!ensureRuntimeAdminEnabled(res)) return;

  try {
    const health = await healthcheckRedis();
    const status = health.ok ? 200 : 503;
    return res.status(status).json({
      ...health,
      status: health.ok ? "ok" : "degraded",
      redis: { connected: health.ok, latencyMs: health.latencyMs },
      checkedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error("GET /api/admin/runtime/health error:", err);
    return res.status(500).json({ error: "runtime_health_failed" });
  }
});

/* ────────────────────────────────────────────────
   Active Call Voice Control (Hot-Swap)
   
   These endpoints proxy to the voice runtime for
   real-time voice mode switching during active calls.
   ──────────────────────────────────────────────── */

const VOICE_RUNTIME_URL = process.env.VOICE_RUNTIME_URL || "http://localhost:8000";

// GET /v1/calls/:callControlId/voice - Get current voice mode for an active call
app.get(
  "/v1/calls/:callControlId/voice",
  adminCorsGuard,
  adminGuard("viewer"),
  async (req, res) => {
    const callControlId = req.params.callControlId?.trim();
    if (!callControlId) {
      return res.status(400).json({ error: "call_control_id_required" });
    }

    try {
      // Proxy to voice runtime
      const runtimeUrl = `${VOICE_RUNTIME_URL}/v1/calls/${encodeURIComponent(callControlId)}/voice`;
      const response = await fetch(runtimeUrl, {
        method: "GET",
        headers: {
          "Content-Type": "application/json",
          ...(adminAuthToken ? { "X-Admin-Key": getAdminToken(req) || "" } : {}),
        },
      });

      if (response.status === 404) {
        return res.status(404).json({
          error: "call_not_found",
          message: "Call session not found or ended",
        });
      }

      if (!response.ok) {
        const errorText = await response.text();
        console.error("[voice-control] Runtime error:", response.status, errorText);
        return res.status(response.status).json({
          error: "runtime_error",
          message: errorText,
        });
      }

      const data = await response.json();
      return res.json(data);
    } catch (err) {
      console.error("[voice-control] GET /v1/calls/:callControlId/voice error:", err);
      
      // If runtime is unreachable, return a helpful error
      if ((err as any)?.code === "ECONNREFUSED" || (err as any)?.cause?.code === "ECONNREFUSED") {
        return res.status(503).json({
          error: "runtime_unavailable",
          message: "Voice runtime is not available. Ensure VOICE_RUNTIME_URL is configured correctly.",
        });
      }

      return res.status(500).json({
        error: "internal_error",
        message: "Failed to get voice mode",
      });
    }
  }
);

// POST /v1/calls/:callControlId/voice - Set/hot-swap voice mode for an active call
app.post(
  "/v1/calls/:callControlId/voice",
  adminCorsGuard,
  adminGuard("admin"),
  async (req, res) => {
    const callControlId = req.params.callControlId?.trim();
    if (!callControlId) {
      return res.status(400).json({ error: "call_control_id_required" });
    }

    const { mode, speakerWavUrl } = req.body as {
      mode?: string;
      speakerWavUrl?: string;
    };

    // Validate mode
    if (!mode || (mode !== "preset" && mode !== "cloned")) {
      return res.status(400).json({
        error: "invalid_mode",
        message: "mode must be 'preset' or 'cloned'",
      });
    }

    // Validate speakerWavUrl if provided
    if (speakerWavUrl && typeof speakerWavUrl === "string") {
      try {
        new URL(speakerWavUrl);
      } catch {
        return res.status(400).json({
          error: "invalid_speaker_wav_url",
          message: "speakerWavUrl must be a valid URL",
        });
      }
    }

    try {
      // Proxy to voice runtime
      const runtimeUrl = `${VOICE_RUNTIME_URL}/v1/calls/${encodeURIComponent(callControlId)}/voice`;
      const payload: { mode: string; speakerWavUrl?: string } = { mode };
      if (speakerWavUrl) payload.speakerWavUrl = speakerWavUrl;

      const response = await fetch(runtimeUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(adminAuthToken ? { "X-Admin-Key": getAdminToken(req) || "" } : {}),
        },
        body: JSON.stringify(payload),
      });

      if (response.status === 400) {
        const errorData = await response.json().catch(() => ({}));
        return res.status(400).json(errorData);
      }

      if (response.status === 404) {
        return res.status(404).json({
          error: "call_not_found",
          message: "Call session not found, ended, or inactive",
        });
      }

      if (!response.ok) {
        const errorText = await response.text();
        console.error("[voice-control] Runtime error:", response.status, errorText);
        return res.status(response.status).json({
          error: "runtime_error",
          message: errorText,
        });
      }

      const data = await response.json();
      return res.json(data);
    } catch (err) {
      console.error("[voice-control] POST /v1/calls/:callControlId/voice error:", err);
      
      // If runtime is unreachable, return a helpful error
      if ((err as any)?.code === "ECONNREFUSED" || (err as any)?.cause?.code === "ECONNREFUSED") {
        return res.status(503).json({
          error: "runtime_unavailable",
          message: "Voice runtime is not available. Ensure VOICE_RUNTIME_URL is configured correctly.",
        });
      }

      return res.status(500).json({
        error: "internal_error",
        message: "Failed to set voice mode",
      });
    }
  }
);

// Helper to get admin token (needed for proxy authorization)
const adminAuthToken = "";

/* ────────────────────────────────────────────────
   Admin – Workflow Automation Engine
   ──────────────────────────────────────────────── */

function isOwnerConsoleActor(req: AuthedRequest): boolean {
  return Boolean(req.ctx?.ownerConsole && !req.ctx?.isSuperAdmin);
}

function tenantWorkflowTimezone(tenantId: string): string {
  const ctx = tenants.get(tenantId);
  const hours = ctx?.businessHours;
  if (hours && typeof hours === "object" && typeof (hours as { timezone?: unknown }).timezone === "string") {
    return String((hours as { timezone: string }).timezone);
  }
  return "America/Los_Angeles";
}

async function assertOwnerWorkflowWrite(
  req: AuthedRequest,
  res: express.Response,
  tenantId: string,
  existing?: { adminLocked?: boolean } | null,
): Promise<boolean> {
  if (!isOwnerConsoleActor(req)) return true;
  const settings = await getWorkflowSettings(tenantId);
  if (!settings.ownerCanEdit) {
    res.status(403).json({ error: "owner_edit_disabled" });
    return false;
  }
  if (existing?.adminLocked) {
    res.status(403).json({ error: "workflow_locked" });
    return false;
  }
  return true;
}

// List workflows for the current tenant
app.get("/api/admin/workflows", asyncHandler(async (req, res) => {
  const tenant = getTenantForAdmin(req as AuthedRequest, res);
  if (!tenant) return;
  if (!(await requireTenantFeature(req as AuthedRequest, res, tenant.id, "customWorkflows"))) return;
  const workflows = await ensureTenantWorkflows(tenant.id);
  res.json({ workflows });
}));

app.get("/api/admin/workflow-templates", asyncHandler(async (req, res) => {
  const tenant = getTenantForAdmin(req as AuthedRequest, res);
  if (!tenant) return;
  if (!(await requireTenantFeature(req as AuthedRequest, res, tenant.id, "customWorkflows"))) return;
  const workflows = await listWorkflows(tenant.id);
  res.json(galleryPayload(workflows));
}));

app.post("/api/admin/workflows/from-template", asyncHandler(async (req, res) => {
  const tenant = getTenantForAdmin(req as AuthedRequest, res);
  if (!tenant) return;
  if (!(await requireTenantFeature(req as AuthedRequest, res, tenant.id, "customWorkflows"))) return;
  if (!(await assertOwnerWorkflowWrite(req as AuthedRequest, res, tenant.id))) return;
  const templateId = String(req.body?.templateId || "").trim();
  if (!templateId) return res.status(400).json({ error: "templateId is required" });
  try {
    const result = await enableWorkflowTemplate({
      tenantId: tenant.id,
      templateId,
      enabled: req.body?.enabled !== undefined ? !!req.body.enabled : true,
      config: req.body?.config && typeof req.body.config === "object" ? req.body.config : {},
      createdBy: isOwnerConsoleActor(req as AuthedRequest) ? "owner" : "admin",
      adminLocked: isOwnerConsoleActor(req as AuthedRequest) ? false : req.body?.adminLocked ?? true,
    });
    res.status(result.created ? 201 : 200).json(result);
  } catch (err: any) {
    if (String(err?.message || "").startsWith("unknown_workflow_template")) {
      return res.status(400).json({ error: "unknown_workflow_template", templateId });
    }
    throw err;
  }
}));

// Create a workflow
app.post("/api/admin/workflows", asyncHandler(async (req, res) => {
  const tenant = getTenantForAdmin(req as AuthedRequest, res);
  if (!tenant) return;
  if (!(await requireTenantFeature(req as AuthedRequest, res, tenant.id, "customWorkflows"))) return;
  if (!(await assertOwnerWorkflowWrite(req as AuthedRequest, res, tenant.id))) return;
  const { name, triggerType, triggerConfig, steps, adminLocked, enabled, templateId } = req.body || {};
  if (!name || !triggerType) {
    return res.status(400).json({ error: "name and triggerType are required" });
  }
  const createdBy = isOwnerConsoleActor(req as AuthedRequest) ? "owner" : "admin";
  const wf = await createWorkflow({
    tenantId: tenant.id,
    name,
    triggerType,
    triggerConfig: triggerConfig || {},
    steps: steps || [],
    createdBy,
    adminLocked: createdBy === "owner" ? false : adminLocked ?? false,
    enabled: enabled ?? true,
    templateId: templateId || null,
  });
  res.status(201).json(wf);
}));

// Update a workflow
app.put("/api/admin/workflows/:id", asyncHandler(async (req, res) => {
  const tenant = getTenantForAdmin(req as AuthedRequest, res);
  if (!tenant) return;
  if (!(await requireTenantFeature(req as AuthedRequest, res, tenant.id, "customWorkflows"))) return;
  const { id } = req.params;
  const existing = await getWorkflow(id);
  if (!existing || existing.tenantId !== tenant.id) {
    return res.status(404).json({ error: "Workflow not found" });
  }
  if (!(await assertOwnerWorkflowWrite(req as AuthedRequest, res, tenant.id, existing))) return;
  const { name, enabled, triggerType, triggerConfig, steps, adminLocked, templateId } = req.body || {};
  const updated = await updateWorkflow(id, {
    name, enabled, triggerType, triggerConfig, steps,
    adminLocked: isOwnerConsoleActor(req as AuthedRequest) ? existing.adminLocked : adminLocked,
    templateId,
  });
  res.json(updated);
}));

// Delete a workflow
app.delete("/api/admin/workflows/:id", asyncHandler(async (req, res) => {
  const tenant = getTenantForAdmin(req as AuthedRequest, res);
  if (!tenant) return;
  if (!(await requireTenantFeature(req as AuthedRequest, res, tenant.id, "customWorkflows"))) return;
  const { id } = req.params;
  const existing = await getWorkflow(id);
  if (!existing || existing.tenantId !== tenant.id) {
    return res.status(404).json({ error: "Workflow not found" });
  }
  if (!(await assertOwnerWorkflowWrite(req as AuthedRequest, res, tenant.id, existing))) return;
  await deleteWorkflow(id);
  res.json({ success: true });
}));

// Dry-run / test a workflow
app.post("/api/admin/workflows/:id/test", asyncHandler(async (req, res) => {
  const tenant = getTenantForAdmin(req as AuthedRequest, res);
  if (!tenant) return;
  if (!(await requireTenantFeature(req as AuthedRequest, res, tenant.id, "customWorkflows"))) return;
  const { id } = req.params;
  const workflow = await getWorkflow(id);
  if (!workflow || workflow.tenantId !== tenant.id) {
    return res.status(404).json({ error: "Workflow not found" });
  }
  const sampleEvent: CallEndedEvent = {
    type: "call_ended",
    tenantId: tenant.id,
    callId: "test-" + Date.now(),
    callerId: req.body?.callerId || "+15555555555",
    durationMs: req.body?.durationMs || 120000,
    turns: req.body?.turns || [
      { role: "assistant", content: "Hello, thank you for calling. How can I help you today?" },
      { role: "user", content: "I need to schedule an appointment for next week. This is an emergency, I smell gas." },
      { role: "assistant", content: "I'd be happy to help you schedule an appointment. What day works best for you?" },
    ],
    transcript: req.body?.transcript ||
      "Assistant: Hello, thank you for calling. How can I help you today?\nUser: I need to schedule an appointment for next week. This is an emergency, I smell gas.\nAssistant: I'd be happy to help you schedule an appointment. What day works best for you?",
    lead: req.body?.lead || { name: "Test User", phone: "+15555555555" },
    timestamp: new Date().toISOString(),
    completion: req.body?.completion,
    stormMode: req.body?.stormMode,
    qa: req.body?.qa,
    jobStatus: req.body?.jobStatus,
    membershipNames: req.body?.membershipNames,
  };
  const result = await dryRunPipeline(workflow, sampleEvent);
  res.json({
    ...result,
    run: { startedAt: new Date().toISOString(), status: "dry_run" },
  });
}));

app.post("/api/admin/jobs/complete", asyncHandler(async (req, res) => {
  const tenant = getTenantForAdmin(req as AuthedRequest, res);
  if (!tenant) return;
  const callId = String(req.body?.callId || "").trim();
  if (!callId) return res.status(400).json({ error: "callId is required" });
  await handleJobCompleted({
    tenantId: tenant.id,
    callId,
    callerId: req.body?.callerId,
    reviewUrl: req.body?.reviewUrl,
    lead: req.body?.lead,
    transcript: req.body?.transcript,
  });
  res.json({ ok: true, trigger: "job_completed" });
}));

// Workflow execution history
app.get("/api/admin/workflow-runs", asyncHandler(async (req, res) => {
  const tenant = getTenantForAdmin(req as AuthedRequest, res);
  if (!tenant) return;
  const limit = parseInt(req.query.limit as string) || 50;
  const today = req.query.today !== "0" && req.query.today !== "false";
  const runs = await listRuns(tenant.id, limit, {
    today,
    timezone: tenantWorkflowTimezone(tenant.id),
  });
  res.json({
    runs,
    today: true,
    timezone: tenantWorkflowTimezone(tenant.id),
  });
}));

// List leads
app.get("/api/admin/leads", asyncHandler(async (req, res) => {
  const tenant = getTenantForAdmin(req as AuthedRequest, res);
  if (!tenant) return;
  const limit = parseInt(req.query.limit as string) || 100;
  const leads = (await listLeads(tenant.id, limit)).map(presentLead);
  res.json({ leads });
}));

// Delete a lead. Always scoped to the active tenant so that one tenant cannot
// delete another tenant's lead by guessing the UUID. Superadmin must select the
// tenant via X-Tenant-ID like other admin endpoints.
app.delete("/api/admin/leads/:id", asyncHandler(async (req, res) => {
  const tenant = getTenantForAdmin(req as AuthedRequest, res);
  if (!tenant) return;
  const { id } = req.params;
  const deleted = await deleteLead(id, tenant.id);
  if (!deleted) return res.status(404).json({ error: "Lead not found" });
  res.json({ success: true });
}));

// Get workflow settings for tenant
app.get("/api/admin/workflows/settings", asyncHandler(async (req, res) => {
  const tenant = getTenantForAdmin(req as AuthedRequest, res);
  if (!tenant) return;
  if (!(await requireTenantFeature(req as AuthedRequest, res, tenant.id, "customWorkflows"))) return;
  const settings = await getWorkflowSettings(tenant.id);
  res.json(settings);
}));

// Update workflow settings for tenant
app.patch("/api/admin/workflows/settings", asyncHandler(async (req, res) => {
  const tenant = getTenantForAdmin(req as AuthedRequest, res);
  if (!tenant) return;
  if (!(await requireTenantFeature(req as AuthedRequest, res, tenant.id, "customWorkflows"))) return;
  const { ownerCanEdit } = req.body || {};
  const settings = await updateWorkflowSettings(tenant.id, {
    ownerCanEdit: ownerCanEdit !== undefined ? !!ownerCanEdit : undefined,
  });
  res.json(settings);
}));

/* ────────────────────────────────────────────────
   Legacy voice loop endpoints (disabled)
   ──────────────────────────────────────────────── */

app.post("/api/calls/start", (_req, res) => respondVoiceRuntimeMoved(res));
app.post("/api/calls/:callId/message", (_req, res) =>
  respondVoiceRuntimeMoved(res)
);
app.post("/api/calls/:callId/end", (_req, res) =>
  respondVoiceRuntimeMoved(res)
);
app.post("/api/telnyx/call-control", (_req, res) =>
  respondVoiceRuntimeMoved(res)
);
app.get("/api/telnyx/audio/:id.wav", (_req, res) =>
  respondVoiceRuntimeMoved(res)
);

/* ────────────────────────────────────────────────
   Admin / portal UI shells (React SPA + legacy HTML)
   ──────────────────────────────────────────────── */

const PUBLIC_DIR = path.join(__dirname, "..", "public");
const SPA_INDEX = path.join(PUBLIC_DIR, "app", "index.html");

function sendSpaIndex(res: Response) {
  applyAdminShellCachePolicy(res);
  if (!fs.existsSync(SPA_INDEX)) {
    return res
      .status(503)
      .type("text")
      .send(
        "VeraLux console is not built. Run npm run build:web, or use /admin-legacy and /portal-legacy.",
      );
  }
  return res.sendFile(SPA_INDEX);
}

function sendLegacyHtml(res: Response, file: string) {
  applyAdminShellCachePolicy(res);
  return res.sendFile(path.join(PUBLIC_DIR, "legacy", file));
}

app.get("/admin-legacy", (_req, res) => sendLegacyHtml(res, "admin.html"));
app.get("/portal-legacy", (_req, res) => sendLegacyHtml(res, "portal.html"));
app.get("/owner", (_req, res) => sendLegacyHtml(res, "owner.html"));
app.get("/owner/", (_req, res) => sendLegacyHtml(res, "owner.html"));

app.get("/admin", (_req, res) => sendSpaIndex(res));
app.get("/portal", (_req, res) => sendSpaIndex(res));
app.get(/^\/admin\/.*/, (req, res, next) => {
  if (req.path.startsWith("/admin-legacy")) return next();
  return sendSpaIndex(res);
});
app.get(/^\/portal\/.*/, (req, res, next) => {
  if (req.path.startsWith("/portal-legacy")) return next();
  return sendSpaIndex(res);
});

/* ────────────────────────────────────────────────
   Bootstrap
   ──────────────────────────────────────────────── */

let httpServer: ReturnType<typeof app.listen> | null = null;

function isStrongSecret(s?: string): boolean {
  if (!s) return false;
  const v = s.trim();
  if (v.length < 24) return false;
  if (v.includes("dev-secret") || v.includes("change-me")) return false;
  return true;
}

// ────────────────────────────────────────────────
// Global Error Handler (must be registered last)
// ────────────────────────────────────────────────
app.use(globalErrorHandler);

async function start() {
  try {
    await tenants.init();
  } catch (err) {
    console.error("Failed to initialize tenants/DB:", err);
    process.exit(1);
  }

  if (ENABLE_RUNTIME_ADMIN) {
    for (const tenant of tenants.listMetas()) {
      const published = await trySyncTenantRuntimeConfigForLimits(tenant.id);
      if (!published) {
        logger.warn("startup_tenant_runtime_publish_failed", {
          tenantId: tenant.id,
        });
      }
    }
  }

  // Initialize workflow automation engine
  try {
    initAutomationEngine();
  } catch (err) {
    console.error("[startup] Failed to init automation engine (non-fatal):", err);
  }

  try {
    startPriceRefreshLoop();
  } catch (err) {
    console.error("[startup] Failed to start price refresh (non-fatal):", err);
  }

  try {
    startMorningDigestLoop();
    startOncallFallbackLoop();
  } catch (err) {
    console.error("[startup] Failed to start night-desk workers (non-fatal):", err);
  }

  // ✅ PROD guardrails (fail fast)
  if (IS_PROD) {
    const adminJwt = process.env.ADMIN_JWT_SECRET || process.env.JWT_SECRET;
    if (!isStrongSecret(adminJwt)) {
      console.error("[guard] Missing/weak ADMIN_JWT_SECRET (or JWT_SECRET) in production.");
      process.exit(1);
    }

    if (!ADMIN_ALLOWED_ORIGINS.length) {
      console.error("[guard] ADMIN_ALLOWED_ORIGINS must be set in production (comma-separated).");
      process.exit(1);
    }

  }

  if (ENABLE_RUNTIME_ADMIN) {
    try {
      assertRuntimeRedisConfigured();
    } catch (err) {
      console.error(`[guard] ${String(err)}`);
      process.exit(1);
    }
  }

  const preferredPort = parsePreferredPort(process.env.PORT, 4000);
  const profile = (process.env.DEPLOYMENT_PROFILE || "").toLowerCase();
  const bindExactPort =
    process.env.CLOUD_BIND_EXACT_PORT === "1" ||
    profile === "cloud-api" ||
    profile === "cloud-hosted" ||
    Boolean(process.env.RENDER || process.env.RAILWAY_ENVIRONMENT || process.env.AWS_EXECUTION_ENV);

  try {
    const port = bindExactPort ? preferredPort : await findAvailablePort(preferredPort);
    httpServer = app.listen(port, "0.0.0.0", () => {
      const productLabel =
        process.env.PRODUCT_DISPLAY_NAME?.trim() || "VeraLux Receptionist";
      console.log(
        `${productLabel} control plane listening on port ${port}${
          port !== preferredPort ? ` (preferred ${preferredPort} unavailable)` : ""
        }`
      );
      try {
        startVeraluxOsReporting();
      } catch (e) {
        console.warn("VeraLux OS reporting startup skipped:", e);
      }
    });
  } catch (err) {
    console.error("Failed to start server:", err);
    process.exit(1);
  }
}

function shutdown(signal: string) {
  console.log(`[shutdown] Received ${signal}, closing server...`);
  try {
    httpServer?.close(async () => {
      try {
        shutdownAutomationEngine();
        stopPriceRefreshLoop();
        stopMorningDigestLoop();
        stopOncallFallbackLoop();
        await closePool();
        if (ENABLE_RUNTIME_ADMIN) await closeRuntimeRedis();
        if (ADMIN_RATE_USE_REDIS) await closeRateLimitRedis();
      } catch (e) {
        console.error("[shutdown] error closing connections:", e);
      }
      console.log("[shutdown] HTTP server closed.");
      process.exit(0);
    });

    setTimeout(() => {
      console.error("[shutdown] Force exiting after timeout.");
      process.exit(1);
    }, 8000).unref();
  } catch (e) {
    console.error("[shutdown] error:", e);
    process.exit(1);
  }
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

void start();
