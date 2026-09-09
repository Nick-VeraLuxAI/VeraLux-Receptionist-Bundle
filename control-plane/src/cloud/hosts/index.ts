import { awsAdapter } from "./aws";
import { railwayAdapter } from "./railway";
import { renderAdapter } from "./render";
import type { HostAdapter, HostName } from "./types";

export { quoteHostMonthlyCents } from "./quotes";
export type { HostAdapter, HostName, HostProvisionSpec, HostProvisionResult } from "./types";

const ADAPTERS: Record<HostName, HostAdapter> = {
  render: renderAdapter,
  railway: railwayAdapter,
  aws: awsAdapter,
};

export function getHostAdapter(name: string): HostAdapter {
  const adapter = ADAPTERS[name as HostName];
  if (!adapter) throw new Error("unsupported_host");
  return adapter;
}
