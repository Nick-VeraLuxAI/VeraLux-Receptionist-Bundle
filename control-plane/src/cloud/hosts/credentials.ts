import { getPlatformSecret, setPlatformSecret } from "../../secretStore";

export type HostCredentialKey = "render_api_key" | "railway_token" | "aws_access_key_id" | "aws_secret_access_key" | "aws_region";

const ENV_ALIAS: Record<HostCredentialKey, string> = {
  render_api_key: "RENDER_API_KEY",
  railway_token: "RAILWAY_TOKEN",
  aws_access_key_id: "AWS_ACCESS_KEY_ID",
  aws_secret_access_key: "AWS_SECRET_ACCESS_KEY",
  aws_region: "AWS_REGION",
};

export async function getHostCredential(key: HostCredentialKey): Promise<string | undefined> {
  const stored = await getPlatformSecret(key);
  if (stored?.trim()) return stored.trim();
  const envVal = process.env[ENV_ALIAS[key]]?.trim();
  return envVal || undefined;
}

export async function setHostCredential(key: HostCredentialKey, value: string | null): Promise<void> {
  await setPlatformSecret(key, value);
}

export async function hostCredentialStatus(): Promise<Record<string, boolean>> {
  const [render, railway, awsKey, awsSecret] = await Promise.all([
    getHostCredential("render_api_key"),
    getHostCredential("railway_token"),
    getHostCredential("aws_access_key_id"),
    getHostCredential("aws_secret_access_key"),
  ]);
  return {
    renderConfigured: Boolean(render),
    railwayConfigured: Boolean(railway),
    awsConfigured: Boolean(awsKey && awsSecret),
  };
}
