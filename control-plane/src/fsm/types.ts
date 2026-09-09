export type FsmProvider = "jobber" | "housecall_pro" | "gcal_helper";

export type FsmCustomer = {
  name?: string;
  phone?: string;
  email?: string;
  address?: string;
};

export type FsmJobInput = {
  callId: string;
  idempotencyKey?: string;
  customer: FsmCustomer;
  jobType?: string;
  notes?: string;
  membership?: string;
  warranty?: string;
  startIso?: string;
};

export type FsmJobResult = {
  provider: FsmProvider;
  ok: boolean;
  jobId?: string;
  customerId?: string;
  propertyId?: string;
  taggedAiBooked?: boolean;
  dryRun?: boolean;
  error?: string;
};

export type FsmClientMatch = {
  customerId?: string;
  propertyId?: string;
  name?: string;
  phone?: string;
  openJobs: Array<{ id: string; title?: string; status?: string }>;
  membership?: string;
  warranty?: string;
};

export interface FsmAdapter {
  provider: FsmProvider;
  createCustomer(tenantId: string, customer: FsmCustomer): Promise<{
    ok: boolean;
    customerId?: string;
    propertyId?: string;
    error?: string;
  }>;
  createJob(
    tenantId: string,
    input: FsmJobInput & { customerId: string; propertyId?: string },
  ): Promise<FsmJobResult>;
  tagAiBooked(
    tenantId: string,
    input: { customerId: string; jobId: string },
  ): Promise<boolean>;
  createCustomerAndJob(tenantId: string, input: FsmJobInput): Promise<FsmJobResult>;
  lookupByPhone(tenantId: string, phone: string): Promise<FsmClientMatch | null>;
}
