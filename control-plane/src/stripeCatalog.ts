/**
 * Live VeraLux Receptionist Stripe catalog.
 * Products/Prices already exist — do not create new ones.
 */

export const STRIPE_LOOKUP_KEYS = [
  "receptionist_list_monthly",
  "receptionist_setup",
  "receptionist_pilot_monthly",
  "receptionist_pilot_setup",
] as const;

export type StripeLookupKey = (typeof STRIPE_LOOKUP_KEYS)[number];

export type CatalogKind = "recurring" | "setup";

export interface StripeCatalogEntry {
  lookupKey: StripeLookupKey;
  defaultPriceId: string;
  envKey: string;
  planName: string | null;
  planTier: "professional" | "pilot" | null;
  kind: CatalogKind;
  defaultAmountCents: number;
  setupLookupKey?: StripeLookupKey;
}

export const STRIPE_CATALOG: Record<StripeLookupKey, StripeCatalogEntry> = {
  receptionist_list_monthly: {
    lookupKey: "receptionist_list_monthly",
    defaultPriceId: "price_1UCoHhJySNqJ528kpvc2i0nc",
    envKey: "STRIPE_PRICE_RECEPTIONIST_LIST_MONTHLY",
    planName: "Professional",
    planTier: "professional",
    kind: "recurring",
    defaultAmountCents: 200000,
    setupLookupKey: "receptionist_setup",
  },
  receptionist_setup: {
    lookupKey: "receptionist_setup",
    defaultPriceId: "price_1UCoHiJySNqJ528kzbiILgGo",
    envKey: "STRIPE_PRICE_RECEPTIONIST_SETUP",
    planName: null,
    planTier: null,
    kind: "setup",
    defaultAmountCents: 500000,
  },
  receptionist_pilot_monthly: {
    lookupKey: "receptionist_pilot_monthly",
    defaultPriceId: "price_1UCoHjJySNqJ528kJyA2NnNK",
    envKey: "STRIPE_PRICE_RECEPTIONIST_PILOT_MONTHLY",
    planName: "Pilot",
    planTier: "pilot",
    kind: "recurring",
    defaultAmountCents: 150000,
    setupLookupKey: "receptionist_pilot_setup",
  },
  receptionist_pilot_setup: {
    lookupKey: "receptionist_pilot_setup",
    defaultPriceId: "price_1UCoHjJySNqJ528kmVqpmu2H",
    envKey: "STRIPE_PRICE_RECEPTIONIST_PILOT_SETUP",
    planName: null,
    planTier: null,
    kind: "setup",
    defaultAmountCents: 350000,
  },
};

export type BillingState = "subscribed" | "unbilled" | "past_due" | "canceled";

const LIVE_PREFIXES = ["sk_live", "rk_live"];

export function isLiveStripeSecret(secret: string | undefined | null): boolean {
  const key = String(secret || "").trim();
  return LIVE_PREFIXES.some((p) => key.startsWith(p));
}

export function catalogPriceId(entry: StripeCatalogEntry, env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = String(env[entry.envKey] || "").trim();
  return fromEnv || entry.defaultPriceId;
}

export function catalogPriceIds(env: NodeJS.ProcessEnv = process.env): Record<StripeLookupKey, string> {
  const out = {} as Record<StripeLookupKey, string>;
  for (const key of STRIPE_LOOKUP_KEYS) {
    out[key] = catalogPriceId(STRIPE_CATALOG[key], env);
  }
  return out;
}

export function entryForPriceId(
  priceId: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): StripeCatalogEntry | null {
  const id = String(priceId || "").trim();
  if (!id) return null;
  for (const key of STRIPE_LOOKUP_KEYS) {
    const entry = STRIPE_CATALOG[key];
    if (entry.defaultPriceId === id || catalogPriceId(entry, env) === id) return entry;
  }
  return null;
}

export function entryForLookupOrSku(value: string | null | undefined): StripeCatalogEntry | null {
  const raw = String(value || "").trim();
  if (!raw) return null;
  if ((STRIPE_LOOKUP_KEYS as readonly string[]).includes(raw)) {
    return STRIPE_CATALOG[raw as StripeLookupKey];
  }
  return null;
}

export function resolveCatalogEntry(params: {
  priceId?: string | null;
  lookupKey?: string | null;
  sku?: string | null;
  env?: NodeJS.ProcessEnv;
}): StripeCatalogEntry | null {
  return (
    entryForLookupOrSku(params.lookupKey) ||
    entryForLookupOrSku(params.sku) ||
    entryForPriceId(params.priceId, params.env)
  );
}

export function setupPriceIdForMonthly(
  monthly: StripeCatalogEntry,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (!monthly.setupLookupKey) return null;
  return catalogPriceId(STRIPE_CATALOG[monthly.setupLookupKey], env);
}

export function setupAmountCentsForMonthly(monthly: StripeCatalogEntry): number | null {
  if (!monthly.setupLookupKey) return null;
  return STRIPE_CATALOG[monthly.setupLookupKey].defaultAmountCents;
}

export function normalizeSubscriptionStatus(status: string | null | undefined): string {
  const raw = String(status || "").trim().toLowerCase();
  if (raw === "cancelled") return "canceled";
  return raw;
}

export function mapStripeSubscriptionStatus(stripeStatus: string | null | undefined): string {
  const status = normalizeSubscriptionStatus(stripeStatus);
  const map: Record<string, string> = {
    active: "active",
    past_due: "past_due",
    canceled: "canceled",
    unpaid: "past_due",
    paused: "paused",
    trialing: "trial",
    incomplete: "trial",
    incomplete_expired: "canceled",
  };
  return map[status] || status || "trial";
}

export function deriveBillingState(input: {
  stripeSubscriptionId?: string | null;
  status?: string | null;
}): BillingState {
  if (!String(input.stripeSubscriptionId || "").trim()) return "unbilled";
  const status = normalizeSubscriptionStatus(input.status);
  if (status === "canceled" || status === "incomplete_expired") return "canceled";
  if (status === "past_due" || status === "unpaid") return "past_due";
  return "subscribed";
}

export const BILLING_STATE_LABELS: Record<BillingState, string> = {
  subscribed: "Subscribed",
  unbilled: "Unbilled",
  past_due: "Past due",
  canceled: "Canceled",
};

export function billingIntervalFromStripe(interval?: string | null, intervalCount?: number | null): string {
  if (!interval) return "monthly";
  if (interval === "year") return "yearly";
  if (interval === "month" && intervalCount === 3) return "quarterly";
  if (interval === "month") return "monthly";
  if (interval === "week") return "weekly";
  if (interval === "day") return "daily";
  return interval;
}

export function unixToIso(seconds: number | null | undefined): string | null {
  if (!seconds || !Number.isFinite(seconds)) return null;
  return new Date(seconds * 1000).toISOString();
}
