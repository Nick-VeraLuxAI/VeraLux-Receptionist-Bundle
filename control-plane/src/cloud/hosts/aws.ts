import { randomBytes } from "crypto";
import { assertConnectionString, assertPublicServiceUrl } from "../cloudStackEnv";
import { waitUntilHealthy } from "../waitHealthy";
import { awsInstanceClass, buildAwsStackTemplate, stackNameForTenant } from "./awsTemplate";
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

type StackOutputs = Record<string, string>;

export type CloudFormationParameter = {
  ParameterKey: string;
  ParameterValue?: string;
  UsePreviousValue?: boolean;
};

const INFRA_PARAMETER_KEYS = [
  "TenantId",
  "ControlImage",
  "RuntimeImage",
  "Cpu",
  "Memory",
  "DbClass",
  "DbPassword",
] as const;

export const awsCfn = {
  async createStack(input: {
    stackName: string;
    template: Record<string, unknown>;
    parameters: Record<string, string>;
    region: string;
  }): Promise<void> {
    const cfn = await cloudFormation(input.region);
    const { CreateStackCommand } = await import("@aws-sdk/client-cloudformation");
    await cfn.send(new CreateStackCommand({
      StackName: input.stackName,
      TemplateBody: JSON.stringify(input.template),
      Capabilities: ["CAPABILITY_NAMED_IAM"],
      Parameters: Object.entries(input.parameters).map(([ParameterKey, ParameterValue]) => ({
        ParameterKey,
        ParameterValue,
      })),
      Tags: [{ Key: "veralux-stack", Value: input.stackName }],
    }));
  },
  async updateStack(input: {
    stackName: string;
    parameters: CloudFormationParameter[];
    region: string;
  }): Promise<void> {
    const cfn = await cloudFormation(input.region);
    const { UpdateStackCommand } = await import("@aws-sdk/client-cloudformation");
    try {
      await cfn.send(new UpdateStackCommand({
        StackName: input.stackName,
        UsePreviousTemplate: true,
        Capabilities: ["CAPABILITY_NAMED_IAM"],
        Parameters: input.parameters,
      }));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("No updates are to be performed")) return;
      throw e;
    }
  },
  async describeOutputs(stackName: string, region: string): Promise<StackOutputs> {
    const cfn = await cloudFormation(region);
    const { DescribeStacksCommand } = await import("@aws-sdk/client-cloudformation");
    const out = await cfn.send(new DescribeStacksCommand({ StackName: stackName }));
    const stack = out.Stacks?.[0];
    const status = stack?.StackStatus || "";
    if (status.includes("FAILED") || status.includes("ROLLBACK")) {
      throw new Error(`aws_stack_${status || "failed"}`);
    }
    if (!status.endsWith("COMPLETE")) return {};
    const result: StackOutputs = {};
    for (const o of stack?.Outputs || []) {
      if (o.OutputKey && o.OutputValue) result[o.OutputKey] = o.OutputValue;
    }
    return result;
  },
  async deleteStack(stackName: string, region: string): Promise<void> {
    const cfn = await cloudFormation(region);
    const { DeleteStackCommand } = await import("@aws-sdk/client-cloudformation");
    await cfn.send(new DeleteStackCommand({ StackName: stackName }));
  },
};

async function cloudFormation(region: string) {
  const { CloudFormationClient } = await import("@aws-sdk/client-cloudformation");
  const accessKeyId = await getHostCredential("aws_access_key_id");
  const secretAccessKey = await getHostCredential("aws_secret_access_key");
  if (!accessKeyId || !secretAccessKey) throw new Error("aws_credentials_missing");
  return new CloudFormationClient({
    region,
    credentials: { accessKeyId, secretAccessKey },
  });
}

function stackEnvParameters(env: Record<string, string>): CloudFormationParameter[] {
  const runtimeUrl = (env.VERALUX_WEBHOOK_URL || "").replace(/\/v1\/telnyx\/webhook$/, "");
  const values: Record<string, string> = {
    JwtSecret: env.JWT_SECRET,
    AdminApiKey: env.ADMIN_API_KEY,
    SecretEncryptionKey: env.SECRET_ENCRYPTION_KEY,
    MediaStreamToken: env.MEDIA_STREAM_TOKEN,
    PublicBaseUrl: env.PUBLIC_BASE_URL,
    RuntimePublicUrl: runtimeUrl || env.CONTROL_PLANE_URL || env.PUBLIC_BASE_URL,
    OpenAiKey: env.OPENAI_API_KEY || "none",
    DeepgramKey: env.DEEPGRAM_API_KEY || "none",
    ElevenKey: env.ELEVENLABS_API_KEY || "none",
    TelnyxKey: env.TELNYX_API_KEY || "none",
    TelnyxConnectionId: env.TELNYX_CONNECTION_ID || "none",
  };
  return [
    ...INFRA_PARAMETER_KEYS.map((ParameterKey) => ({ ParameterKey, UsePreviousValue: true })),
    ...Object.entries(values).map(([ParameterKey, ParameterValue]) => ({ ParameterKey, ParameterValue })),
  ];
}

export const awsAdapter: HostAdapter = {
  name: "aws",
  async validateCredentials() {
    const key = await getHostCredential("aws_access_key_id");
    const secret = await getHostCredential("aws_secret_access_key");
    if (!key || !secret) return { ok: false, message: "aws_credentials_missing" };
    return { ok: true };
  },
  quoteMonthlyCents(size, region) {
    return quoteHostMonthlyCents("aws", size, region);
  },
  async provision(spec: HostProvisionSpec): Promise<CreatedStack> {
    if (spec.size === "free") throw new Error("free_tier_forbidden");
    const creds = await this.validateCredentials();
    if (!creds.ok) throw new Error(creds.message || "aws_credentials_missing");
    const region = spec.region || (await getHostCredential("aws_region")) || "us-east-1";
    const stackName = stackNameForTenant(spec.tenantId);
    const sizing = awsInstanceClass(spec.size);
    const dbPassword = randomBytes(16).toString("base64url");
    await awsCfn.createStack({
      stackName,
      template: buildAwsStackTemplate(),
      region,
      parameters: {
        TenantId: spec.tenantId,
        ControlImage: `${spec.imageRegistry}/veralux-control-plane:${spec.imageVersion}`,
        RuntimeImage: `${spec.imageRegistry}/veralux-voice-runtime:${spec.imageVersion}`,
        Cpu: sizing.cpu,
        Memory: sizing.memory,
        DbClass: sizing.db,
        DbPassword: dbPassword,
      },
    });
    await spec.onStep?.("create_db");
    await spec.onStep?.("create_redis");
    await spec.onStep?.("create_control");
    await spec.onStep?.("create_runtime");
    return {
      handles: {
        provider: "aws",
        tenantId: spec.tenantId,
        stackName,
        region,
        size: spec.size,
        registry: spec.imageRegistry,
        version: spec.imageVersion,
        dbPasswordSet: true,
      },
    };
  },
  async resolveConnection(handles): Promise<ResolvedStack> {
    const stackName = String(handles.stackName || "");
    const region = String(handles.region || "us-east-1");
    if (!stackName) throw new Error("aws_stack_missing");
    const outputs = await retryUntil(async () => {
      const out = await awsCfn.describeOutputs(stackName, region);
      if (out.ControlUrl && out.RuntimeUrl && out.DatabaseUrl && out.RedisUrl) return out;
      return null;
    }, { label: "aws_stack_outputs" });
    return {
      controlUrl: assertPublicServiceUrl(outputs.ControlUrl, "control"),
      runtimeUrl: assertPublicServiceUrl(outputs.RuntimeUrl, "runtime"),
      databaseUrl: assertConnectionString(outputs.DatabaseUrl, "database_url"),
      redisUrl: assertConnectionString(outputs.RedisUrl, "redis_url"),
      handles: { ...handles, controlUrl: outputs.ControlUrl, runtimeUrl: outputs.RuntimeUrl },
    };
  },
  async injectEnv(handles, env) {
    const stackName = String(handles.stackName || "");
    const region = String(handles.region || "us-east-1");
    if (!stackName) throw new Error("aws_stack_missing");
    await awsCfn.updateStack({
      stackName,
      region,
      parameters: stackEnvParameters(env),
    });
  },
  async waitHealthy(urls) {
    await waitUntilHealthy(urls);
  },
  async syncStatus(handles): Promise<HostStatus> {
    const stackName = String(handles.stackName || "");
    const region = String(handles.region || "us-east-1");
    if (!stackName) return { ready: false, detail: "missing_stack" };
    try {
      const outputs = await awsCfn.describeOutputs(stackName, region);
      const controlUrl = outputs.ControlUrl;
      const runtimeUrl = outputs.RuntimeUrl;
      if (!controlUrl || !runtimeUrl) return { ready: false, detail: "outputs_pending" };
      if (controlUrl.includes("awsapprunner.com") || runtimeUrl.includes("awsapprunner.com")) {
        return { ready: false, detail: "invented_url_rejected" };
      }
      const controlOk = await fetch(`${controlUrl.replace(/\/$/, "")}/health`).then((r) => r.ok).catch(() => false);
      const runtimeOk = await fetch(`${runtimeUrl.replace(/\/$/, "")}/health/live`).then((r) => r.ok).catch(() => false);
      return { ready: controlOk && runtimeOk, controlUrl, runtimeUrl, detail: controlOk && runtimeOk ? "ok" : "health_pending" };
    } catch (e) {
      return { ready: false, detail: e instanceof Error ? e.message : String(e) };
    }
  },
  async teardown(handles) {
    const stackName = String(handles.stackName || "");
    const region = String(handles.region || "us-east-1");
    if (!stackName) throw new Error("aws_stack_missing");
    await awsCfn.deleteStack(stackName, region);
  },
};
