import { TENANT_LLM_OPENAI_SECRET_KEY, componentBySku, isPaidCloudHost } from "@veralux/shared";
import { secretStore, setPlatformSecret, getPlatformSecret } from "../secretStore";
import { tenants } from "../tenants";
import {
  buildCloudStackEnv,
  generateCloudStackSecrets,
  missingCreateSteps,
  type CloudVendorKeys,
} from "./cloudStackEnv";
import { configureTenantTelnyx, type TelnyxConfigureResult } from "./configureTelnyx";
import { getHostAdapter } from "./hosts";
import { getHostCredential } from "./hosts/credentials";
import type { HostAdapter } from "./hosts/types";
import {
  getActiveDeployment,
  getDeployment,
  insertDeployment,
  insertProvisionJob,
  updateDeployment,
  updateProvisionJob,
} from "./pipelineDb";

export type ProvisionStepRecord = { step: string; ok: boolean; at: string };

export type ExecuteProvisionInput = {
  adapter: HostAdapter;
  tenantId: string;
  deploymentId: string;
  size: string;
  region?: string;
  imageRegistry: string;
  imageVersion: string;
  vendorKeys: CloudVendorKeys;
  recordedSteps: string[];
  onStep: (step: string) => Promise<void>;
  configureTelnyx?: (input: { tenantId: string; runtimeUrl: string }) => Promise<TelnyxConfigureResult>;
  storeAdminKey?: (deploymentId: string, adminApiKey: string) => Promise<void>;
  waitHealthyTimeoutMs?: number;
};

export function deploymentAdminKeyName(deploymentId: string): string {
  return `deployment_admin_${deploymentId}`;
}

export async function resolveVendorKeys(tenantId: string): Promise<CloudVendorKeys> {
  const tenantKey = await secretStore.getSecret(tenantId, TENANT_LLM_OPENAI_SECRET_KEY);
  const portal = (tenants.getOrCreate(tenantId).operatorState?.llmPortal || {}) as Record<string, unknown>;
  return {
    openaiApiKey: process.env.OPENAI_API_KEY || "",
    elevenlabsApiKey: process.env.ELEVENLABS_API_KEY || "",
    deepgramApiKey: process.env.DEEPGRAM_API_KEY || "",
    telnyxApiKey: process.env.TELNYX_API_KEY || "",
    tenantLlmApiKey: tenantKey,
    tenantLlmProvider: typeof portal.tenantProvider === "string" ? portal.tenantProvider : undefined,
    tenantLlmModel: typeof portal.tenantModel === "string" ? portal.tenantModel : undefined,
  };
}

function redactError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw.replace(/(sk-|rk-|key-|token=|vl_)[A-Za-z0-9._-]+/gi, "$1[redacted]").slice(0, 400);
}

export async function executeProvisionPipeline(input: ExecuteProvisionInput): Promise<{
  controlUrl: string;
  runtimeUrl: string;
  handles: Record<string, unknown>;
  webhookUrl: string;
  telnyx: TelnyxConfigureResult;
}> {
  const created = await input.adapter.provision({
    tenantId: input.tenantId,
    size: input.size,
    region: input.region,
    imageRegistry: input.imageRegistry,
    imageVersion: input.imageVersion,
    onStep: input.onStep,
  });
  const missing = missingCreateSteps(input.recordedSteps);
  if (missing.length) throw new Error(`missing_step:${missing.join(",")}`);

  const resolved = await input.adapter.resolveConnection(created.handles);
  const secrets = generateCloudStackSecrets();
  if (input.storeAdminKey) await input.storeAdminKey(input.deploymentId, secrets.adminApiKey);

  let env = buildCloudStackEnv({
    tenantId: input.tenantId,
    urls: resolved,
    secrets,
    vendor: input.vendorKeys,
  });
  await input.adapter.injectEnv(resolved.handles, env);
  await input.onStep("inject_env");

  await input.adapter.waitHealthy({
    controlUrl: resolved.controlUrl,
    runtimeUrl: resolved.runtimeUrl,
    timeoutMs: input.waitHealthyTimeoutMs,
  });
  await input.onStep("wait_healthy");

  const configure = input.configureTelnyx || configureTenantTelnyx;
  const telnyx = await configure({ tenantId: input.tenantId, runtimeUrl: resolved.runtimeUrl });
  env = buildCloudStackEnv({
    tenantId: input.tenantId,
    urls: resolved,
    secrets,
    vendor: input.vendorKeys,
    telnyxConnectionId: telnyx.connectionId,
  });
  await input.adapter.injectEnv(resolved.handles, env);
  await input.onStep("configure_telnyx");

  const handles = {
    ...resolved.handles,
    webhookUrl: telnyx.webhookUrl,
    telnyxConnectionId: telnyx.connectionId,
    assignedDid: telnyx.assignedDid,
    needsNumber: telnyx.needsNumber,
    adminKeyStored: true,
  };
  await input.onStep("ready");
  return {
    controlUrl: resolved.controlUrl,
    runtimeUrl: resolved.runtimeUrl,
    handles,
    webhookUrl: telnyx.webhookUrl,
    telnyx,
  };
}

export async function startProvision(input: {
  tenantId: string;
  hostSku: string;
  region?: string;
}): Promise<{ deploymentId: string; jobId: string }> {
  const comp = componentBySku(input.hostSku);
  if (!comp || comp.slot !== "host") throw new Error("invalid_host_sku");
  if (!isPaidCloudHost(comp) || !comp.hostProvider || !comp.hostSize) {
    throw new Error("onprem_host_not_provisionable");
  }
  if (comp.hostSize === "free") throw new Error("free_tier_forbidden");
  const existing = await getActiveDeployment(input.tenantId);
  if (existing) throw new Error("deployment_already_active");

  const adapter = getHostAdapter(comp.hostProvider);
  const creds = await adapter.validateCredentials();
  if (!creds.ok) throw new Error(creds.message || "host_credentials_missing");

  const deployment = await insertDeployment({
    tenantId: input.tenantId,
    host: comp.hostProvider,
    region: input.region,
    size: comp.hostSize,
  });
  const job = await insertProvisionJob(input.tenantId, deployment.id);
  void runProvisionJob(job.id, deployment.id, adapter.name, comp.hostSize, input.region, input.tenantId);
  return { deploymentId: deployment.id, jobId: job.id };
}

async function runProvisionJob(
  jobId: string,
  deploymentId: string,
  host: string,
  size: string,
  region: string | undefined,
  tenantId: string,
): Promise<void> {
  const adapter = getHostAdapter(host);
  const steps: ProvisionStepRecord[] = [];
  const recorded: string[] = [];
  try {
    await updateProvisionJob(jobId, { status: "running", step: "create_db" });
    await updateDeployment(deploymentId, { status: "provisioning" });
    const onStep = async (step: string) => {
      recorded.push(step);
      steps.push({ step, ok: true, at: new Date().toISOString() });
      await updateProvisionJob(jobId, { step, steps, status: step === "ready" ? "ready" : "running" });
    };
    const result = await executeProvisionPipeline({
      adapter,
      tenantId,
      deploymentId,
      size,
      region,
      imageRegistry: process.env.REGISTRY || "ghcr.io/nick-veraluxai",
      imageVersion: process.env.VERSION || "0.1.0",
      vendorKeys: await resolveVendorKeys(tenantId),
      recordedSteps: recorded,
      onStep,
      storeAdminKey: (id, key) => setPlatformSecret(deploymentAdminKeyName(id), key),
    });
    await updateDeployment(deploymentId, {
      status: "ready",
      controlUrl: result.controlUrl,
      runtimeUrl: result.runtimeUrl,
      handles: result.handles,
      lastError: null,
    });
  } catch (e) {
    const msg = redactError(e);
    steps.push({ step: "failed", ok: false, at: new Date().toISOString() });
    await updateProvisionJob(jobId, { status: "failed", step: "failed", steps, errorRedacted: msg });
    await updateDeployment(deploymentId, { status: "failed", lastError: msg });
  }
}

export async function loadDeploymentAdminKey(deploymentId: string): Promise<string | undefined> {
  return getPlatformSecret(deploymentAdminKeyName(deploymentId));
}

export async function teardownDeployment(tenantId: string, deploymentId: string): Promise<void> {
  const dep = await getDeployment(tenantId, deploymentId);
  if (!dep) throw new Error("deployment_not_found");
  try {
    const adapter = getHostAdapter(dep.host);
    await adapter.teardown(dep.handles);
    await setPlatformSecret(deploymentAdminKeyName(deploymentId), null);
  } catch (e) {
    await updateDeployment(dep.id, { lastError: redactError(e) });
    throw e;
  }
  await updateDeployment(dep.id, { status: "canceled", lastError: null });
}

export async function pollDeployment(tenantId: string, deploymentId: string) {
  const dep = await getDeployment(tenantId, deploymentId);
  if (!dep) return null;
  if (dep.status === "ready" || dep.status === "provisioning") {
    try {
      const adapter = getHostAdapter(dep.host);
      const status = await adapter.syncStatus(dep.handles);
      return { ...dep, hostReady: status.ready, hostDetail: status.detail };
    } catch {
      return { ...dep, hostReady: false };
    }
  }
  return dep;
}

export async function hostCredentialProbe() {
  return {
    render: Boolean(await getHostCredential("render_api_key")),
    railway: Boolean(await getHostCredential("railway_token")),
    aws: Boolean(await getHostCredential("aws_access_key_id")),
  };
}
