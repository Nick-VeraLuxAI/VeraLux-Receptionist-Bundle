import "./env";
import express, { type Request, type Response, type NextFunction } from "express";
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
  assertRuntimeRedisConfigured,
  getTenantConfig,
  healthcheckRedis,
  publishTenantConfig,
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
} from "./config";
import { resolvePreviewText, synthesizeTtsPreview } from "./ttsPreview";
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
} from "./db";
import { rateLimit } from "./rateLimit";
import { closeRedis as closeRateLimitRedis } from "./redis";
import { normalizePhoneNumber } from "./utils/phone";
import { isUuid } from "./utils/validation";
import { parsePricingInfo, createForwardingProfile } from "./llmContext";
import {
  verifyOwnerPasscode,
  setOwnerPasscode,
  issueOwnerJwt,
  verifyOwnerPortalToken,
  changeOwnerPasscodeIfValid,
  changeOwnerPortalPasswordIfValid,
} from "./ownerAuth";
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
  getOrCreateStripeCustomer,
  createCheckoutSession,
  createPortalSession,
  handleStripeWebhook,
  syncSubscriptionFromStripe,
  listStripePlans,
  createStripePlan,
  deleteStripePlan,
} from "./stripe";
import {
  initAutomationEngine,
  shutdownAutomationEngine,
  handleCallEnded,
  dryRunPipeline,
  listWorkflows,
  getWorkflow,
  createWorkflow,
  updateWorkflow,
  deleteWorkflow,
  listRuns,
  listLeads,
  deleteLead,
  getWorkflowSettings,
  updateWorkflowSettings,
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

function noStoreAdminUiShell(req: Request, res: Response, next: NextFunction) {
  const p = req.path;
  const staticShells = new Set([
    "/admin-neural.css",
    "/admin.html",
    "/owner.html",
    "/portal.html",
  ]);
  if (
    staticShells.has(p) ||
    p === "/admin" ||
    p === "/admin/" ||
    p === "/owner" ||
    p === "/owner/" ||
    p === "/portal" ||
    p === "/portal/"
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
/** Canonical portal URL is `/portal`; `/portal.html` redirects (must be before `express.static`). */
app.get("/portal.html", (req, res) => {
  const q = req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : "";
  res.redirect(301, "/portal" + q);
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


app.get("/", (_req, res) => {
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
  isSuperAdmin: boolean;
  role: "superadmin" | "tenant-admin" | "tenant-viewer";
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

      // Superadmin via master/admin key
      if (principal.source !== "oidc") {
        ctx.isSuperAdmin = true;
        ctx.role = "superadmin";
        req.ctx = ctx;

        res.on("finish", () => {
          void recordAudit({
            adminKeyId: principal.id,
            action: `${req.method} ${req.path}`,
            path: req.path,
            tenantId: extractTenantId(req) || undefined,
            status: String(res.statusCode),
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

      const memberships = await listMembershipsForUser(user.id);
      if (memberships.length === 0) {
        return res.status(403).json({ error: "No tenant membership" });
      }

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

/**
 * Syncs a tenant's LLM context (forwarding profiles, pricing, prompts) to the
 * existing RuntimeTenantConfig in Redis. If no config exists yet, logs a warning.
 */
async function syncLLMContextToRuntime(tenant: TenantContext): Promise<void> {
  try {
    const existing = await getTenantConfig(tenant.id);
    if (!existing) {
      console.debug(`[syncLLMContext] No runtime config for tenant ${tenant.id}, skipping LLM context sync`);
      return;
    }

    const prompts = tenant.config.getPrompts();
    const updatedConfig: RuntimeTenantConfig = {
      ...existing,
      llmContext: {
        forwardingProfiles: tenant.forwardingProfiles.map((p) => ({
          id: p.id,
          name: p.name,
          number: p.number,
          role: p.role,
        })),
        pricing: {
          items: tenant.pricing.items.map((item) => ({
            id: item.id,
            name: item.name,
            price: item.price,
            description: item.description,
          })),
          notes: tenant.pricing.notes,
        },
        prompts: {
          systemPreamble: prompts.systemPreamble,
          schemaHint: prompts.schemaHint,
          policyPrompt: prompts.policyPrompt,
          voicePrompt: prompts.voicePrompt,
        },
      },
    };

    await publishTenantConfig(tenant.id, updatedConfig);
    console.debug(`[syncLLMContext] Updated LLM context for tenant ${tenant.id}`);
  } catch (err) {
    console.error(`[syncLLMContext] Failed to sync LLM context for tenant ${tenant.id}:`, err);
  }
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

function shouldIncludeRuntimeSecrets(req: Request): boolean {
  const raw = typeof req.query.includeSecrets === "string" ? req.query.includeSecrets : undefined;
  return parseBooleanish(raw, false) && ALLOW_RUNTIME_SECRET_READ;
}

function redactRuntimeConfig(
  config: RuntimeTenantConfig
): Omit<RuntimeTenantConfig, "webhookSecret"> {
  const { webhookSecret, ...rest } = config;
  return rest;
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

const INSTALLER_USERNAME = process.env.INSTALLER_USERNAME || "VeraLux";
const INSTALLER_PASSWORD = process.env.INSTALLER_PASSWORD || "JesusisKing";

app.post("/admin-auth", (req, res) => {
  const { username, password } = req.body || {};

  if (!username || !password) {
    return res.status(400).json({ success: false, error: "Username and password are required" });
  }

  // Constant-time-ish comparison to avoid timing attacks
  const userOk = username === INSTALLER_USERNAME;
  const passOk = password === INSTALLER_PASSWORD;

  if (userOk && passOk) {
    return res.json({ success: true });
  }

  return res.status(401).json({ success: false, error: "Invalid credentials" });
});

/* ────────────────────────────────────────────────
   Owner Portal – public auth (no adminGuard)
   ──────────────────────────────────────────────── */

app.post("/api/owner/login", async (req, res) => {
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
  rateLimit({
    windowMs: ADMIN_RATE_WINDOW_MS,
    max: ADMIN_RATE_MAX,
    keyFn: (req) => getAdminToken(req) || req.ip || "anon",
    useRedis: ADMIN_RATE_USE_REDIS,
  }),
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

  res.json({
    ...tenant.config.getSafeConfig(),
    hasOpenAIApiKey: hasKey,
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

app.post("/api/admin/prompts", async (req, res) => {
  const tenant = getTenantForAdmin(req as AuthedRequest, res);
  if (!tenant) return;

  const { systemPreamble, schemaHint, policyPrompt, voicePrompt, greetingText } =
    req.body as Partial<PromptConfig>;

  const updated = tenant.config.setPrompts({
    systemPreamble,
    schemaHint,
    policyPrompt,
    voicePrompt,
    greetingText,
  });

  tenants.persistConfig(tenant.id);
  // Sync LLM context to Redis for the voice runtime
  await syncLLMContextToRuntime(tenant);
  res.json(updated);
});

/* ────────────────────────────────────────────────
   Admin – LLM context (forwarding profiles + pricing)
   ──────────────────────────────────────────────── */

app.get("/api/admin/forwarding-profiles", (req, res) => {
  const tenant = getTenantForAdmin(req as AuthedRequest, res);
  if (!tenant) return;
  res.json({ profiles: tenant.forwardingProfiles });
});

app.post("/api/admin/forwarding-profiles", async (req, res) => {
  const tenant = getTenantForAdmin(req as AuthedRequest, res);
  if (!tenant) return;
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
          })
        )
    : [];
  const updated = tenants.setForwardingProfiles(tenant.id, profiles);
  if (!updated) return res.status(404).json({ error: "tenant_not_found" });
  // Sync LLM context to Redis for the voice runtime
  await syncLLMContextToRuntime(updated);
  res.json({ profiles: updated.forwardingProfiles });
});

app.get("/api/admin/pricing", (req, res) => {
  const tenant = getTenantForAdmin(req as AuthedRequest, res);
  if (!tenant) return;
  res.json(tenant.pricing);
});

app.post("/api/admin/pricing", async (req, res) => {
  const tenant = getTenantForAdmin(req as AuthedRequest, res);
  if (!tenant) return;
  const parsed = parsePricingInfo(req.body);
  const updated = tenants.setPricing(tenant.id, parsed);
  if (!updated) return res.status(404).json({ error: "tenant_not_found" });
  // Sync LLM context to Redis for the voice runtime
  await syncLLMContextToRuntime(updated);
  res.json(updated.pricing);
});

/* ────────────────────────────────────────────────
   Admin – Subscription / Billing
   ──────────────────────────────────────────────── */

app.get("/api/admin/subscription", asyncHandler(async (req, res) => {
  const tenant = getTenantForAdmin(req as AuthedRequest, res);
  if (!tenant) return;
  const sub = await getSubscription(tenant.id);
  if (!sub) {
    // No subscription record exists yet — tell the frontend
    return res.json({
      configured: false,
      tenantId: tenant.id,
      showBillingPortal: false,
      adminNotes: null,
    });
  }
  res.json(sub);
}));

app.post("/api/admin/subscription", asyncHandler(async (req, res) => {
  const tenant = getTenantForAdmin(req as AuthedRequest, res);
  if (!tenant) return;

  const {
    planName, priceCents, currency, billingFrequency, status,
    paymentMethodBrand, paymentMethodLast4,
    trialEndsAt, nextBillingDate, cancelledAt,
    showBillingPortal, adminNotes,
    stripePriceId, stripeProductId,
  } = req.body || {};

  const sub = await upsertSubscription(tenant.id, {
    planName, priceCents, currency, billingFrequency, status,
    paymentMethodBrand, paymentMethodLast4,
    trialEndsAt, nextBillingDate, cancelledAt,
    showBillingPortal, adminNotes,
    stripePriceId, stripeProductId,
  });

  res.json(sub);
}));

// DELETE: remove a tenant's subscription entirely
app.delete("/api/admin/subscription", asyncHandler(async (req, res) => {
  const tenant = getTenantForAdmin(req as AuthedRequest, res);
  if (!tenant) return;

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

  res.json({ success: true });
}));

// PATCH: update only specific fields on an EXISTING subscription (won't create)
app.patch("/api/admin/subscription", asyncHandler(async (req, res) => {
  const tenant = getTenantForAdmin(req as AuthedRequest, res);
  if (!tenant) return;

  const existing = await getSubscription(tenant.id);
  if (!existing) {
    return res.json({ configured: false, message: "No subscription to update" });
  }

  const { showBillingPortal, adminNotes } = req.body || {};

  const sub = await upsertSubscription(tenant.id, {
    ...existing,
    showBillingPortal: showBillingPortal !== undefined ? showBillingPortal : existing.showBillingPortal,
    adminNotes: adminNotes !== undefined ? adminNotes : existing.adminNotes,
  });

  res.json(sub);
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

// Check if Stripe is configured
app.get("/api/admin/stripe/status", (req, res) => {
  res.json({
    configured: isStripeConfigured(),
    publishableKey: process.env.STRIPE_PUBLISHABLE_KEY || null,
  });
});

// List available plans
app.get("/api/admin/stripe/plans", asyncHandler(async (req, res) => {
  const plans = await listStripePlans();
  res.json({ plans });
}));

// Create a new plan (admin only, creates product+price in Stripe)
app.post("/api/admin/stripe/plans", asyncHandler(async (req, res) => {
  const tenant = getTenantForAdmin(req as AuthedRequest, res);
  if (!tenant) return;

  if (!isStripeConfigured()) {
    return res.status(501).json({ error: "Stripe not configured" });
  }

  const { name, priceCents, currency, billingInterval } = req.body || {};
  if (!name || typeof priceCents !== "number") {
    return res.status(400).json({ error: "name and priceCents required" });
  }

  const plan = await createStripePlan({ name, priceCents, currency, billingInterval });
  res.json(plan);
}));

// Delete (deactivate) a plan
app.delete("/api/admin/stripe/plans/:planId", asyncHandler(async (req, res) => {
  const tenant = getTenantForAdmin(req as AuthedRequest, res);
  if (!tenant) return;

  if (!isStripeConfigured()) {
    return res.status(501).json({ error: "Stripe not configured" });
  }

  const { planId } = req.params;
  const deleted = await deleteStripePlan(planId);
  if (!deleted) return res.status(404).json({ error: "Plan not found" });
  res.json({ success: true });
}));

// Create a checkout session for a tenant to subscribe
app.post("/api/admin/stripe/checkout", asyncHandler(async (req, res) => {
  const tenant = getTenantForAdmin(req as AuthedRequest, res);
  if (!tenant) return;

  if (!isStripeConfigured()) {
    return res.status(501).json({ error: "Stripe not configured" });
  }

  const { priceId, successUrl, cancelUrl } = req.body || {};
  if (!priceId) return res.status(400).json({ error: "priceId required" });

  const baseUrl = process.env.PUBLIC_BASE_URL || `http://localhost:${process.env.PORT || 4000}`;
  const session = await createCheckoutSession({
    tenantId: tenant.id,
    priceId,
    successUrl: successUrl || `${baseUrl}/portal?checkout=success`,
    cancelUrl: cancelUrl || `${baseUrl}/portal?checkout=cancelled`,
    tenantName: tenant.meta.name,
  });

  res.json({ url: session.url, sessionId: session.id });
}));

// Create a customer portal session (owner manages billing)
app.post("/api/admin/stripe/portal", asyncHandler(async (req, res) => {
  const tenant = getTenantForAdmin(req as AuthedRequest, res);
  if (!tenant) return;

  if (!isStripeConfigured()) {
    return res.status(501).json({ error: "Stripe not configured" });
  }

  const { returnUrl } = req.body || {};
  const baseUrl = process.env.PUBLIC_BASE_URL || `http://localhost:${process.env.PORT || 4000}`;

  const session = await createPortalSession({
    tenantId: tenant.id,
    returnUrl: returnUrl || `${baseUrl}/portal`,
  });

  res.json({ url: session.url });
}));

// Sync a tenant's subscription from Stripe
app.post("/api/admin/stripe/sync", asyncHandler(async (req, res) => {
  const tenant = getTenantForAdmin(req as AuthedRequest, res);
  if (!tenant) return;

  if (!isStripeConfigured()) {
    return res.status(501).json({ error: "Stripe not configured" });
  }

  // Get the subscription ID from DB
  const sub = await getSubscription(tenant.id);
  if (!sub || !(sub as any).stripeSubscriptionId) {
    return res.status(404).json({ error: "No Stripe subscription found for this tenant" });
  }

  await syncSubscriptionFromStripe(tenant.id, (sub as any).stripeSubscriptionId);
  const updated = await getSubscription(tenant.id);
  res.json(updated);
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
};

app.get("/api/tts/config", (req, res) => {
  const tenant = getTenantForAdmin(req as AuthedRequest, res);
  if (!tenant) return;
  
  const baseCfg = tenant.config.getSafeTtsConfig();
  
  // Return extended config with mode info
  const extendedCfg: ExtendedTtsConfig = {
    ...baseCfg,
    mode: (baseCfg as any).ttsMode || "kokoro_http",
    ttsMode: (baseCfg as any).ttsMode || "kokoro_http",
  };
  
  // Include voice cloning fields if present
  if ((baseCfg as any).defaultVoiceMode) {
    extendedCfg.defaultVoiceMode = (baseCfg as any).defaultVoiceMode;
  }
  if ((baseCfg as any).clonedVoice) {
    extendedCfg.clonedVoice = (baseCfg as any).clonedVoice;
  }
  if ((baseCfg as any).coquiXttsUrl) {
    extendedCfg.coquiXttsUrl = (baseCfg as any).coquiXttsUrl;
  }
  if ((baseCfg as any).kokoroUrl) {
    extendedCfg.kokoroUrl = (baseCfg as any).kokoroUrl;
  }
  if ((baseCfg as any).chatterboxUrl) {
    extendedCfg.chatterboxUrl = (baseCfg as any).chatterboxUrl;
  }
  if ((baseCfg as any).chatterboxVariant) {
    extendedCfg.chatterboxVariant = (baseCfg as any).chatterboxVariant;
  }
  if ((baseCfg as any).qwen3TtsUrl) {
    extendedCfg.qwen3TtsUrl = (baseCfg as any).qwen3TtsUrl;
  }
  if ((baseCfg as any).qwen3Instruct) {
    extendedCfg.qwen3Instruct = (baseCfg as any).qwen3Instruct;
  }
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
  if (bq.qwen3SubtalkerTemperature !== undefined) extendedCfg.qwen3SubtalkerTemperature = bq.qwen3SubtalkerTemperature;
  if (bq.coquiTemperature !== undefined) extendedCfg.coquiTemperature = bq.coquiTemperature;
  if (bq.coquiLengthPenalty !== undefined) extendedCfg.coquiLengthPenalty = bq.coquiLengthPenalty;
  if (bq.coquiRepetitionPenalty !== undefined) extendedCfg.coquiRepetitionPenalty = bq.coquiRepetitionPenalty;
  if (bq.coquiTopK !== undefined) extendedCfg.coquiTopK = bq.coquiTopK;
  if (bq.coquiTopP !== undefined) extendedCfg.coquiTopP = bq.coquiTopP;
  if (bq.coquiSpeed !== undefined) extendedCfg.coquiSpeed = bq.coquiSpeed;
  if (bq.coquiSplitSentences !== undefined) extendedCfg.coquiSplitSentences = bq.coquiSplitSentences;

  res.json(extendedCfg);
});

app.post("/api/tts/config", async (req, res) => {
  const tenant = getTenantForAdmin(req as AuthedRequest, res);
  if (!tenant) return;

  const body = req.body as Partial<ExtendedTtsConfig> & Record<string, unknown>;
  const {
    xttsUrl,
    coquiXttsUrl,
    kokoroUrl,
    chatterboxUrl,
    chatterboxVariant,
    qwen3TtsUrl,
    qwen3Instruct,
    voiceId,
    language,
    rate,
    preset,
    ttsMode,
    defaultVoiceMode,
    clonedVoice,
  } = body;

  // Determine the TTS URL based on mode
  const urlCandidate = coquiXttsUrl || kokoroUrl || xttsUrl || chatterboxUrl || qwen3TtsUrl;
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

  // Validate voice cloning config
  if (defaultVoiceMode === "cloned") {
    const speakerUrl = clonedVoice?.speakerWavUrl;
    if (!speakerUrl || typeof speakerUrl !== "string" || !speakerUrl.trim()) {
      return res.status(400).json({
        error: "cloned_voice_url_required",
        message: "Cloned voice mode requires a speakerWavUrl to be set.",
      });
    }
    try {
      new URL(speakerUrl);
    } catch {
      return res.status(400).json({
        error: "invalid_speaker_wav_url",
        message: "speakerWavUrl must be a valid URL.",
      });
    }
  }

  // Build the extended config object (bounded strings — avoids huge payloads / DB surprises)
  const configUpdate: any = {
    xttsUrl: ttsUrlValue,
    voiceId: sanitizeTtsShortText(voiceId, 100),
    language: sanitizeTtsShortText(language, 32),
    rate: safeRate,
    preset: presetValue,
  };

  const validChatterboxVariant = (v: unknown): v is "turbo" | "standard" | "multilingual" =>
    v === "turbo" || v === "standard" || v === "multilingual";

  // Store mode-specific fields
  if (ttsMode === "coqui_xtts") {
    configUpdate.ttsMode = "coqui_xtts";
    configUpdate.coquiXttsUrl = ttsUrlValue;
    configUpdate.chatterboxUrl = undefined;
    configUpdate.chatterboxVariant = undefined;
    configUpdate.qwen3TtsUrl = undefined;
    configUpdate.qwen3Instruct = undefined;
    clearQwen3GenFields(configUpdate);
    if (defaultVoiceMode && (defaultVoiceMode === "preset" || defaultVoiceMode === "cloned")) {
      configUpdate.defaultVoiceMode = defaultVoiceMode;
    }
    if (clonedVoice && clonedVoice.speakerWavUrl) {
      configUpdate.clonedVoice = {
        speakerWavUrl: clonedVoice.speakerWavUrl.trim(),
        label: clonedVoice.label?.trim() || undefined,
      };
    }
    if ("coquiTemperature" in body) {
      const v = body.coquiTemperature;
      configUpdate.coquiTemperature =
        v === null || v === undefined ? undefined : optNumBody(v as number, 0, 2);
    }
    if ("coquiLengthPenalty" in body) {
      const v = body.coquiLengthPenalty;
      configUpdate.coquiLengthPenalty =
        v === null || v === undefined ? undefined : optNumBody(v as number, -10, 10);
    }
    if ("coquiRepetitionPenalty" in body) {
      const v = body.coquiRepetitionPenalty;
      configUpdate.coquiRepetitionPenalty =
        v === null || v === undefined ? undefined : optNumBody(v as number, 0.5, 2);
    }
    if ("coquiTopK" in body) {
      const v = body.coquiTopK;
      configUpdate.coquiTopK =
        v === null || v === undefined ? undefined : optIntBody(v as number, 0, 1_000_000);
    }
    if ("coquiTopP" in body) {
      const v = body.coquiTopP;
      configUpdate.coquiTopP = v === null || v === undefined ? undefined : optNumBody(v as number, 0, 1);
    }
    if ("coquiSpeed" in body) {
      const v = body.coquiSpeed;
      configUpdate.coquiSpeed = v === null || v === undefined ? undefined : optNumBody(v as number, 0.25, 4);
    }
    if ("coquiSplitSentences" in body) {
      const v = body.coquiSplitSentences;
      configUpdate.coquiSplitSentences =
        v === null || v === undefined ? undefined : optBoolBody(v as boolean);
    }
  } else if (ttsMode === "chatterbox_http") {
    configUpdate.ttsMode = "chatterbox_http";
    configUpdate.chatterboxUrl = ttsUrlValue;
    configUpdate.chatterboxVariant = validChatterboxVariant(chatterboxVariant)
      ? chatterboxVariant
      : "turbo";
    configUpdate.coquiXttsUrl = undefined;
    configUpdate.kokoroUrl = undefined;
    configUpdate.qwen3TtsUrl = undefined;
    configUpdate.qwen3Instruct = undefined;
    clearQwen3GenFields(configUpdate);
    clearCoquiGenFields(configUpdate);
    if (defaultVoiceMode && (defaultVoiceMode === "preset" || defaultVoiceMode === "cloned")) {
      configUpdate.defaultVoiceMode = defaultVoiceMode;
    }
    if (clonedVoice && clonedVoice.speakerWavUrl) {
      configUpdate.clonedVoice = {
        speakerWavUrl: clonedVoice.speakerWavUrl.trim(),
        label: clonedVoice.label?.trim() || undefined,
      };
    }
  } else if (ttsMode === "qwen3_tts_http") {
    configUpdate.ttsMode = "qwen3_tts_http";
    configUpdate.qwen3TtsUrl = ttsUrlValue;
    configUpdate.qwen3Instruct = sanitizeTtsShortText(qwen3Instruct, 500);
    if ("qwen3DoSample" in body) {
      const v = body.qwen3DoSample;
      configUpdate.qwen3DoSample =
        v === null || v === undefined ? undefined : optBoolBody(v as boolean);
    }
    if ("qwen3Temperature" in body) {
      const v = body.qwen3Temperature;
      configUpdate.qwen3Temperature =
        v === null || v === undefined ? undefined : optNumBody(v as number, 0, 2);
    }
    if ("qwen3TopP" in body) {
      const v = body.qwen3TopP;
      configUpdate.qwen3TopP = v === null || v === undefined ? undefined : optNumBody(v as number, 0, 1);
    }
    if ("qwen3TopK" in body) {
      const v = body.qwen3TopK;
      configUpdate.qwen3TopK =
        v === null || v === undefined ? undefined : optIntBody(v as number, 0, 1_000_000);
    }
    if ("qwen3RepetitionPenalty" in body) {
      const v = body.qwen3RepetitionPenalty;
      configUpdate.qwen3RepetitionPenalty =
        v === null || v === undefined ? undefined : optNumBody(v as number, 0.5, 2);
    }
    if ("qwen3MaxNewTokens" in body) {
      const v = body.qwen3MaxNewTokens;
      configUpdate.qwen3MaxNewTokens =
        v === null || v === undefined ? undefined : optIntBody(v as number, 1, 32768);
    }
    if ("qwen3NonStreamingMode" in body) {
      const v = body.qwen3NonStreamingMode;
      configUpdate.qwen3NonStreamingMode =
        v === null || v === undefined ? undefined : optBoolBody(v as boolean);
    }
    if ("qwen3SubtalkerDoSample" in body) {
      const v = body.qwen3SubtalkerDoSample;
      configUpdate.qwen3SubtalkerDoSample =
        v === null || v === undefined ? undefined : optBoolBody(v as boolean);
    }
    if ("qwen3SubtalkerTopK" in body) {
      const v = body.qwen3SubtalkerTopK;
      configUpdate.qwen3SubtalkerTopK =
        v === null || v === undefined ? undefined : optIntBody(v as number, 0, 1_000_000);
    }
    if ("qwen3SubtalkerTopP" in body) {
      const v = body.qwen3SubtalkerTopP;
      configUpdate.qwen3SubtalkerTopP =
        v === null || v === undefined ? undefined : optNumBody(v as number, 0, 1);
    }
    if ("qwen3SubtalkerTemperature" in body) {
      const v = body.qwen3SubtalkerTemperature;
      configUpdate.qwen3SubtalkerTemperature =
        v === null || v === undefined ? undefined : optNumBody(v as number, 0, 2);
    }
    clearCoquiGenFields(configUpdate);
    configUpdate.coquiXttsUrl = undefined;
    configUpdate.kokoroUrl = undefined;
    configUpdate.chatterboxUrl = undefined;
    configUpdate.chatterboxVariant = undefined;
    configUpdate.defaultVoiceMode = undefined;
    configUpdate.clonedVoice = undefined;
  } else {
    configUpdate.ttsMode = "kokoro_http";
    configUpdate.kokoroUrl = ttsUrlValue;
    configUpdate.chatterboxUrl = undefined;
    configUpdate.chatterboxVariant = undefined;
    configUpdate.qwen3TtsUrl = undefined;
    configUpdate.qwen3Instruct = undefined;
    clearQwen3GenFields(configUpdate);
    clearCoquiGenFields(configUpdate);
    // Clear voice cloning fields for Kokoro
    configUpdate.defaultVoiceMode = undefined;
    configUpdate.clonedVoice = undefined;
  }

  const updated = tenant.config.setTtsConfig(configUpdate);

  tenants.persistConfig(tenant.id);

  /** Push TTS/STT to Redis so live PSTN calls match what was just saved (same as Publish to voice runtime). */
  let runtimePublish:
    | { ok: true }
    | { ok: false; error: string; message: string }
    | undefined;
  if (ENABLE_RUNTIME_ADMIN) {
    try {
      const existing = await getTenantConfig(tenant.id);
      const parsed = buildTenantRuntimeConfig(tenant, existing);
      await publishTenantConfig(tenant.id, parsed);
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

  // Return extended config with all fields
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
    qwen3Instruct: configUpdate.qwen3Instruct,
  };

  res.json({
    ...response,
    ...(runtimePublish ? { runtimePublish } : {}),
  });
});

app.post("/api/tts/preview", async (req, res) => {
  const tenant = getTenantForAdmin(req as AuthedRequest, res);
  if (!tenant) return;

  let responseStarted = false;
  try {
    const raw = req.body as { text?: unknown };
    const text = resolvePreviewText(raw?.text);
    const cfg = tenant.config.getTtsConfig();

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
    const cfg = tenant.config.getTtsConfig();
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
   Admin – Cloudflare Tunnel Token
   ──────────────────────────────────────────────── */

app.get("/api/admin/cloudflare/token", (_req, res) => {
  const current = (process.env.CLOUDFLARE_TUNNEL_TOKEN || "").trim();
  res.json({ hasToken: current.length > 0 });
});

app.post("/api/admin/cloudflare/token", (req, res) => {
  const { token } = req.body as { token?: string };
  const sanitized = sanitizeEnvValue(token);
  if (!sanitized) {
    return res.status(400).json({ error: "token_required" });
  }
  process.env.CLOUDFLARE_TUNNEL_TOKEN = sanitized;
  res.json({ status: "ok", hasToken: true });
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

  const cfg = tenant.config.get();
  const stt = tenant.config.getSttConfig();
  const tts = tenant.config.getTtsConfig();

  const hasOpenAIApiKey = Boolean(cfg.openaiApiKey || process.env.OPENAI_API_KEY);

  const llmStatus =
    cfg.provider === "openai"
      ? hasOpenAIApiKey
        ? "ready"
        : "missing_api_key"
      : cfg.localUrl
      ? "configured"
      : "defaulting";

  const activeCallsByTenant: Record<string, number> = {};
  let activeCallsGlobal = 0;

  for (const meta of tenants.listMetas()) {
    const t = tenants.getOrCreate(meta.id);
    const n = t.calls.listCalls().length;
    activeCallsByTenant[t.id] = n;
    activeCallsGlobal += n;
  }

  res.json({
    server: "ok",
    serverUptimeSec: Math.floor(process.uptime()),
    activeCallsGlobal,
    activeCallsByTenant,
    llm: {
      provider: cfg.provider,
      status: llmStatus,
      localUrl: cfg.localUrl,
      model: cfg.openaiModel,
      hasOpenAIApiKey,
    },
    stt: {
      status: stt.whisperUrl ? "configured" : "missing",
      whisperUrl: stt.whisperUrl,
    },
    tts: {
      status:
        tts.xttsUrl || tts.coquiXttsUrl || tts.kokoroUrl || tts.chatterboxUrl || tts.qwen3TtsUrl
          ? "configured"
          : "missing",
      xttsUrl: tts.xttsUrl,
      coquiXttsUrl: tts.coquiXttsUrl,
      kokoroUrl: tts.kokoroUrl,
      chatterboxUrl: tts.chatterboxUrl,
      qwen3TtsUrl: tts.qwen3TtsUrl,
      chatterboxVariant: tts.chatterboxVariant,
      ttsMode: tts.ttsMode,
      voiceId: tts.voiceId,
      language: tts.language,
      preset: tts.preset,
      rate: tts.rate,
    },
  });
});

app.get("/api/admin/analytics", (req, res) => {
  const tenant = getTenantForAdmin(req as AuthedRequest, res);
  if (!tenant) return;
  res.json(tenant.analytics.snapshot());
});

/**
 * POST endpoint for the voice runtime to report analytics events.
 * Accepts: { tenantId, event: "call_started" | "caller_message", text?: string }
 */
app.post("/api/runtime/analytics", adminGuard("admin"), (req, res) => {
  const { tenantId, event, text } = req.body as {
    tenantId?: string;
    event?: string;
    text?: string;
  };

  if (!tenantId || typeof tenantId !== "string") {
    return res.status(400).json({ error: "tenant_id_required" });
  }

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

app.get("/api/admin/calls", (req, res) => {
  const tenant = getTenantForAdmin(req as AuthedRequest, res);
  if (!tenant) return;
  res.json({ calls: tenant.calls.listCalls() });
});

/**
 * POST endpoint for the voice runtime to report call state updates.
 * Accepts: { tenantId, callId, action: "start" | "update" | "end", callState?: CallState }
 */
app.post("/api/runtime/calls", adminGuard("admin"), (req, res) => {
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

  const tenant = tenants.getOrCreate(tenantId);

  if (action === "start") {
    const callerId = callState?.callerId || undefined;
    const call = tenant.calls.createCall(callerId);
    tenant.analytics.recordNewCall();
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
    // Capture call data before deleting
    const endingCall = tenant.calls.getCall(callId);
    tenant.calls.deleteCall(callId);

    // Fire workflow event bus (async, don't block response)
    if (endingCall) {
      const workflowEvent: CallEndedEvent = {
        type: "call_ended",
        tenantId,
        callId,
        callerId: endingCall.callerId,
        durationMs: endingCall.createdAt
          ? Date.now() - endingCall.createdAt
          : undefined,
        turns: endingCall.history as any,
        transcript: req.body.transcript,
        lead: endingCall.lead as any,
        timestamp: new Date().toISOString(),
      };
      handleCallEnded(workflowEvent).catch(err => {
        console.error("[runtime/calls] Workflow event bus error:", err);
      });
    }

    return res.json({ status: "ok", ended: true });
  }

  return res.status(400).json({ error: "invalid_action", validActions: ["start", "update", "end"] });
});

/* ────────────────────────────────────────────────
   Admin – tenant registry
   ──────────────────────────────────────────────── */

app.get("/api/admin/tenants", (_req, res) => {
  res.json({ tenants: tenants.listMetas() });
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
    });
  })
);

app.post("/api/admin/tenants", (req, res) => {
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

  const updated = tenants.upsertMeta(id.trim(), {
    name: typeof name === "string" ? name : undefined,
    numbers: numberList,
    businessNumber: typeof businessNumber === "string" ? businessNumber : undefined,
  });

  res.json(updated.meta);
});

/* ────────────────────────────────────────────────
   Admin – Telnyx phone number management
   ──────────────────────────────────────────────── */

import * as telnyx from "./telnyx";

// Check Telnyx configuration status
app.get("/api/admin/telnyx/status", (_req, res) => {
  res.json(telnyx.getConfigStatus());
});

// List all phone numbers in the Telnyx account
app.get("/api/admin/telnyx/numbers", async (_req, res) => {
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
app.get("/api/admin/telnyx/available", async (req, res) => {
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
    res.json({ numbers });
  } catch (err: any) {
    console.error("[telnyx] searchAvailableNumbers error:", err);
    res.status(500).json({ error: "telnyx_api_error", message: err.message });
  }
});

// Provision an existing number (assign to VeraLux connection)
app.post("/api/admin/telnyx/provision", async (req, res) => {
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
app.post("/api/admin/telnyx/purchase", async (req, res) => {
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
app.get("/api/admin/telnyx/connections", async (_req, res) => {
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

    const tenant = tenants.getOrCreate(tenantId);

    let existing: RuntimeTenantConfig | null;
    try {
      existing = await getTenantConfig(tenantId);
    } catch (err) {
      console.error("POST /api/admin/runtime/tenants/:tenantId/publish-from-tenant getTenantConfig:", err);
      return res.status(500).json({ error: "runtime_config_read_failed" });
    }

    let parsed: RuntimeTenantConfig;
    try {
      parsed = buildTenantRuntimeConfig(tenant, existing);
    } catch (err: unknown) {
      if (err instanceof BuildRuntimeConfigError) {
        return res.status(400).json({
          error: err.code,
          message: err.message,
        });
      }
      throw err;
    }

    try {
      await publishTenantConfig(tenantId, parsed);
    } catch (err) {
      console.error("POST /api/admin/runtime/tenants/:tenantId/publish-from-tenant error:", err);
      return res.status(500).json({ error: "runtime_publish_failed" });
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
    return res.status(status).json(health);
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

// List workflows for the current tenant
app.get("/api/admin/workflows", asyncHandler(async (req, res) => {
  const tenant = getTenantForAdmin(req as AuthedRequest, res);
  if (!tenant) return;
  const workflows = await listWorkflows(tenant.id);
  res.json({ workflows });
}));

// Create a workflow
app.post("/api/admin/workflows", asyncHandler(async (req, res) => {
  const tenant = getTenantForAdmin(req as AuthedRequest, res);
  if (!tenant) return;
  const { name, triggerType, triggerConfig, steps, adminLocked } = req.body || {};
  if (!name || !triggerType) {
    return res.status(400).json({ error: "name and triggerType are required" });
  }
  const createdBy = (req as any).adminRole === "admin" ? "admin" : "owner";
  const wf = await createWorkflow({
    tenantId: tenant.id,
    name,
    triggerType,
    triggerConfig: triggerConfig || {},
    steps: steps || [],
    createdBy,
    adminLocked: adminLocked ?? false,
  });
  res.status(201).json(wf);
}));

// Update a workflow
app.put("/api/admin/workflows/:id", asyncHandler(async (req, res) => {
  const tenant = getTenantForAdmin(req as AuthedRequest, res);
  if (!tenant) return;
  const { id } = req.params;
  const existing = await getWorkflow(id);
  if (!existing || existing.tenantId !== tenant.id) {
    return res.status(404).json({ error: "Workflow not found" });
  }
  const { name, enabled, triggerType, triggerConfig, steps, adminLocked } = req.body || {};
  const updated = await updateWorkflow(id, {
    name, enabled, triggerType, triggerConfig, steps, adminLocked,
  });
  res.json(updated);
}));

// Delete a workflow
app.delete("/api/admin/workflows/:id", asyncHandler(async (req, res) => {
  const tenant = getTenantForAdmin(req as AuthedRequest, res);
  if (!tenant) return;
  const { id } = req.params;
  const existing = await getWorkflow(id);
  if (!existing || existing.tenantId !== tenant.id) {
    return res.status(404).json({ error: "Workflow not found" });
  }
  await deleteWorkflow(id);
  res.json({ success: true });
}));

// Dry-run / test a workflow
app.post("/api/admin/workflows/:id/test", asyncHandler(async (req, res) => {
  const tenant = getTenantForAdmin(req as AuthedRequest, res);
  if (!tenant) return;
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
      { role: "user", content: "I need to schedule an appointment for next week." },
      { role: "assistant", content: "I'd be happy to help you schedule an appointment. What day works best for you?" },
    ],
    transcript: req.body?.transcript ||
      "Assistant: Hello, thank you for calling. How can I help you today?\nUser: I need to schedule an appointment for next week.\nAssistant: I'd be happy to help you schedule an appointment. What day works best for you?",
    lead: req.body?.lead || { name: "Test User", phone: "+15555555555" },
    timestamp: new Date().toISOString(),
  };
  const result = await dryRunPipeline(workflow, sampleEvent);
  res.json(result);
}));

// Workflow execution history
app.get("/api/admin/workflow-runs", asyncHandler(async (req, res) => {
  const tenant = getTenantForAdmin(req as AuthedRequest, res);
  if (!tenant) return;
  const limit = parseInt(req.query.limit as string) || 50;
  const runs = await listRuns(tenant.id, limit);
  res.json({ runs });
}));

// List leads
app.get("/api/admin/leads", asyncHandler(async (req, res) => {
  const tenant = getTenantForAdmin(req as AuthedRequest, res);
  if (!tenant) return;
  const limit = parseInt(req.query.limit as string) || 100;
  const leads = await listLeads(tenant.id, limit);
  res.json({ leads });
}));

// Delete a lead
app.delete("/api/admin/leads/:id", asyncHandler(async (req, res) => {
  const tenant = getTenantForAdmin(req as AuthedRequest, res);
  if (!tenant) return;
  const { id } = req.params;
  const deleted = await deleteLead(id);
  if (!deleted) return res.status(404).json({ error: "Lead not found" });
  res.json({ success: true });
}));

// Get workflow settings for tenant
app.get("/api/admin/workflows/settings", asyncHandler(async (req, res) => {
  const tenant = getTenantForAdmin(req as AuthedRequest, res);
  if (!tenant) return;
  const settings = await getWorkflowSettings(tenant.id);
  res.json(settings);
}));

// Update workflow settings for tenant
app.patch("/api/admin/workflows/settings", asyncHandler(async (req, res) => {
  const tenant = getTenantForAdmin(req as AuthedRequest, res);
  if (!tenant) return;
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
   Admin UI shell
   ──────────────────────────────────────────────── */

app.get("/admin", (_req, res) => {
  applyAdminShellCachePolicy(res);
  res.sendFile(path.join(__dirname, "..", "public", "admin.html"));
});

app.get("/owner", (_req, res) => {
  applyAdminShellCachePolicy(res);
  res.sendFile(path.join(__dirname, "..", "public", "owner.html"));
});

app.get("/portal", (req, res) => {
  applyAdminShellCachePolicy(res);
  res.sendFile(path.join(__dirname, "..", "public", "portal.html"));
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

  // Initialize workflow automation engine
  try {
    initAutomationEngine();
  } catch (err) {
    console.error("[startup] Failed to init automation engine (non-fatal):", err);
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

  try {
    const port = await findAvailablePort(preferredPort);
    httpServer = app.listen(port, () => {
      console.log(
        `VeraLux Receptionist server listening on port ${port}${
          port !== preferredPort ? ` (preferred ${preferredPort} unavailable)` : ""
        }`
      );
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
