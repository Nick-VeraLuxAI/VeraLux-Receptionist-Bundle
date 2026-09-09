export type HostName = "render" | "railway" | "aws";

export type HostProvisionSpec = {
  tenantId: string;
  size: string;
  region?: string;
  imageRegistry: string;
  imageVersion: string;
  onStep?: (step: string) => Promise<void>;
};

export type CreatedStack = {
  handles: Record<string, unknown>;
  databaseId?: string;
  redisId?: string;
};

export type ResolvedStack = {
  controlUrl: string;
  runtimeUrl: string;
  databaseUrl: string;
  redisUrl: string;
  handles: Record<string, unknown>;
};

export type HostProvisionResult = CreatedStack & {
  controlUrl?: string;
  runtimeUrl?: string;
};

export type HostStatus = {
  ready: boolean;
  controlUrl?: string;
  runtimeUrl?: string;
  detail?: string;
};

export interface HostAdapter {
  name: HostName;
  validateCredentials(): Promise<{ ok: boolean; message?: string }>;
  quoteMonthlyCents(size: string, region?: string): number;
  /** Create host resources only. Must call onStep after each create_* succeeds. Must not invent public URLs. */
  provision(spec: HostProvisionSpec): Promise<CreatedStack>;
  resolveConnection(handles: Record<string, unknown>): Promise<ResolvedStack>;
  injectEnv(handles: Record<string, unknown>, env: Record<string, string>): Promise<void>;
  waitHealthy(urls: { controlUrl: string; runtimeUrl: string; timeoutMs?: number }): Promise<void>;
  syncStatus(handles: Record<string, unknown>): Promise<HostStatus>;
  teardown(handles: Record<string, unknown>): Promise<void>;
}
