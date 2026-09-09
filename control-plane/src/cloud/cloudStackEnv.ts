import { randomBytes } from "crypto";

export type CloudStackSecrets = {
  jwtSecret: string;
  adminApiKey: string;
  secretEncryptionKey: string;
  mediaStreamToken: string;
};

export type CloudVendorKeys = {
  openaiApiKey?: string;
  elevenlabsApiKey?: string;
  deepgramApiKey?: string;
  telnyxApiKey?: string;
  tenantLlmApiKey?: string;
  tenantLlmProvider?: string;
  tenantLlmModel?: string;
};

export type CloudStackUrls = {
  controlUrl: string;
  runtimeUrl: string;
  databaseUrl: string;
  redisUrl: string;
};

export const REQUIRED_CREATE_STEPS = [
  "create_db",
  "create_redis",
  "create_control",
  "create_runtime",
] as const;

export const POST_CREATE_STEPS = [
  "inject_env",
  "wait_healthy",
  "configure_telnyx",
  "ready",
] as const;

export const PROVISION_STEPS = [...REQUIRED_CREATE_STEPS, ...POST_CREATE_STEPS] as const;

export function generateCloudStackSecrets(): CloudStackSecrets {
  return {
    jwtSecret: randomBytes(32).toString("hex"),
    adminApiKey: `vl_${randomBytes(24).toString("hex")}`,
    secretEncryptionKey: randomBytes(32).toString("hex"),
    mediaStreamToken: randomBytes(24).toString("hex"),
  };
}

export function webhookUrlForRuntime(runtimeUrl: string): string {
  const base = assertPublicServiceUrl(runtimeUrl, "runtimeUrl").replace(/\/$/, "");
  return `${base}/v1/telnyx/webhook`;
}

export function isInventedHostname(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host.endsWith(".awsapprunner.com") || host === "pending.invalid";
  } catch {
    return true;
  }
}

export function assertPublicServiceUrl(url: string, label: string): string {
  const trimmed = String(url || "").trim();
  if (!trimmed) throw new Error(`${label}_url_missing`);
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`${label}_url_invalid`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`${label}_url_invalid`);
  }
  if (!parsed.hostname || isInventedHostname(trimmed)) {
    throw new Error(`${label}_url_invented`);
  }
  return trimmed.replace(/\/$/, "");
}

export function assertConnectionString(value: string, label: string): string {
  const trimmed = String(value || "").trim();
  if (!trimmed) throw new Error(`${label}_missing`);
  if (!/^(postgres(ql)?|redis):\/\//i.test(trimmed)) throw new Error(`${label}_invalid`);
  return trimmed;
}

export function missingCreateSteps(recorded: string[]): string[] {
  return REQUIRED_CREATE_STEPS.filter((step) => !recorded.includes(step));
}

export function buildCloudStackEnv(input: {
  tenantId: string;
  urls: CloudStackUrls;
  secrets: CloudStackSecrets;
  vendor: CloudVendorKeys;
  telnyxConnectionId?: string | null;
}): Record<string, string> {
  const controlUrl = assertPublicServiceUrl(input.urls.controlUrl, "control");
  const runtimeUrl = assertPublicServiceUrl(input.urls.runtimeUrl, "runtime");
  const databaseUrl = assertConnectionString(input.urls.databaseUrl, "database_url");
  const redisUrl = assertConnectionString(input.urls.redisUrl, "redis_url");
  const openai = input.vendor.tenantLlmApiKey || input.vendor.openaiApiKey || "";
  const env: Record<string, string> = {
    DEPLOYMENT_PROFILE: "cloud-api",
    NODE_ENV: "production",
    HEALTH_VOICE_DEPENDENCIES: "configured",
    CLOUD_BIND_EXACT_PORT: "1",
    ADMIN_AUTH_MODE: "hybrid",
    ALLOW_ADMIN_API_KEY_IN_PROD: "true",
    DATABASE_URL: databaseUrl,
    REDIS_URL: redisUrl,
    PUBLIC_BASE_URL: controlUrl,
    AUDIO_PUBLIC_BASE_URL: `${controlUrl}/audio`,
    CONTROL_URL: controlUrl,
    BASE_URL: controlUrl,
    CONTROL_PLANE_URL: controlUrl,
    CONTROL_PLANE_API_KEY: input.secrets.adminApiKey,
    ADMIN_API_KEY: input.secrets.adminApiKey,
    JWT_SECRET: input.secrets.jwtSecret,
    SECRET_ENCRYPTION_KEY: input.secrets.secretEncryptionKey,
    MEDIA_STREAM_TOKEN: input.secrets.mediaStreamToken,
    VERALUX_WEBHOOK_URL: webhookUrlForRuntime(runtimeUrl),
    TENANT_ID: input.tenantId,
  };
  if (openai) env.OPENAI_API_KEY = openai;
  if (input.vendor.elevenlabsApiKey) env.ELEVENLABS_API_KEY = input.vendor.elevenlabsApiKey;
  if (input.vendor.deepgramApiKey) env.DEEPGRAM_API_KEY = input.vendor.deepgramApiKey;
  if (input.vendor.telnyxApiKey) env.TELNYX_API_KEY = input.vendor.telnyxApiKey;
  if (input.vendor.tenantLlmProvider) env.TENANT_LLM_PROVIDER = input.vendor.tenantLlmProvider;
  if (input.vendor.tenantLlmModel) env.OPENAI_MODEL = input.vendor.tenantLlmModel;
  if (input.telnyxConnectionId) env.TELNYX_CONNECTION_ID = input.telnyxConnectionId;
  return env;
}
