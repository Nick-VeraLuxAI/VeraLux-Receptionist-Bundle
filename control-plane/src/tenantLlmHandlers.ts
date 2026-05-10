import { createHash } from "crypto";
import type { Express, Request, Response } from "express";
import { z } from "zod";
import {
  TENANT_LLM_OPENAI_SECRET_KEY,
  runtimeTenantLlmRoutingSchema,
  type RuntimeTenantLlmRouting,
} from "@veralux/shared";
import { secretStore } from "./secretStore";
import type { TenantContext } from "./tenants";

export function fingerprintApiKey(key: string): string {
  return createHash("sha256").update(key, "utf8").digest("hex").slice(0, 16);
}

function readPortal(state: Record<string, unknown>): RuntimeTenantLlmRouting | null {
  const raw = state.llmPortal;
  if (!raw || typeof raw !== "object") return null;
  const parsed = runtimeTenantLlmRoutingSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

export function publicLlmSummaryFromTenant(ctx: TenantContext): Record<string, unknown> {
  const portal = readPortal(ctx.operatorState);
  const rawPortal = (ctx.operatorState.llmPortal as Record<string, unknown> | undefined) ?? {};
  const mode = portal?.mode ?? "platform_default";
  return {
    configured: portal?.mode === "tenant_api_key" && Boolean(portal.tenantApiKeyConfigured),
    mode,
    provider: portal?.tenantProvider ?? null,
    model: portal?.tenantModel ?? null,
    fingerprint: typeof rawPortal.apiKeyFingerprint === "string" ? rawPortal.apiKeyFingerprint : null,
    lastTestedAt: typeof rawPortal.lastTestedAt === "string" ? rawPortal.lastTestedAt : null,
    lastStatus: typeof rawPortal.lastStatus === "string" ? rawPortal.lastStatus : null,
    tenantKeyErrorPolicy: portal?.tenantKeyErrorPolicy ?? "platform_default",
  };
}

const postBodySchema = z.object({
  mode: z.enum(["platform_default", "tenant_api_key"]),
  tenantProvider: z.enum(["openai"]).optional(),
  tenantModel: z.string().min(1).max(128).optional(),
  tenantKeyErrorPolicy: z.enum(["platform_default", "fail"]).optional(),
  apiKey: z.string().min(8).max(512).optional(),
  removeApiKey: z.boolean().optional(),
});

export async function applyTenantLlmPortalPatch(
  ctx: TenantContext,
  body: unknown,
): Promise<{ summary: Record<string, unknown>; portal: RuntimeTenantLlmRouting & Record<string, unknown> }> {
  const parsed = postBodySchema.safeParse(body ?? {});
  if (!parsed.success) {
    const err = new Error("invalid_body");
    (err as Error & { status: number; details: unknown }).status = 400;
    (err as Error & { details: unknown }).details = parsed.error.flatten();
    throw err;
  }
  const b = parsed.data;
  const prev = (ctx.operatorState.llmPortal as Record<string, unknown> | undefined) ?? {};

  if (b.mode === "platform_default") {
    try {
      await secretStore.deleteSecret(ctx.id, TENANT_LLM_OPENAI_SECRET_KEY);
    } catch (e) {
      console.warn("[llm-config] deleteSecret failed (env secret manager may be read-only)", e);
    }
    const portal: RuntimeTenantLlmRouting & Record<string, unknown> = {
      ...prev,
      mode: "platform_default",
      tenantApiKeyConfigured: false,
      tenantKeyErrorPolicy: "platform_default",
    };
    delete portal.tenantProvider;
    delete portal.tenantModel;
    delete portal.apiKeyFingerprint;
    const nextCtx: TenantContext = {
      ...ctx,
      operatorState: { ...ctx.operatorState, llmPortal: portal },
    };
    return { summary: publicLlmSummaryFromTenant(nextCtx), portal };
  }

  if (b.removeApiKey) {
    try {
      await secretStore.deleteSecret(ctx.id, TENANT_LLM_OPENAI_SECRET_KEY);
    } catch (e) {
      console.warn("[llm-config] deleteSecret failed (env secret manager may be read-only)", e);
    }
  }
  if (typeof b.apiKey === "string" && b.apiKey.trim()) {
    await secretStore.setSecret(ctx.id, TENANT_LLM_OPENAI_SECRET_KEY, b.apiKey.trim());
  }

  const hasSecretAfter = await secretStore.hasSecret(ctx.id, TENANT_LLM_OPENAI_SECRET_KEY);

  const portal: RuntimeTenantLlmRouting & Record<string, unknown> = {
    ...prev,
    mode: b.mode,
    tenantProvider: b.mode === "tenant_api_key" ? b.tenantProvider ?? "openai" : undefined,
    tenantModel: b.mode === "tenant_api_key" ? b.tenantModel?.trim() || "gpt-4o-mini" : undefined,
    tenantApiKeyConfigured: b.mode === "tenant_api_key" ? (b.removeApiKey ? false : hasSecretAfter) : false,
    tenantKeyErrorPolicy:
      b.tenantKeyErrorPolicy === "fail"
        ? "fail"
        : prev.tenantKeyErrorPolicy === "fail"
          ? "fail"
          : "platform_default",
  };

  if (typeof b.apiKey === "string" && b.apiKey.trim()) {
    portal.apiKeyFingerprint = fingerprintApiKey(b.apiKey.trim());
  } else if (b.removeApiKey) {
    portal.apiKeyFingerprint = undefined;
  }

  const nextCtx: TenantContext = {
    ...ctx,
    operatorState: { ...ctx.operatorState, llmPortal: portal },
  };
  return { summary: publicLlmSummaryFromTenant(nextCtx), portal };
}

export async function testTenantOpenAiKey(apiKey: string, _model: string): Promise<{ ok: boolean; status: string }> {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 12_000);
  try {
    const res = await fetch("https://api.openai.com/v1/models", {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey.trim()}` },
      signal: controller.signal,
    });
    if (!res.ok) {
      return { ok: false, status: `http_${res.status}` };
    }
    return { ok: true, status: "ok" };
  } catch {
    return { ok: false, status: "network_error" };
  } finally {
    clearTimeout(t);
  }
}

export type TenantLlmRouteDeps = {
  mergeOperatorState: (tenantId: string, patch: Record<string, unknown>) => TenantContext;
  afterMutation: (tenantId: string) => Promise<unknown>;
};

export function registerTenantLlmRoutes(
  app: Express,
  deps: TenantLlmRouteDeps & {
    /** Same middleware as `server.ts` adminGuard (async); typed loosely to avoid circular Express typings. */
    adminGuard: (role: "admin" | "viewer") => (req: Request, res: Response, next: (err?: unknown) => void) => unknown;
    ensureTenantAccess: (req: Request, res: Response, tenantId: string) => boolean;
    getAdminToken: (req: Request) => string | undefined;
    verifyOwnerPortalToken: (raw: string) => Promise<{ tenantId: string } | null>;
    tenantsGetOrCreate: (id: string) => TenantContext;
  },
): void {
  const { mergeOperatorState, afterMutation, adminGuard, ensureTenantAccess, getAdminToken, verifyOwnerPortalToken, tenantsGetOrCreate } = deps;

  app.get(
    "/api/admin/tenants/:tenantId/llm-config",
    adminGuard("admin"),
    async (req, res) => {
      try {
        const tenantId = req.params.tenantId?.trim();
        if (!tenantId) return res.status(400).json({ error: "tenant_id_required" });
        if (!ensureTenantAccess(req, res, tenantId)) return;
        const ctx = tenantsGetOrCreate(tenantId);
        res.json(publicLlmSummaryFromTenant(ctx));
      } catch (e) {
        console.error("GET /api/admin/tenants/:tenantId/llm-config", e);
        res.status(500).json({ error: "llm_config_read_failed" });
      }
    },
  );

  app.post(
    "/api/admin/tenants/:tenantId/llm-config",
    adminGuard("admin"),
    async (req, res) => {
      try {
        const tenantId = req.params.tenantId?.trim();
        if (!tenantId) return res.status(400).json({ error: "tenant_id_required" });
        if (!ensureTenantAccess(req, res, tenantId)) return;
        const ctx = tenantsGetOrCreate(tenantId);
        const { portal } = await applyTenantLlmPortalPatch(ctx, req.body);
        mergeOperatorState(tenantId, { llmPortal: portal });
        await afterMutation(tenantId);
        const nextCtx = tenantsGetOrCreate(tenantId);
        res.json(publicLlmSummaryFromTenant(nextCtx));
      } catch (e) {
        const status = (e as Error & { status?: number })?.status ?? 500;
        if (status === 400) {
          return res.status(400).json({ error: "invalid_body", details: (e as Error & { details?: unknown }).details });
        }
        console.error("POST /api/admin/tenants/:tenantId/llm-config", e);
        res.status(500).json({ error: "llm_config_write_failed" });
      }
    },
  );

  app.post("/api/owner/llm-config", async (req, res) => {
    try {
      const raw = getAdminToken(req);
      if (!raw) return res.status(401).json({ error: "auth_required" });
      const session = await verifyOwnerPortalToken(raw);
      if (!session) return res.status(401).json({ error: "invalid_or_expired_session" });
      const ctx = tenantsGetOrCreate(session.tenantId);
      const { portal } = await applyTenantLlmPortalPatch(ctx, req.body);
      mergeOperatorState(session.tenantId, { llmPortal: portal });
      await afterMutation(session.tenantId);
      const nextCtx = tenantsGetOrCreate(session.tenantId);
      res.setHeader("Cache-Control", "no-store, private");
      res.json(publicLlmSummaryFromTenant(nextCtx));
    } catch (e) {
      const status = (e as Error & { status?: number })?.status ?? 500;
      if (status === 400) {
        return res.status(400).json({ error: "invalid_body", details: (e as Error & { details?: unknown }).details });
      }
      console.error("POST /api/owner/llm-config", e);
      res.status(500).json({ error: "llm_config_write_failed" });
    }
  });

  app.get("/api/owner/llm-config", async (req, res) => {
    try {
      const raw = getAdminToken(req);
      if (!raw) return res.status(401).json({ error: "auth_required" });
      const session = await verifyOwnerPortalToken(raw);
      if (!session) return res.status(401).json({ error: "invalid_or_expired_session" });
      const ctx = tenantsGetOrCreate(session.tenantId);
      res.setHeader("Cache-Control", "no-store, private");
      res.json(publicLlmSummaryFromTenant(ctx));
    } catch (e) {
      console.error("GET /api/owner/llm-config", e);
      res.status(500).json({ error: "llm_config_read_failed" });
    }
  });

  app.post("/api/owner/llm-config/api-key", async (req, res) => {
    try {
      const raw = getAdminToken(req);
      if (!raw) return res.status(401).json({ error: "auth_required" });
      const session = await verifyOwnerPortalToken(raw);
      if (!session) return res.status(401).json({ error: "invalid_or_expired_session" });
      const ctx = tenantsGetOrCreate(session.tenantId);
      const { portal } = await applyTenantLlmPortalPatch(ctx, req.body);
      mergeOperatorState(session.tenantId, { llmPortal: portal });
      await afterMutation(session.tenantId);
      const nextCtx = tenantsGetOrCreate(session.tenantId);
      res.setHeader("Cache-Control", "no-store, private");
      res.json(publicLlmSummaryFromTenant(nextCtx));
    } catch (e) {
      const status = (e as Error & { status?: number })?.status ?? 500;
      if (status === 400) {
        return res.status(400).json({ error: "invalid_body", details: (e as Error & { details?: unknown }).details });
      }
      console.error("POST /api/owner/llm-config/api-key", e);
      res.status(500).json({ error: "llm_config_write_failed" });
    }
  });

  app.post("/api/owner/llm-config/test", async (req, res) => {
    try {
      const raw = getAdminToken(req);
      if (!raw) return res.status(401).json({ error: "auth_required" });
      const session = await verifyOwnerPortalToken(raw);
      if (!session) return res.status(401).json({ error: "invalid_or_expired_session" });
      const body = z.object({ apiKey: z.string().min(8), model: z.string().min(1).max(128).optional() }).safeParse(req.body ?? {});
      if (!body.success) return res.status(400).json({ error: "invalid_body" });
      const r = await testTenantOpenAiKey(body.data.apiKey, body.data.model?.trim() || "gpt-4o-mini");
      const portal = (tenantsGetOrCreate(session.tenantId).operatorState.llmPortal as Record<string, unknown> | undefined) ?? {};
      mergeOperatorState(session.tenantId, {
        llmPortal: {
          ...portal,
          lastTestedAt: new Date().toISOString(),
          lastStatus: r.ok ? "ok" : r.status,
        },
      });
      await afterMutation(session.tenantId);
      res.json({ ok: r.ok, status: r.status });
    } catch (e) {
      console.error("POST /api/owner/llm-config/test", e);
      res.status(500).json({ error: "llm_test_failed" });
    }
  });

  app.post(
    "/api/admin/tenants/:tenantId/llm-config/test",
    adminGuard("admin"),
    async (req, res) => {
      try {
        const tenantId = req.params.tenantId?.trim();
        if (!tenantId) return res.status(400).json({ error: "tenant_id_required" });
        if (!ensureTenantAccess(req, res, tenantId)) return;
        const body = z.object({ apiKey: z.string().min(8), model: z.string().min(1).max(128).optional() }).safeParse(req.body ?? {});
        if (!body.success) return res.status(400).json({ error: "invalid_body" });
        const r = await testTenantOpenAiKey(body.data.apiKey, body.data.model?.trim() || "gpt-4o-mini");
        const portal = (tenantsGetOrCreate(tenantId).operatorState.llmPortal as Record<string, unknown> | undefined) ?? {};
        mergeOperatorState(tenantId, {
          llmPortal: {
            ...portal,
            lastTestedAt: new Date().toISOString(),
            lastStatus: r.ok ? "ok" : r.status,
          },
        });
        await afterMutation(tenantId);
        res.json({ ok: r.ok, status: r.status });
      } catch (e) {
        console.error("POST /api/admin/tenants/:tenantId/llm-config/test", e);
        res.status(500).json({ error: "llm_test_failed" });
      }
    },
  );

  app.get(
    "/api/runtime/tenants/:tenantId/secrets/llm_openai_api_key",
    adminGuard("admin"),
    async (req, res) => {
      try {
        const tenantId = req.params.tenantId?.trim();
        if (!tenantId) return res.status(400).json({ error: "tenant_id_required" });
        if (!ensureTenantAccess(req, res, tenantId)) return;
        const key = await secretStore.getSecret(tenantId, TENANT_LLM_OPENAI_SECRET_KEY);
        res.json({ apiKey: key ?? null });
      } catch (e) {
        console.error("GET runtime llm secret", e);
        res.status(500).json({ error: "secret_read_failed" });
      }
    },
  );
}
