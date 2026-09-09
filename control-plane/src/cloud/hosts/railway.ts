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

const GQL = "https://backboard.railway.app/graphql/v2";

export const railwayClient = {
  async gql(query: string, variables: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const token = await getHostCredential("railway_token");
    if (!token) throw new Error("railway_token_missing");
    const res = await fetch(GQL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query, variables }),
    });
    const json = (await res.json()) as { data?: Record<string, unknown>; errors?: Array<{ message: string }> };
    if (!res.ok || json.errors?.length) {
      throw new Error(json.errors?.[0]?.message || `railway_http_${res.status}`);
    }
    return json.data || {};
  },
};

export const railwayAdapter: HostAdapter = {
  name: "railway",
  async validateCredentials() {
    try {
      await railwayClient.gql("query { me { id } }");
      return { ok: true };
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) };
    }
  },
  quoteMonthlyCents(size, region) {
    return quoteHostMonthlyCents("railway", size, region);
  },
  async provision(spec: HostProvisionSpec): Promise<CreatedStack> {
    if (spec.size === "free") throw new Error("free_tier_forbidden");
    const name = `veralux-${spec.tenantId}`.replace(/[^a-z0-9-]/gi, "-").slice(0, 40);
    const created = await railwayClient.gql(
      `mutation($name: String!) { projectCreate(input: { name: $name }) { id } }`,
      { name },
    );
    const projectId = (created.projectCreate as { id?: string } | undefined)?.id;
    if (!projectId) throw new Error("railway_project_create_failed");

    const envData = await railwayClient.gql(
      `query($id: String!) { project(id: $id) { environments { edges { node { id name } } } } }`,
      { id: projectId },
    );
    const environments = (envData.project as { environments?: { edges?: Array<{ node?: { id?: string } }> } })?.environments;
    const environmentId = environments?.edges?.[0]?.node?.id;
    if (!environmentId) throw new Error("railway_environment_missing");

    const pg = await railwayClient.gql(
      `mutation($projectId: String!, $name: String!) { pluginCreate(input: { projectId: $projectId, name: $name }) { id } }`,
      { projectId, name: `${name}-pg` },
    );
    const postgresId = (pg.pluginCreate as { id?: string } | undefined)?.id;
    if (!postgresId) throw new Error("railway_postgres_create_failed");
    await spec.onStep?.("create_db");

    const kv = await railwayClient.gql(
      `mutation($projectId: String!, $name: String!) { pluginCreate(input: { projectId: $projectId, name: $name }) { id } }`,
      { projectId, name: `${name}-redis` },
    );
    const redisId = (kv.pluginCreate as { id?: string } | undefined)?.id;
    if (!redisId) throw new Error("railway_redis_create_failed");
    await spec.onStep?.("create_redis");

    const controlImage = `${spec.imageRegistry}/veralux-control-plane:${spec.imageVersion}`;
    const runtimeImage = `${spec.imageRegistry}/veralux-voice-runtime:${spec.imageVersion}`;

    const control = await railwayClient.gql(
      `mutation($projectId: String!, $name: String!, $image: String!) {
        serviceCreate(input: { projectId: $projectId, name: $name, source: { image: $image } }) { id }
      }`,
      { projectId, name: `${name}-control`, image: controlImage },
    );
    const controlId = (control.serviceCreate as { id?: string } | undefined)?.id;
    if (!controlId) throw new Error("railway_control_create_failed");
    await spec.onStep?.("create_control");

    const runtime = await railwayClient.gql(
      `mutation($projectId: String!, $name: String!, $image: String!) {
        serviceCreate(input: { projectId: $projectId, name: $name, source: { image: $image } }) { id }
      }`,
      { projectId, name: `${name}-runtime`, image: runtimeImage },
    );
    const runtimeId = (runtime.serviceCreate as { id?: string } | undefined)?.id;
    if (!runtimeId) throw new Error("railway_runtime_create_failed");
    await spec.onStep?.("create_runtime");

    return {
      databaseId: postgresId,
      redisId,
      handles: {
        provider: "railway",
        projectId,
        environmentId,
        controlId,
        runtimeId,
        postgresId,
        redisId,
        size: spec.size,
        region: spec.region || "us-west2",
      },
    };
  },
  async resolveConnection(handles): Promise<ResolvedStack> {
    const projectId = String(handles.projectId || "");
    const environmentId = String(handles.environmentId || "");
    const controlId = String(handles.controlId || "");
    const runtimeId = String(handles.runtimeId || "");
    const postgresId = String(handles.postgresId || "");
    const redisId = String(handles.redisId || "");
    if (!projectId || !environmentId || !controlId || !runtimeId) throw new Error("railway_handles_incomplete");

    const vars = await retryUntil(async () => {
      const data = await railwayClient.gql(
        `query($projectId: String!, $environmentId: String!) {
          variables(projectId: $projectId, environmentId: $environmentId)
        }`,
        { projectId, environmentId },
      );
      const raw = data.variables;
      if (raw && typeof raw === "object") return raw as Record<string, string>;
      return null;
    }, { label: "railway_variables" });

    const databaseUrl = vars.DATABASE_URL || vars.POSTGRES_URL || vars[`DATABASE_URL_${postgresId}`];
    const redisUrl = vars.REDIS_URL || vars.REDIS_PRIVATE_URL || vars[`REDIS_URL_${redisId}`];
    if (!databaseUrl || !redisUrl) throw new Error("railway_connection_strings_missing");

    const controlDomain = await retryUntil(async () => {
      const created = await railwayClient.gql(
        `mutation($serviceId: String!, $environmentId: String!) {
          serviceDomainCreate(input: { serviceId: $serviceId, environmentId: $environmentId }) {
            domain { domain }
          }
        }`,
        { serviceId: controlId, environmentId },
      );
      return (created.serviceDomainCreate as { domain?: { domain?: string } } | undefined)?.domain?.domain;
    }, { label: "railway_control_domain" });

    const runtimeDomain = await retryUntil(async () => {
      const created = await railwayClient.gql(
        `mutation($serviceId: String!, $environmentId: String!) {
          serviceDomainCreate(input: { serviceId: $serviceId, environmentId: $environmentId }) {
            domain { domain }
          }
        }`,
        { serviceId: runtimeId, environmentId },
      );
      return (created.serviceDomainCreate as { domain?: { domain?: string } } | undefined)?.domain?.domain;
    }, { label: "railway_runtime_domain" });

    return {
      controlUrl: assertPublicServiceUrl(`https://${controlDomain}`, "control"),
      runtimeUrl: assertPublicServiceUrl(`https://${runtimeDomain}`, "runtime"),
      databaseUrl: assertConnectionString(databaseUrl, "database_url"),
      redisUrl: assertConnectionString(redisUrl, "redis_url"),
      handles: { ...handles, controlDomain, runtimeDomain },
    };
  },
  async injectEnv(handles, env) {
    const projectId = String(handles.projectId || "");
    const environmentId = String(handles.environmentId || "");
    const controlId = String(handles.controlId || "");
    const runtimeId = String(handles.runtimeId || "");
    if (!projectId || !environmentId || !controlId || !runtimeId) throw new Error("railway_handles_incomplete");
    for (const serviceId of [controlId, runtimeId]) {
      const data = await railwayClient.gql(
        `mutation($projectId: String!, $environmentId: String!, $serviceId: String!, $variables: Json!) {
          variableCollectionUpsert(input: {
            projectId: $projectId, environmentId: $environmentId, serviceId: $serviceId, variables: $variables
          })
        }`,
        { projectId, environmentId, serviceId, variables: env },
      );
      if (!("variableCollectionUpsert" in data)) throw new Error("railway_variable_upsert_failed");
    }
  },
  async waitHealthy(urls) {
    await waitUntilHealthy(urls);
  },
  async syncStatus(handles): Promise<HostStatus> {
    const projectId = String(handles.projectId || "");
    if (!projectId) return { ready: false, detail: "missing_project_id" };
    try {
      await railwayClient.gql("query($id: String!) { project(id: $id) { id name } }", { id: projectId });
      const controlUrl = handles.controlDomain ? `https://${handles.controlDomain}` : undefined;
      const runtimeUrl = handles.runtimeDomain ? `https://${handles.runtimeDomain}` : undefined;
      if (!controlUrl || !runtimeUrl) return { ready: false, detail: "no_domain", controlUrl, runtimeUrl };
      const controlOk = await fetch(`${controlUrl}/health`).then((r) => r.ok).catch(() => false);
      const runtimeOk = await fetch(`${runtimeUrl}/health/live`).then((r) => r.ok).catch(() => false);
      return { ready: controlOk && runtimeOk, controlUrl, runtimeUrl, detail: controlOk && runtimeOk ? "ok" : "health_pending" };
    } catch (e) {
      return { ready: false, detail: e instanceof Error ? e.message : String(e) };
    }
  },
  async teardown(handles) {
    const projectId = String(handles.projectId || "");
    if (!projectId) return;
    await railwayClient.gql(`mutation($id: String!) { projectDelete(id: $id) }`, { id: projectId });
  },
};
