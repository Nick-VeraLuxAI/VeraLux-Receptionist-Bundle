import { assertConnectionString, assertPublicServiceUrl } from "../cloudStackEnv";
import { waitUntilHealthy } from "../waitHealthy";
import { getHostCredential } from "./credentials";
import { retryUntil } from "./poll";
import { quoteHostMonthlyCents } from "./quotes";
import type {
  CreatedStack,
  HostAdapter,
  HostProvisionSpec,
  HostStatus,
  ResolvedStack,
} from "./types";

const API = "https://api.render.com/v1";

export const renderClient = {
  async fetch(path: string, init: RequestInit = {}): Promise<unknown> {
    const key = await getHostCredential("render_api_key");
    if (!key) throw new Error("render_api_key_missing");
    const res = await fetch(`${API}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${key}`,
        Accept: "application/json",
        "Content-Type": "application/json",
        ...(init.headers || {}),
      },
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`render_http_${res.status}`);
    return text ? JSON.parse(text) : {};
  },
};

function planForSize(size: string): string {
  if (size === "pro") return "pro";
  if (size === "standard") return "standard";
  return "starter";
}

function envVarList(env: Record<string, string>): Array<{ key: string; value: string }> {
  return Object.entries(env).map(([key, value]) => ({ key, value }));
}

export const renderAdapter: HostAdapter = {
  name: "render",
  async validateCredentials() {
    try {
      await renderClient.fetch("/owners");
      return { ok: true };
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) };
    }
  },
  quoteMonthlyCents(size, region) {
    return quoteHostMonthlyCents("render", size, region);
  },
  async provision(spec: HostProvisionSpec): Promise<CreatedStack> {
    if (spec.size === "free") throw new Error("free_tier_forbidden");
    const plan = planForSize(spec.size);
    const region = spec.region || "oregon";
    const controlImage = `${spec.imageRegistry}/veralux-control-plane:${spec.imageVersion}`;
    const runtimeImage = `${spec.imageRegistry}/veralux-voice-runtime:${spec.imageVersion}`;
    const nameBase = `vl-${spec.tenantId}`.replace(/[^a-z0-9-]/gi, "-").slice(0, 24).toLowerCase();

    const postgres = (await renderClient.fetch("/postgres", {
      method: "POST",
      body: JSON.stringify({ name: `${nameBase}-pg`, plan, region }),
    })) as { id?: string; postgres?: { id?: string } };
    const postgresId = postgres.id || postgres.postgres?.id;
    if (!postgresId) throw new Error("render_postgres_create_failed");
    await spec.onStep?.("create_db");

    const redis = (await renderClient.fetch("/key-value", {
      method: "POST",
      body: JSON.stringify({ name: `${nameBase}-kv`, plan, region }),
    })) as { id?: string; keyValue?: { id?: string } };
    const redisId = redis.id || redis.keyValue?.id;
    if (!redisId) throw new Error("render_redis_create_failed");
    await spec.onStep?.("create_redis");

    const control = (await renderClient.fetch("/services", {
      method: "POST",
      body: JSON.stringify({
        type: "web_service",
        name: `${nameBase}-control`,
        runtime: "image",
        plan,
        region,
        image: { url: controlImage },
        envVars: [{ key: "DEPLOYMENT_PROFILE", value: "cloud-api" }],
      }),
    })) as { service?: { id?: string }; id?: string };
    const controlId = control.service?.id || control.id;
    if (!controlId) throw new Error("render_control_create_failed");
    await spec.onStep?.("create_control");

    const runtime = (await renderClient.fetch("/services", {
      method: "POST",
      body: JSON.stringify({
        type: "web_service",
        name: `${nameBase}-runtime`,
        runtime: "image",
        plan,
        region,
        image: { url: runtimeImage },
        envVars: [{ key: "DEPLOYMENT_PROFILE", value: "cloud-api" }],
      }),
    })) as { service?: { id?: string }; id?: string };
    const runtimeId = runtime.service?.id || runtime.id;
    if (!runtimeId) throw new Error("render_runtime_create_failed");
    await spec.onStep?.("create_runtime");

    return {
      databaseId: postgresId,
      redisId,
      handles: { provider: "render", controlId, runtimeId, postgresId, redisId, region, plan },
    };
  },
  async resolveConnection(handles): Promise<ResolvedStack> {
    const postgresId = String(handles.postgresId || "");
    const redisId = String(handles.redisId || "");
    const controlId = String(handles.controlId || "");
    const runtimeId = String(handles.runtimeId || "");
    if (!postgresId || !redisId || !controlId || !runtimeId) throw new Error("render_handles_incomplete");

    const databaseUrl = await retryUntil(async () => {
      const info = (await renderClient.fetch(`/postgres/${postgresId}/connection-info`)) as {
        internalConnectionString?: string;
        externalConnectionString?: string;
      };
      return info.internalConnectionString || info.externalConnectionString;
    }, { label: "render_postgres_url" });

    const redisUrl = await retryUntil(async () => {
      const info = (await renderClient.fetch(`/key-value/${redisId}`)) as {
        keyValue?: { internalConnectionString?: string };
        internalConnectionString?: string;
      };
      return info.internalConnectionString || info.keyValue?.internalConnectionString;
    }, { label: "render_redis_url" });

    const controlUrl = await retryUntil(async () => {
      const svc = (await renderClient.fetch(`/services/${controlId}`)) as {
        service?: { serviceDetails?: { url?: string } };
      };
      return svc.service?.serviceDetails?.url;
    }, { label: "render_control_url" });

    const runtimeUrl = await retryUntil(async () => {
      const svc = (await renderClient.fetch(`/services/${runtimeId}`)) as {
        service?: { serviceDetails?: { url?: string } };
      };
      return svc.service?.serviceDetails?.url;
    }, { label: "render_runtime_url" });

    return {
      controlUrl: assertPublicServiceUrl(controlUrl, "control"),
      runtimeUrl: assertPublicServiceUrl(runtimeUrl, "runtime"),
      databaseUrl: assertConnectionString(databaseUrl, "database_url"),
      redisUrl: assertConnectionString(redisUrl, "redis_url"),
      handles,
    };
  },
  async injectEnv(handles, env) {
    const controlId = String(handles.controlId || "");
    const runtimeId = String(handles.runtimeId || "");
    if (!controlId || !runtimeId) throw new Error("render_handles_incomplete");
    const body = JSON.stringify(envVarList(env));
    await renderClient.fetch(`/services/${controlId}/env-vars`, { method: "PUT", body });
    await renderClient.fetch(`/services/${runtimeId}/env-vars`, { method: "PUT", body });
    await renderClient.fetch(`/services/${controlId}/deploys`, { method: "POST", body: JSON.stringify({ clearCache: "do_not_clear" }) });
    await renderClient.fetch(`/services/${runtimeId}/deploys`, { method: "POST", body: JSON.stringify({ clearCache: "do_not_clear" }) });
  },
  async waitHealthy(urls) {
    await waitUntilHealthy(urls);
  },
  async syncStatus(handles): Promise<HostStatus> {
    const controlId = String(handles.controlId || "");
    const runtimeId = String(handles.runtimeId || "");
    if (!controlId || !runtimeId) return { ready: false, detail: "missing_service_id" };
    try {
      const control = (await renderClient.fetch(`/services/${controlId}`)) as {
        service?: { serviceDetails?: { url?: string } };
      };
      const runtime = (await renderClient.fetch(`/services/${runtimeId}`)) as {
        service?: { serviceDetails?: { url?: string } };
      };
      const controlUrl = control.service?.serviceDetails?.url;
      const runtimeUrl = runtime.service?.serviceDetails?.url;
      if (!controlUrl || !runtimeUrl) return { ready: false, detail: "no_url" };
      const controlOk = await fetch(`${controlUrl.replace(/\/$/, "")}/health`).then((r) => r.ok).catch(() => false);
      const runtimeOk = await fetch(`${runtimeUrl.replace(/\/$/, "")}/health/live`).then((r) => r.ok).catch(() => false);
      return {
        ready: controlOk && runtimeOk,
        controlUrl,
        runtimeUrl,
        detail: controlOk && runtimeOk ? "ok" : "health_pending",
      };
    } catch (e) {
      return { ready: false, detail: e instanceof Error ? e.message : String(e) };
    }
  },
  async teardown(handles) {
    const ids = [handles.controlId, handles.runtimeId].filter(Boolean);
    for (const id of ids) {
      try {
        await renderClient.fetch(`/services/${id}`, { method: "DELETE" });
      } catch {
        /* continue */
      }
    }
    if (handles.postgresId) {
      try {
        await renderClient.fetch(`/postgres/${handles.postgresId}`, { method: "DELETE" });
      } catch {
        /* continue */
      }
    }
    if (handles.redisId) {
      try {
        await renderClient.fetch(`/key-value/${handles.redisId}`, { method: "DELETE" });
      } catch {
        /* continue */
      }
    }
  },
};
