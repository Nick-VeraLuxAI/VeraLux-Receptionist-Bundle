import {
  finishFsmJobWrite,
  getFsmJobWrite,
  reserveFsmJobWrite,
  upsertFsmConnection,
} from "../nightDesk/db";
import {
  getJobberAccessToken,
  JOBBER_LEGACY_TOKEN_SECRET_KEY,
  JOBBER_TOKEN_SECRET_KEY,
} from "./jobberOAuth";
import type {
  FsmAdapter,
  FsmClientMatch,
  FsmCustomer,
  FsmJobInput,
  FsmJobResult,
} from "./types";
import { secretStore } from "../secretStore";

/** Kept for status probes and backward-compatible manually supplied tokens. */
export const JOBBER_SECRET_KEY = JOBBER_LEGACY_TOKEN_SECRET_KEY;
export const JOBBER_OAUTH_SECRET_KEY = JOBBER_TOKEN_SECRET_KEY;
export const JOBBER_MEMBERSHIP_FIELD_KEY =
  "fsm_jobber_membership_custom_field_id";
export const JOBBER_WARRANTY_FIELD_KEY =
  "fsm_jobber_warranty_custom_field_id";

type GraphqlEnvelope<T> = {
  data?: T;
  errors?: Array<{ message?: string }>;
};

type MutationPayload<T> = {
  userErrors?: Array<{ message?: string; path?: string[] }>;
} & T;

const API_VERSION =
  process.env.JOBBER_GRAPHQL_VERSION || "2025-04-16";

function firstError(
  envelope: GraphqlEnvelope<unknown>,
  payload?: MutationPayload<unknown>,
): string | undefined {
  return (
    envelope.errors?.map((error) => error.message).filter(Boolean).join("; ") ||
    payload?.userErrors
      ?.map((error) => error.message)
      .filter(Boolean)
      .join("; ") ||
    undefined
  );
}

async function jobberGraphql<T>(
  tenantId: string,
  query: string,
  variables: Record<string, unknown>,
): Promise<GraphqlEnvelope<T>> {
  const token = await getJobberAccessToken(tenantId);
  if (!token) throw new Error("jobber_not_connected");
  const response = await fetch("https://api.getjobber.com/api/graphql", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "X-JOBBER-GRAPHQL-VERSION": API_VERSION,
    },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(15_000),
  });
  const json = (await response.json().catch(() => ({}))) as GraphqlEnvelope<T>;
  if (!response.ok) throw new Error(`jobber_http_${response.status}`);
  if (json.errors?.length) {
    throw new Error(firstError(json) || "jobber_graphql_error");
  }
  return json;
}

function splitName(name?: string): { firstName?: string; lastName: string } {
  const parts = String(name || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (parts.length === 0) return { lastName: "Night Desk Caller" };
  if (parts.length === 1) return { lastName: parts[0] };
  return {
    firstName: parts.slice(0, -1).join(" "),
    lastName: parts[parts.length - 1],
  };
}

function parseAddress(address?: string): Record<string, string> | undefined {
  const text = String(address || "").trim();
  if (!text) return undefined;
  const parts = text.split(",").map((part) => part.trim()).filter(Boolean);
  const stateZip = /\b([A-Z]{2})\s+(\d{5}(?:-\d{4})?)\b/i.exec(
    parts[parts.length - 1] || text,
  );
  return {
    street1: parts[0] || text,
    ...(parts.length >= 3 ? { city: parts[1] } : {}),
    ...(stateZip ? { province: stateZip[1].toUpperCase() } : {}),
    ...(stateZip ? { postalCode: stateZip[2] } : {}),
    country: "US",
  };
}

async function createProperty(
  tenantId: string,
  clientId: string,
  address?: string,
): Promise<string | undefined> {
  const parsed = parseAddress(address);
  if (parsed) {
    const envelope = await jobberGraphql<{
      propertyCreate?: MutationPayload<{
        properties?: Array<{ id: string }>;
      }>;
    }>(
      tenantId,
      `mutation CreateProperty($clientId: EncodedId!, $input: PropertyCreateInput!) {
        propertyCreate(clientId: $clientId, input: $input) {
          properties { id }
          userErrors { message path }
        }
      }`,
      {
        clientId,
        input: { properties: [{ address: parsed }] },
      },
    );
    const payload = envelope.data?.propertyCreate;
    const error = firstError(envelope, payload);
    if (error) throw new Error(error);
    const propertyId = payload?.properties?.[0]?.id;
    if (propertyId) return propertyId;
  }
  const existing = await jobberGraphql<{
    client?: {
      clientProperties?: { nodes?: Array<{ id: string }> };
    };
  }>(
    tenantId,
    `query FirstProperty($id: EncodedId!) {
      client(id: $id) {
        clientProperties(first: 1) { nodes { id } }
      }
    }`,
    { id: clientId },
  );
  return existing.data?.client?.clientProperties?.nodes?.[0]?.id;
}

async function findJobberClient(
  tenantId: string,
  phone: string,
): Promise<{
  id: string;
  name?: string;
  propertyId?: string;
  openJobs: Array<{ id: string; title?: string; status?: string }>;
  tags: string[];
} | null> {
  const envelope = await jobberGraphql<{
    clients?: {
      nodes?: Array<{
        id: string;
        name?: string;
        clientProperties?: { nodes?: Array<{ id: string }> };
        jobs?: {
          nodes?: Array<{
            id: string;
            title?: string;
            jobStatus?: string;
          }>;
        };
      }>;
    };
  }>(
    tenantId,
    `query ClientByPhone($q: String!) {
      clients(searchTerm: $q, first: 5) {
        nodes {
          id
          name
          phones { number }
          clientProperties(first: 1) { nodes { id } }
          jobs(first: 10) { nodes { id title jobStatus } }
        }
      }
    }`,
    { q: phone },
  );
  const node = envelope.data?.clients?.nodes?.[0];
  if (!node) return null;
  let tags: string[] = [];
  try {
    const tagResult = await jobberGraphql<{
      client?: { tags?: { nodes?: Array<{ label?: string }> } };
    }>(
      tenantId,
      `query ClientTags($id: EncodedId!) {
        client(id: $id) { tags(first: 25) { nodes { label } } }
      }`,
      { id: node.id },
    );
    tags = (tagResult.data?.client?.tags?.nodes || [])
      .map((tag) => tag.label || "")
      .filter(Boolean);
  } catch {
    // Tag-read scope is optional; CID/open-job lookup must still work.
  }
  return {
    id: node.id,
    name: node.name,
    propertyId: node.clientProperties?.nodes?.[0]?.id,
    openJobs: (node.jobs?.nodes || [])
      .filter((job) => !/closed|complete|cancel/i.test(job.jobStatus || ""))
      .map((job) => ({
        id: job.id,
        title: job.title,
        status: job.jobStatus,
      })),
    tags,
  };
}

async function findExistingJobByCall(
  tenantId: string,
  callId: string,
): Promise<{ jobId: string; customerId?: string; propertyId?: string } | null> {
  try {
    const result = await jobberGraphql<{
      jobs?: {
        nodes?: Array<{
          id: string;
          instructions?: string;
          client?: { id?: string };
          property?: { id?: string };
        }>;
      };
    }>(
      tenantId,
      `query ExistingAiJob($q: String!) {
        jobs(searchTerm: $q, first: 10) {
          nodes {
            id
            instructions
            client { id }
            property { id }
          }
        }
      }`,
      { q: callId },
    );
    const job = result.data?.jobs?.nodes?.find((candidate) =>
      String(candidate.instructions || "").includes(callId),
    );
    return job
      ? {
          jobId: job.id,
          customerId: job.client?.id,
          propertyId: job.property?.id,
        }
      : null;
  } catch {
    return null;
  }
}

const adapter: FsmAdapter = {
  provider: "jobber",

  async createCustomer(tenantId, customer: FsmCustomer) {
    try {
      if (customer.phone) {
        const existing = await findJobberClient(tenantId, customer.phone);
        if (existing) {
          return {
            ok: true,
            customerId: existing.id,
            propertyId:
              customer.address
                ? await createProperty(
                    tenantId,
                    existing.id,
                    customer.address,
                  )
                : existing.propertyId,
          };
        }
      }
      const name = splitName(customer.name);
      const input: Record<string, unknown> = {
        ...name,
        ...(customer.phone
          ? {
              phones: [
                {
                  description: "MAIN",
                  primary: true,
                  number: customer.phone,
                },
              ],
            }
          : {}),
        ...(customer.email
          ? {
              emails: [
                {
                  description: "MAIN",
                  primary: true,
                  address: customer.email,
                },
              ],
            }
          : {}),
        ...(parseAddress(customer.address)
          ? { billingAddress: parseAddress(customer.address) }
          : {}),
      };
      const envelope = await jobberGraphql<{
        clientCreate?: MutationPayload<{
          client?: { id: string };
        }>;
      }>(
        tenantId,
        `mutation CreateClient($input: ClientCreateInput!) {
          clientCreate(input: $input) {
            client { id }
            userErrors { message path }
          }
        }`,
        { input },
      );
      const payload = envelope.data?.clientCreate;
      const error = firstError(envelope, payload);
      const customerId = payload?.client?.id;
      if (error || !customerId) {
        return { ok: false, error: error || "jobber_client_create_failed" };
      }
      const propertyId = await createProperty(
        tenantId,
        customerId,
        customer.address,
      );
      return { ok: true, customerId, propertyId };
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
      const propertyId =
        input.propertyId ||
        (await createProperty(
          tenantId,
          input.customerId,
          input.customer.address,
        ));
      if (!propertyId) {
        return {
          provider: "jobber",
          ok: false,
          customerId: input.customerId,
          error: "jobber_property_required",
        };
      }
      const marker = [
        "AI booked",
        `VeraLux call: ${input.callId}`,
        input.membership ? `Membership: ${input.membership}` : "",
        input.warranty ? `Warranty: ${input.warranty}` : "",
        input.notes || "",
      ]
        .filter(Boolean)
        .join("\n");
      const create = async (includeTags: boolean) => {
        const [membershipFieldId, warrantyFieldId] = await Promise.all([
          secretStore.getSecret(tenantId, JOBBER_MEMBERSHIP_FIELD_KEY),
          secretStore.getSecret(tenantId, JOBBER_WARRANTY_FIELD_KEY),
        ]);
        const customFields = [
          input.membership && membershipFieldId
            ? { id: membershipFieldId, valueText: input.membership }
            : null,
          input.warranty && warrantyFieldId
            ? { id: warrantyFieldId, valueText: input.warranty }
            : null,
        ].filter(Boolean);
        const jobInput: Record<string, unknown> = {
          propertyId,
          title: `AI booked · ${input.jobType || "Service call"}`,
          instructions: marker,
          scheduling: { createVisits: false, notifyTeam: false },
          ...(includeTags ? { tags: ["AI booked"] } : {}),
          ...(customFields.length ? { customFields } : {}),
        };
        return jobberGraphql<{
          jobCreate?: MutationPayload<{
            job?: { id: string };
          }>;
        }>(
          tenantId,
          `mutation CreateJob($input: JobCreateAttributes!) {
            jobCreate(input: $input) {
              job { id }
              userErrors { message path }
            }
          }`,
          { input: jobInput },
        );
      };
      let taggedAiBooked = true;
      let envelope: GraphqlEnvelope<{
        jobCreate?: MutationPayload<{ job?: { id: string } }>;
      }>;
      try {
        envelope = await create(true);
      } catch (error) {
        // Some Jobber schemas/accounts do not expose job tags. The title and
        // instructions remain an explicit AI-booked marker, but we report the
        // tag as absent instead of pretending it succeeded.
        taggedAiBooked = false;
        envelope = await create(false);
      }
      const payload = envelope.data?.jobCreate;
      const error = firstError(envelope, payload);
      const jobId = payload?.job?.id;
      if (error || !jobId) {
        return {
          provider: "jobber",
          ok: false,
          customerId: input.customerId,
          propertyId,
          error: error || "jobber_job_create_failed",
        };
      }
      if (!taggedAiBooked) {
        taggedAiBooked = await adapter.tagAiBooked(tenantId, {
          customerId: input.customerId,
          jobId,
        });
      }
      return {
        provider: "jobber",
        ok: true,
        customerId: input.customerId,
        propertyId,
        jobId,
        taggedAiBooked,
      };
    } catch (error) {
      return {
        provider: "jobber",
        ok: false,
        customerId: input.customerId,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  },

  async tagAiBooked(tenantId, input) {
    try {
      const envelope = await jobberGraphql<{
        jobEdit?: MutationPayload<{ job?: { id: string } }>;
      }>(
        tenantId,
        `mutation TagAiBooked($jobId: EncodedId!, $input: JobEditInput!) {
          jobEdit(jobId: $jobId, input: $input) {
            job { id }
            userErrors { message path }
          }
        }`,
        { jobId: input.jobId, input: { tags: ["AI booked"] } },
      );
      const payload = envelope.data?.jobEdit;
      return Boolean(payload?.job?.id) && !firstError(envelope, payload);
    } catch {
      return false;
    }
  },

  async createCustomerAndJob(
    tenantId,
    input: FsmJobInput,
  ): Promise<FsmJobResult> {
    const token = await getJobberAccessToken(tenantId);
    if (!token) {
      await upsertFsmConnection(tenantId, "jobber", "dry_run");
      return {
        provider: "jobber",
        ok: true,
        dryRun: true,
        jobId: `dry-jobber-${input.callId}`,
        customerId: input.customer.phone || input.callId,
        taggedAiBooked: true,
      };
    }
    const idempotencyKey = input.idempotencyKey || input.callId;
    const prior = await getFsmJobWrite(
      tenantId,
      "jobber",
      idempotencyKey,
    );
    if (prior?.status === "completed" && prior.job_id) {
      return {
        provider: "jobber",
        ok: true,
        jobId: prior.job_id,
        customerId: prior.customer_id,
        propertyId: prior.property_id,
        taggedAiBooked: true,
      };
    }
    const externallyExisting = await findExistingJobByCall(
      tenantId,
      input.callId,
    );
    if (externallyExisting) {
      if (!prior) {
        await reserveFsmJobWrite({
          tenantId,
          provider: "jobber",
          idempotencyKey,
          callId: input.callId,
        });
      }
      await finishFsmJobWrite({
        tenantId,
        provider: "jobber",
        idempotencyKey,
        status: "completed",
        customerId: externallyExisting.customerId,
        propertyId: externallyExisting.propertyId,
        jobId: externallyExisting.jobId,
        response: { reconciled: true },
      });
      return {
        provider: "jobber",
        ok: true,
        ...externallyExisting,
        taggedAiBooked: true,
      };
    }
    if (prior?.status === "pending") {
      return {
        provider: "jobber",
        ok: false,
        error: "jobber_write_in_progress",
      };
    }
    if (!prior) {
      await reserveFsmJobWrite({
        tenantId,
        provider: "jobber",
        idempotencyKey,
        callId: input.callId,
      });
    }
    const customer = await adapter.createCustomer(tenantId, input.customer);
    if (!customer.ok || !customer.customerId) {
      await finishFsmJobWrite({
        tenantId,
        provider: "jobber",
        idempotencyKey,
        status: "failed",
        error: customer.error || "jobber_customer_create_failed",
      });
      await upsertFsmConnection(
        tenantId,
        "jobber",
        "error",
        customer.error,
      );
      return {
        provider: "jobber",
        ok: false,
        error: customer.error || "jobber_customer_create_failed",
      };
    }
    const result = await adapter.createJob(tenantId, {
      ...input,
      customerId: customer.customerId,
      propertyId: customer.propertyId,
    });
    await finishFsmJobWrite({
      tenantId,
      provider: "jobber",
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
      "jobber",
      result.ok ? "connected" : "error",
      result.error,
    );
    return result;
  },

  async lookupByPhone(
    tenantId,
    phone: string,
  ): Promise<FsmClientMatch | null> {
    try {
      const node = await findJobberClient(tenantId, phone);
      if (!node) return null;
      const membership = node.tags.find((tag) =>
        /member|club|plan/i.test(tag),
      );
      const warranty = node.tags.find((tag) => /warranty/i.test(tag));
      return {
        name: node.name,
        phone,
        openJobs: node.openJobs,
        membership,
        warranty,
      };
    } catch {
      return null;
    }
  },
};

export const jobberAdapter = adapter;
