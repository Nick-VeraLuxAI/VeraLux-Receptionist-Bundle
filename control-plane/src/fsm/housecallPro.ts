import { secretStore } from "../secretStore";
import {
  finishFsmJobWrite,
  getFsmJobWrite,
  reserveFsmJobWrite,
  upsertFsmConnection,
} from "../nightDesk/db";
import type {
  FsmAdapter,
  FsmClientMatch,
  FsmCustomer,
  FsmJobInput,
  FsmJobResult,
} from "./types";

export const HCP_SECRET_KEY = "fsm_housecall_pro_token";

async function token(tenantId: string): Promise<string | undefined> {
  return secretStore.getSecret(tenantId, HCP_SECRET_KEY);
}

async function hcpRequest<T>(
  tenantId: string,
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const key = await token(tenantId);
  if (!key) throw new Error("housecall_pro_not_connected");
  const response = await fetch(`https://api.housecallpro.com${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${key}`,
      Accept: "application/json",
      "Content-Type": "application/json",
      ...options.headers,
    },
    signal: AbortSignal.timeout(15_000),
  });
  const body = (await response.json().catch(() => ({}))) as T & {
    message?: string;
    error?: string;
  };
  if (!response.ok) {
    throw new Error(
      body.message || body.error || `housecall_pro_http_${response.status}`,
    );
  }
  return body;
}

function splitName(name?: string): { first_name: string; last_name: string } {
  const parts = String(name || "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) {
    return { first_name: "Night Desk", last_name: "Caller" };
  }
  if (parts.length === 1) {
    return { first_name: parts[0], last_name: "Caller" };
  }
  return {
    first_name: parts.slice(0, -1).join(" "),
    last_name: parts[parts.length - 1],
  };
}

function addressPayload(address?: string): Record<string, string> | undefined {
  const raw = String(address || "").trim();
  if (!raw) return undefined;
  const parts = raw.split(",").map((part) => part.trim()).filter(Boolean);
  const stateZip = /\b([A-Z]{2})\s+(\d{5}(?:-\d{4})?)\b/i.exec(
    parts[parts.length - 1] || raw,
  );
  return {
    street: parts[0] || raw,
    ...(parts.length >= 3 ? { city: parts[1] } : {}),
    ...(stateZip ? { state: stateZip[1].toUpperCase() } : {}),
    ...(stateZip ? { zip: stateZip[2] } : {}),
    country: "US",
    type: "service",
  };
}

const adapter: FsmAdapter = {
  provider: "housecall_pro",

  async createCustomer(tenantId, customer: FsmCustomer) {
    try {
      if (customer.phone) {
        const match = await adapter.lookupByPhone(tenantId, customer.phone);
        if (match?.customerId) {
          return {
            ok: true,
            customerId: match.customerId,
            propertyId: match.propertyId,
          };
        }
      }
      const body = await hcpRequest<{
        id?: string;
        addresses?: Array<{ id?: string }>;
      }>(tenantId, "/customers", {
        method: "POST",
        body: JSON.stringify({
          ...splitName(customer.name),
          email: customer.email,
          mobile_number: customer.phone,
          lead_source: "VeraLux AI booked",
          tags: ["AI booked"],
          ...(addressPayload(customer.address)
            ? { addresses: [addressPayload(customer.address)] }
            : {}),
        }),
      });
      if (!body.id) return { ok: false, error: "hcp_customer_create_failed" };
      return {
        ok: true,
        customerId: body.id,
        propertyId: body.addresses?.[0]?.id,
      };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  },

  async createJob(
    tenantId,
    input: FsmJobInput & { customerId: string; propertyId?: string },
  ): Promise<FsmJobResult> {
    try {
      const start = input.startIso ? new Date(input.startIso) : null;
      const end =
        start && Number.isFinite(start.getTime())
          ? new Date(start.getTime() + 2 * 60 * 60_000)
          : null;
      const body = await hcpRequest<{ id?: string }>(tenantId, "/jobs", {
        method: "POST",
        body: JSON.stringify({
          customer_id: input.customerId,
          address_id: input.propertyId,
          description: input.jobType || "AI booked service call",
          notes: [
            {
              content: [
                "AI booked",
                `VeraLux call: ${input.callId}`,
                input.notes,
                input.membership
                  ? `Membership: ${input.membership}`
                  : undefined,
                input.warranty ? `Warranty: ${input.warranty}` : undefined,
              ]
                .filter(Boolean)
                .join("\n"),
            },
          ],
          tags: ["AI booked"],
          ...(start && end
            ? {
                schedule: {
                  scheduled_start: start.toISOString(),
                  scheduled_end: end.toISOString(),
                  arrival_window: 120,
                },
              }
            : {}),
        }),
      });
      if (!body.id) {
        return {
          provider: "housecall_pro",
          ok: false,
          customerId: input.customerId,
          propertyId: input.propertyId,
          error: "hcp_job_create_failed",
        };
      }
      return {
        provider: "housecall_pro",
        ok: true,
        jobId: body.id,
        customerId: input.customerId,
        propertyId: input.propertyId,
        taggedAiBooked: true,
      };
    } catch (error) {
      return {
        provider: "housecall_pro",
        ok: false,
        customerId: input.customerId,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  },

  async tagAiBooked() {
    // The create customer/job payloads apply the tag atomically.
    return true;
  },

  async createCustomerAndJob(
    tenantId,
    input: FsmJobInput,
  ): Promise<FsmJobResult> {
    const key = await token(tenantId);
    if (!key) {
      await upsertFsmConnection(tenantId, "housecall_pro", "dry_run");
      return {
        provider: "housecall_pro",
        ok: true,
        dryRun: true,
        jobId: `dry-hcp-${input.callId}`,
        taggedAiBooked: true,
      };
    }
    const idempotencyKey = input.idempotencyKey || input.callId;
    const prior = await getFsmJobWrite(
      tenantId,
      "housecall_pro",
      idempotencyKey,
    );
    if (prior?.status === "completed" && prior.job_id) {
      return {
        provider: "housecall_pro",
        ok: true,
        jobId: prior.job_id,
        customerId: prior.customer_id,
        propertyId: prior.property_id,
        taggedAiBooked: true,
      };
    }
    if (prior?.status === "pending") {
      return {
        provider: "housecall_pro",
        ok: false,
        error: "hcp_write_in_progress",
      };
    }
    if (!prior) {
      await reserveFsmJobWrite({
        tenantId,
        provider: "housecall_pro",
        idempotencyKey,
        callId: input.callId,
      });
    }
    const customer = await adapter.createCustomer(tenantId, input.customer);
    const result =
      customer.ok && customer.customerId
        ? await adapter.createJob(tenantId, {
            ...input,
            customerId: customer.customerId,
            propertyId: customer.propertyId,
          })
        : {
            provider: "housecall_pro" as const,
            ok: false,
            error: customer.error || "hcp_customer_create_failed",
          };
    await finishFsmJobWrite({
      tenantId,
      provider: "housecall_pro",
      idempotencyKey,
      status: result.ok ? "completed" : "failed",
      customerId: result.customerId,
      propertyId: result.propertyId,
      jobId: result.jobId,
      error: result.error,
      response: result,
    });
    await upsertFsmConnection(
      tenantId,
      "housecall_pro",
      result.ok ? "connected" : "error",
      result.error,
    );
    return result;
  },

  async lookupByPhone(tenantId, phone: string): Promise<FsmClientMatch | null> {
    const key = await token(tenantId);
    if (!key) return null;
    try {
      const body = await hcpRequest<{
        customers?: Array<{
          id?: string;
          first_name?: string;
          last_name?: string;
          tags?: string[];
          addresses?: Array<{ id?: string }>;
        }>;
      }>(
        tenantId,
        `/customers?search=${encodeURIComponent(phone)}`,
      );
      const c = body.customers?.[0];
      if (!c) return null;
      const jobs = c.id
        ? await hcpRequest<{
            jobs?: Array<{
              id: string;
              description?: string;
              work_status?: string;
            }>;
          }>(
            tenantId,
            `/jobs?customer_id=${encodeURIComponent(c.id)}&page_size=10`,
          ).catch(() => ({ jobs: [] }))
        : { jobs: [] };
      return {
        customerId: c.id,
        propertyId: c.addresses?.[0]?.id,
        name: [c.first_name, c.last_name].filter(Boolean).join(" "),
        phone,
        openJobs: (jobs.jobs || [])
          .filter((job) => !/complete|cancel/i.test(job.work_status || ""))
          .map((job) => ({
            id: job.id,
            title: job.description,
            status: job.work_status,
          })),
        membership: c.tags?.find((tag) => /member|club|plan/i.test(tag)),
        warranty: c.tags?.find((tag) => /warranty/i.test(tag)),
      };
    } catch {
      return null;
    }
  },
};

export const housecallProAdapter = adapter;
