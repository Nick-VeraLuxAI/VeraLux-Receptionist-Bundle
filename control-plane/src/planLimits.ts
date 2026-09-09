import { z } from "zod";

export const PLAN_TIER_IDS = ["starter", "professional", "pilot", "premium", "enterprise"] as const;
export const planTierSchema = z.enum(PLAN_TIER_IDS);
export const billingStatusSchema = z.enum(["trial", "active", "past_due", "suspended", "canceled"]);
export const overageModeSchema = z.enum(["allow_and_bill", "throttle", "hard_stop"]);

export const tenantLimitsSchema = z.object({
  planName: z.string().min(1),
  planTier: planTierSchema,
  billingStatus: billingStatusSchema,
  overageMode: overageModeSchema,
  monthlyMinuteOverageRateCents: z.number().int().min(0),
  effectiveFrom: z.string().datetime().nullable().optional(),
  effectiveUntil: z.string().datetime().nullable().optional(),

  maxConcurrentCalls: z.number().int().positive(),
  includedMonthlyMinutes: z.number().int().min(0),
  maxMonthlyMinutesHardCap: z.number().int().min(0),
  maxDailyCalls: z.number().int().min(0),
  maxMonthlyCalls: z.number().int().min(0),
  maxKnowledgeBaseSizeMb: z.number().int().min(0),
  maxIntegrations: z.number().int().min(0),
  maxLocations: z.number().int().min(0),
  maxPhoneNumbers: z.number().int().min(0),
  maxAdminUsers: z.number().int().min(0),
  maxEscalationContacts: z.number().int().min(0),

  afterHoursMode: z.boolean(),
  smsFollowup: z.boolean(),
  calendarIntegration: z.boolean(),
  crmIntegration: z.boolean(),
  advancedAnalytics: z.boolean(),
  callRecording: z.boolean(),
  transcriptRetention: z.boolean(),
  multiLocation: z.boolean(),
  customWorkflows: z.boolean(),
  prioritySupport: z.boolean(),
});

export type TenantLimits = z.infer<typeof tenantLimitsSchema> & {
  updatedBy?: string | null;
  updatedAt?: string | null;
};

export const PLAN_DEFAULTS: Record<z.infer<typeof planTierSchema>, TenantLimits> = {
  starter: {
    planName: "Starter",
    planTier: "starter",
    billingStatus: "trial",
    overageMode: "hard_stop",
    monthlyMinuteOverageRateCents: 0,
    effectiveFrom: null,
    effectiveUntil: null,
    maxConcurrentCalls: 1,
    includedMonthlyMinutes: 300,
    maxMonthlyMinutesHardCap: 500,
    maxDailyCalls: 50,
    maxMonthlyCalls: 700,
    maxKnowledgeBaseSizeMb: 32,
    maxIntegrations: 1,
    maxLocations: 1,
    maxPhoneNumbers: 1,
    maxAdminUsers: 2,
    maxEscalationContacts: 3,
    afterHoursMode: true,
    smsFollowup: false,
    calendarIntegration: false,
    crmIntegration: false,
    advancedAnalytics: false,
    callRecording: false,
    transcriptRetention: true,
    multiLocation: false,
    customWorkflows: false,
    prioritySupport: false,
  },
  professional: {
    planName: "Professional",
    planTier: "professional",
    billingStatus: "active",
    overageMode: "allow_and_bill",
    monthlyMinuteOverageRateCents: 35,
    effectiveFrom: null,
    effectiveUntil: null,
    maxConcurrentCalls: 3,
    includedMonthlyMinutes: 1200,
    maxMonthlyMinutesHardCap: 3000,
    maxDailyCalls: 250,
    maxMonthlyCalls: 5000,
    maxKnowledgeBaseSizeMb: 128,
    maxIntegrations: 5,
    maxLocations: 3,
    maxPhoneNumbers: 10,
    maxAdminUsers: 10,
    maxEscalationContacts: 20,
    afterHoursMode: true,
    smsFollowup: true,
    calendarIntegration: true,
    crmIntegration: true,
    advancedAnalytics: true,
    callRecording: false,
    transcriptRetention: true,
    multiLocation: true,
    customWorkflows: true,
    prioritySupport: false,
  },
  pilot: {
    planName: "Pilot",
    planTier: "pilot",
    billingStatus: "active",
    overageMode: "allow_and_bill",
    monthlyMinuteOverageRateCents: 35,
    effectiveFrom: null,
    effectiveUntil: null,
    maxConcurrentCalls: 3,
    includedMonthlyMinutes: 1200,
    maxMonthlyMinutesHardCap: 3000,
    maxDailyCalls: 250,
    maxMonthlyCalls: 5000,
    maxKnowledgeBaseSizeMb: 128,
    maxIntegrations: 5,
    maxLocations: 3,
    maxPhoneNumbers: 10,
    maxAdminUsers: 10,
    maxEscalationContacts: 20,
    afterHoursMode: true,
    smsFollowup: true,
    calendarIntegration: true,
    crmIntegration: true,
    advancedAnalytics: true,
    callRecording: false,
    transcriptRetention: true,
    multiLocation: true,
    customWorkflows: true,
    prioritySupport: false,
  },
  premium: {
    ...{
      planName: "Premium",
      planTier: "premium" as const,
      billingStatus: "active" as const,
      overageMode: "allow_and_bill" as const,
      monthlyMinuteOverageRateCents: 25,
      effectiveFrom: null,
      effectiveUntil: null,
      maxConcurrentCalls: 6,
      includedMonthlyMinutes: 4000,
      maxMonthlyMinutesHardCap: 10000,
      maxDailyCalls: 700,
      maxMonthlyCalls: 15000,
      maxKnowledgeBaseSizeMb: 512,
      maxIntegrations: 15,
      maxLocations: 15,
      maxPhoneNumbers: 40,
      maxAdminUsers: 30,
      maxEscalationContacts: 75,
      afterHoursMode: true,
      smsFollowup: true,
      calendarIntegration: true,
      crmIntegration: true,
      advancedAnalytics: true,
      callRecording: true,
      transcriptRetention: true,
      multiLocation: true,
      customWorkflows: true,
      prioritySupport: true,
    },
  },
  enterprise: {
    ...{
      planName: "Enterprise",
      planTier: "enterprise" as const,
      billingStatus: "active" as const,
      overageMode: "allow_and_bill" as const,
      monthlyMinuteOverageRateCents: 20,
      effectiveFrom: null,
      effectiveUntil: null,
      maxConcurrentCalls: 25,
      includedMonthlyMinutes: 20000,
      maxMonthlyMinutesHardCap: 100000,
      maxDailyCalls: 5000,
      maxMonthlyCalls: 150000,
      maxKnowledgeBaseSizeMb: 2048,
      maxIntegrations: 100,
      maxLocations: 200,
      maxPhoneNumbers: 500,
      maxAdminUsers: 500,
      maxEscalationContacts: 500,
      afterHoursMode: true,
      smsFollowup: true,
      calendarIntegration: true,
      crmIntegration: true,
      advancedAnalytics: true,
      callRecording: true,
      transcriptRetention: true,
      multiLocation: true,
      customWorkflows: true,
      prioritySupport: true,
    },
  },
};

export const RECOMMENDED_DEFAULT_PLAN_TIER: z.infer<typeof planTierSchema> = "professional";

export function getPlanDefaults(planTier: z.infer<typeof planTierSchema>): TenantLimits {
  return { ...PLAN_DEFAULTS[planTier] };
}

export function listPlanDefaultsPayload(): {
  tiers: typeof PLAN_TIER_IDS;
  defaults: Record<string, TenantLimits>;
} {
  const defaults = {} as Record<string, TenantLimits>;
  for (const tier of PLAN_TIER_IDS) {
    defaults[tier] = getPlanDefaults(tier);
  }
  return { tiers: PLAN_TIER_IDS, defaults };
}
