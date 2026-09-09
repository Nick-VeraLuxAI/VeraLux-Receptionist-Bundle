import { jobberAdapter } from "./jobber";
import { housecallProAdapter } from "./housecallPro";
import type { FsmAdapter, FsmJobInput, FsmJobResult, FsmProvider } from "./types";
import { getFsmConnections, lookupLocalCaller } from "../nightDesk/db";

export function fsmAdapter(provider: FsmProvider): FsmAdapter {
  if (provider === "housecall_pro") return housecallProAdapter;
  return jobberAdapter;
}

export async function preferredFsm(tenantId: string): Promise<FsmProvider> {
  const rows = await getFsmConnections(tenantId);
  if (rows.some((r) => r.provider === "jobber" && r.status === "connected")) {
    return "jobber";
  }
  if (
    rows.some(
      (r) => r.provider === "housecall_pro" && r.status === "connected",
    )
  ) {
    return "housecall_pro";
  }
  return "jobber";
}

export async function writeBoardJob(tenantId: string, input: FsmJobInput): Promise<FsmJobResult> {
  const provider = await preferredFsm(tenantId);
  return fsmAdapter(provider).createCustomerAndJob(tenantId, input);
}

export async function lookupCustomerByPhone(tenantId: string, phone: string) {
  const preferred = await preferredFsm(tenantId);
  const first = await fsmAdapter(preferred).lookupByPhone(tenantId, phone);
  if (first?.name || first?.openJobs.length || first?.membership) return first;
  const secondProvider =
    preferred === "jobber" ? "housecall_pro" : "jobber";
  const second = await fsmAdapter(secondProvider).lookupByPhone(tenantId, phone);
  if (second?.name || second?.openJobs.length || second?.membership) return second;
  return lookupLocalCaller(tenantId, phone);
}
