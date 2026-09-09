/**
 * Stripe billing against the existing live Receptionist catalog.
 * Does not create Products/Prices. Staff confirm is required on live keys.
 */

import Stripe from "stripe";
import {
  attachStripeWebhookTenant,
  claimStripeWebhookEvent,
  findTenantIdByStripeCustomer,
  findTenantIdByStripeSubscription,
  getOwnerPortalCredentialRow,
  getSubscription,
  getTenantLimits,
  persistStripeBilling,
  releaseStripeWebhookEvent,
  setTenantBillingStatus,
  upsertTenantLimits,
  type TenantSubscription,
} from "./db";
import {
  BILLING_STATE_LABELS,
  billingIntervalFromStripe,
  catalogPriceId,
  catalogPriceIds,
  deriveBillingState,
  entryForPriceId,
  isLiveStripeSecret,
  mapStripeSubscriptionStatus,
  resolveCatalogEntry,
  setupAmountCentsForMonthly,
  setupPriceIdForMonthly,
  STRIPE_CATALOG,
  STRIPE_LOOKUP_KEYS,
  unixToIso,
  type BillingState,
  type StripeCatalogEntry,
} from "./stripeCatalog";

let _stripe: Stripe | null = null;

export function getStripe(): Stripe {
  if (_stripe) return _stripe;
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error("STRIPE_SECRET_KEY is not set");
  _stripe = new Stripe(key);
  return _stripe;
}

export function isStripeConfigured(): boolean {
  return !!String(process.env.STRIPE_SECRET_KEY || "").trim();
}

export function isStripeLiveMode(): boolean {
  return isLiveStripeSecret(process.env.STRIPE_SECRET_KEY);
}

export function webhookPublicPath(): string {
  return "/api/stripe/webhook";
}

export function webhookPublicUrl(): string {
  const base = String(
    process.env.CONTROL_PLANE_PUBLIC_URL ||
      process.env.PUBLIC_BASE_URL ||
      process.env.BASE_URL ||
      "",
  ).replace(/\/$/, "");
  return base ? `${base}${webhookPublicPath()}` : webhookPublicPath();
}

function idOf(value: string | { id: string } | null | undefined): string | null {
  if (!value) return null;
  return typeof value === "string" ? value : value.id;
}

function requireLiveConfirm(confirm: unknown): void {
  if (!isStripeLiveMode()) return;
  if (confirm === true || confirm === "true" || confirm === 1 || confirm === "1") return;
  const err = new Error("Live Stripe keys require an explicit staff confirm action");
  (err as Error & { code?: string }).code = "live_confirm_required";
  throw err;
}

function assertCatalogRecurring(priceId: string): StripeCatalogEntry {
  const entry = entryForPriceId(priceId);
  if (!entry) {
    const err = new Error("Price is not in the VeraLux Receptionist catalog");
    (err as Error & { code?: string }).code = "unknown_catalog_price";
    throw err;
  }
  if (entry.kind !== "recurring") {
    const err = new Error("Select a monthly catalog price, not a setup fee");
    (err as Error & { code?: string }).code = "setup_price_not_subscribable";
    throw err;
  }
  return entry;
}

export async function getOrCreateStripeCustomer(
  tenantId: string,
  opts?: { email?: string; name?: string },
): Promise<string> {
  const existing = await getSubscription(tenantId);
  if (existing?.stripeCustomerId) return existing.stripeCustomerId;

  let email = opts?.email;
  if (!email) {
    const cred = await getOwnerPortalCredentialRow(tenantId).catch(() => null);
    email = cred?.emailNorm || undefined;
  }

  const stripe = getStripe();
  const customer = await stripe.customers.create({
    metadata: { tenant_id: tenantId },
    email,
    name: opts?.name || tenantId,
  });

  await persistStripeBilling(tenantId, {
    stripeCustomerId: customer.id,
    showBillingPortal: existing?.showBillingPortal ?? false,
    planName: existing?.planName ?? "Unbilled",
    priceCents: existing?.priceCents ?? 0,
    status: existing?.status ?? "trial",
  });

  return customer.id;
}

function periodFromSubscription(sub: Stripe.Subscription): { start: string | null; end: string | null } {
  const item = sub.items?.data?.[0] as
    | (Stripe.SubscriptionItem & { current_period_start?: number; current_period_end?: number })
    | undefined;
  const start =
    item?.current_period_start ??
    (sub as Stripe.Subscription & { current_period_start?: number }).current_period_start;
  const end =
    item?.current_period_end ??
    (sub as Stripe.Subscription & { current_period_end?: number }).current_period_end;
  return { start: unixToIso(start), end: unixToIso(end) };
}

const REPLACEABLE_PLAN_NAMES = new Set(["Professional", "Pilot", "Starter", "Premium", "Enterprise", "Unbilled", ""]);

async function applySkuEntitlements(
  tenantId: string,
  entry: StripeCatalogEntry | null,
  actor: string,
  opts?: { force?: boolean },
): Promise<void> {
  if (!entry?.planName || !entry.planTier) return;
  if (!opts?.force) {
    const limits = await getTenantLimits(tenantId);
    if (!REPLACEABLE_PLAN_NAMES.has(String(limits.planName || ""))) return;
  }
  await upsertTenantLimits(
    tenantId,
    { planName: entry.planName, planTier: entry.planTier },
    actor,
  );
}

async function applyVoiceSafeBillingStatus(
  tenantId: string,
  mappedStatus: string,
  actor: string,
): Promise<void> {
  const limits = await getTenantLimits(tenantId);
  if (mappedStatus === "past_due" && limits.billingStatus !== "suspended" && limits.billingStatus !== "canceled") {
    await setTenantBillingStatus(tenantId, "past_due", actor);
    return;
  }
  // Restore service after a failed invoice is paid. Do not auto-set canceled (kills voice).
  if (mappedStatus === "active" && limits.billingStatus === "past_due") {
    await setTenantBillingStatus(tenantId, "active", actor);
  }
}

export async function persistStripeSubscription(
  tenantId: string,
  sub: Stripe.Subscription,
  extra?: Partial<TenantSubscription>,
): Promise<TenantSubscription> {
  const item = sub.items.data[0];
  const price = item?.price;
  const entry = resolveCatalogEntry({
    priceId: price?.id,
    lookupKey: price?.lookup_key,
    sku: price?.metadata?.sku || price?.metadata?.lookup_key,
  });
  const period = periodFromSubscription(sub);
  const mappedStatus = mapStripeSubscriptionStatus(sub.status);

  let cardBrand: string | null = null;
  let cardLast4: string | null = null;
  if (sub.default_payment_method && typeof sub.default_payment_method !== "string") {
    if (sub.default_payment_method.card) {
      cardBrand = sub.default_payment_method.card.brand;
      cardLast4 = sub.default_payment_method.card.last4;
    }
  }

  const canceledAt = unixToIso(
    (sub as Stripe.Subscription & { canceled_at?: number | null }).canceled_at ?? undefined,
  );
  const trialEnd = unixToIso((sub as Stripe.Subscription & { trial_end?: number | null }).trial_end ?? undefined);

  const record = await persistStripeBilling(tenantId, {
    stripeCustomerId: idOf(sub.customer),
    stripeSubscriptionId: sub.id,
    stripePriceId: price?.id ?? null,
    stripeProductId: idOf(price?.product as string | { id: string } | null) ?? null,
    planName: entry?.planName || price?.nickname || extra?.planName || undefined,
    priceCents: price?.unit_amount ?? extra?.priceCents,
    currency: price?.currency || extra?.currency || "usd",
    billingFrequency: billingIntervalFromStripe(price?.recurring?.interval, price?.recurring?.interval_count),
    status: mappedStatus,
    paymentMethodBrand: cardBrand,
    paymentMethodLast4: cardLast4,
    currentPeriodStart: period.start,
    currentPeriodEnd: period.end,
    nextBillingDate: period.end,
    trialEndsAt: trialEnd,
    cancelledAt: canceledAt,
    ...extra,
  });

  await applyVoiceSafeBillingStatus(tenantId, mappedStatus, "stripe");
  return record;
}

export async function syncSubscriptionFromStripe(
  tenantId: string,
  stripeSubId: string,
): Promise<TenantSubscription> {
  const stripe = getStripe();
  const sub = await stripe.subscriptions.retrieve(stripeSubId, {
    expand: ["default_payment_method", "items.data.price"],
  });
  return persistStripeSubscription(tenantId, sub);
}

async function resolveTenantSubscriptionId(
  tenantId: string,
  existing?: TenantSubscription | null,
): Promise<string | null> {
  if (existing?.stripeSubscriptionId) return existing.stripeSubscriptionId;
  if (!existing?.stripeCustomerId) return null;
  const stripe = getStripe();
  const list = await stripe.subscriptions.list({
    customer: existing.stripeCustomerId,
    status: "all",
    limit: 10,
  });
  const preferred =
    list.data.find((s) => s.status === "active" || s.status === "trialing" || s.status === "past_due") ||
    list.data[0];
  return preferred?.id ?? null;
}

export async function syncTenantBillingFromStripe(tenantId: string): Promise<{
  subscription: Awaited<ReturnType<typeof serializeSubscriptionPayload>>;
  changes: string[];
}> {
  const before = await getSubscription(tenantId);
  let customerId = before?.stripeCustomerId || null;
  if (!customerId) {
    customerId = await getOrCreateStripeCustomer(tenantId);
  }

  const stripe = getStripe();
  const customer = await stripe.customers.retrieve(customerId);
  if (customer.deleted) {
    throw Object.assign(new Error("Stripe customer was deleted"), { code: "stripe_customer_deleted" });
  }

  const subId = await resolveTenantSubscriptionId(tenantId, {
    ...(before || ({} as TenantSubscription)),
    stripeCustomerId: customerId,
  });

  const changes: string[] = [];
  if (!before?.stripeCustomerId && customerId) changes.push("Linked Stripe customer");

  if (subId) {
    const updated = await syncSubscriptionFromStripe(tenantId, subId);
    if (before?.status !== updated.status) changes.push(`Status ${before?.status || "none"} → ${updated.status}`);
    if (before?.stripeSubscriptionId !== updated.stripeSubscriptionId) {
      changes.push(`Subscription ${updated.stripeSubscriptionId}`);
    }
    if (before?.planName !== updated.planName) changes.push(`Plan ${updated.planName}`);
    const entry = resolveCatalogEntry({ priceId: updated.stripePriceId });
    await applySkuEntitlements(tenantId, entry, "admin-sync");
    return { subscription: await serializeSubscriptionPayload(tenantId), changes };
  }

  await persistStripeBilling(tenantId, { stripeCustomerId: customerId });
  if (!changes.length) changes.push("No Stripe subscription on this customer");
  return { subscription: await serializeSubscriptionPayload(tenantId), changes };
}

export async function createStaffSubscription(params: {
  tenantId: string;
  priceId: string;
  includeSetup?: boolean;
  confirm?: unknown;
  tenantName?: string;
  tenantEmail?: string;
  collectionMethod?: "send_invoice" | "charge_automatically";
}): Promise<{ subscription: TenantSubscription; created: boolean; invoiceId?: string }> {
  requireLiveConfirm(params.confirm);
  const entry = assertCatalogRecurring(params.priceId);
  const existing = await getSubscription(params.tenantId);
  if (existing?.stripeSubscriptionId) {
    const stripe = getStripe();
    const current = await stripe.subscriptions.retrieve(existing.stripeSubscriptionId).catch(() => null);
    if (current && !["canceled", "incomplete_expired"].includes(current.status)) {
      const persisted = await persistStripeSubscription(params.tenantId, current);
      return { subscription: persisted, created: false };
    }
  }

  const customerId = await getOrCreateStripeCustomer(params.tenantId, {
    name: params.tenantName,
    email: params.tenantEmail,
  });

  const stripe = getStripe();
  const customer = await stripe.customers.retrieve(customerId);
  if (customer.deleted) throw new Error("Stripe customer was deleted");

  const hasPm = Boolean(
    !customer.deleted &&
      (customer.invoice_settings?.default_payment_method || customer.default_source),
  );
  const collectionMethod =
    params.collectionMethod || (hasPm ? "charge_automatically" : "send_invoice");

  const setupId = params.includeSetup ? setupPriceIdForMonthly(entry) : null;
  const createParams: Stripe.SubscriptionCreateParams = {
    customer: customerId,
    items: [{ price: params.priceId, quantity: 1 }],
    metadata: { tenant_id: params.tenantId, sku: entry.lookupKey },
    collection_method: collectionMethod,
    payment_behavior: collectionMethod === "charge_automatically" ? "default_incomplete" : undefined,
    days_until_due: collectionMethod === "send_invoice" ? 14 : undefined,
    add_invoice_items: setupId ? [{ price: setupId, quantity: 1 }] : undefined,
  };

  const sub = await stripe.subscriptions.create(createParams, {
    idempotencyKey: `vl_sub_${params.tenantId}_${params.priceId}`.slice(0, 255),
  });

  const persisted = await persistStripeSubscription(params.tenantId, sub, {
    planName: entry.planName || undefined,
  });

  return {
    subscription: persisted,
    created: true,
    invoiceId: idOf((sub as Stripe.Subscription & { latest_invoice?: string | { id: string } }).latest_invoice) || undefined,
  };
}

export async function cancelStaffSubscription(params: {
  tenantId: string;
  confirm?: unknown;
  atPeriodEnd?: boolean;
}): Promise<TenantSubscription> {
  requireLiveConfirm(params.confirm);
  const existing = await getSubscription(params.tenantId);
  if (!existing?.stripeSubscriptionId) {
    throw Object.assign(new Error("No Stripe subscription to cancel"), { code: "no_stripe_subscription" });
  }
  const stripe = getStripe();
  const sub = params.atPeriodEnd === false
    ? await stripe.subscriptions.cancel(existing.stripeSubscriptionId)
    : await stripe.subscriptions.update(existing.stripeSubscriptionId, { cancel_at_period_end: true });
  return persistStripeSubscription(params.tenantId, sub);
}

export async function createCheckoutSession(params: {
  tenantId: string;
  priceId: string;
  successUrl: string;
  cancelUrl: string;
  tenantName?: string;
  tenantEmail?: string;
  includeSetup?: boolean;
}): Promise<Stripe.Checkout.Session> {
  const entry = assertCatalogRecurring(params.priceId);
  const stripe = getStripe();
  const customerId = await getOrCreateStripeCustomer(params.tenantId, {
    name: params.tenantName,
    email: params.tenantEmail,
  });
  const setupId = params.includeSetup ? setupPriceIdForMonthly(entry) : null;
  const lineItems: Stripe.Checkout.SessionCreateParams.LineItem[] = [
    { price: params.priceId, quantity: 1 },
  ];
  if (setupId) lineItems.push({ price: setupId, quantity: 1 });

  return stripe.checkout.sessions.create({
    customer: customerId,
    mode: "subscription",
    line_items: lineItems,
    success_url: params.successUrl,
    cancel_url: params.cancelUrl,
    metadata: { tenant_id: params.tenantId, sku: entry.lookupKey },
    subscription_data: {
      metadata: { tenant_id: params.tenantId, sku: entry.lookupKey },
    },
  });
}

export async function createPortalSession(params: {
  tenantId: string;
  returnUrl: string;
  createCustomerIfMissing?: boolean;
}): Promise<Stripe.BillingPortal.Session> {
  const existing = await getSubscription(params.tenantId);
  let customerId = existing?.stripeCustomerId || null;
  if (!customerId && params.createCustomerIfMissing) {
    customerId = await getOrCreateStripeCustomer(params.tenantId);
  }
  if (!customerId) {
    throw Object.assign(new Error("No Stripe customer for this tenant"), { code: "no_stripe_customer" });
  }
  const stripe = getStripe();
  return stripe.billingPortal.sessions.create({
    customer: customerId,
    return_url: params.returnUrl,
  });
}

function invoiceCustomerId(invoice: Stripe.Invoice): string | null {
  return idOf(invoice.customer);
}

function invoiceSubscriptionId(invoice: Stripe.Invoice): string | null {
  const legacy = (invoice as Stripe.Invoice & { subscription?: string | { id: string } | null }).subscription;
  if (legacy) return idOf(legacy);
  const parent = (invoice as Stripe.Invoice & {
    parent?: { subscription_details?: { subscription?: string | { id: string } } };
  }).parent;
  return idOf(parent?.subscription_details?.subscription);
}

async function resolveTenantFromStripeIds(params: {
  tenantId?: string | null;
  customerId?: string | null;
  subscriptionId?: string | null;
}): Promise<string | null> {
  if (params.tenantId) return params.tenantId;
  if (params.subscriptionId) {
    const bySub = await findTenantIdByStripeSubscription(params.subscriptionId);
    if (bySub) return bySub;
  }
  if (params.customerId) return findTenantIdByStripeCustomer(params.customerId);
  return null;
}

export async function applyStripeEvent(event: {
  id: string;
  type: string;
  data: { object: unknown };
}): Promise<{ event: string; tenantId?: string; duplicate?: boolean }> {
  const claimed = await claimStripeWebhookEvent({
    eventId: event.id,
    eventType: event.type,
  });
  if (!claimed) return { event: event.type, duplicate: true };

  try {
    let tenantId: string | undefined;

    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object as Stripe.Checkout.Session;
        tenantId =
          (await resolveTenantFromStripeIds({
            tenantId: session.metadata?.tenant_id,
            customerId: idOf(session.customer),
            subscriptionId: idOf(session.subscription),
          })) || undefined;
        if (tenantId && session.subscription) {
          await syncSubscriptionFromStripe(tenantId, idOf(session.subscription)!);
        }
        break;
      }
      case "customer.subscription.created":
      case "customer.subscription.updated":
      case "customer.subscription.deleted": {
        const sub = event.data.object as Stripe.Subscription;
        tenantId =
          (await resolveTenantFromStripeIds({
            tenantId: sub.metadata?.tenant_id,
            customerId: idOf(sub.customer),
            subscriptionId: sub.id,
          })) || undefined;
        if (tenantId) {
          await persistStripeSubscription(tenantId, sub);
        }
        break;
      }
      case "invoice.paid":
      case "invoice.payment_failed": {
        const invoice = event.data.object as Stripe.Invoice;
        const customerId = invoiceCustomerId(invoice);
        const subscriptionId = invoiceSubscriptionId(invoice);
        tenantId =
          (await resolveTenantFromStripeIds({
            customerId,
            subscriptionId,
          })) || undefined;
        if (tenantId && subscriptionId) {
          await syncSubscriptionFromStripe(tenantId, subscriptionId);
        } else if (tenantId) {
          const mapped = event.type === "invoice.payment_failed" ? "past_due" : "active";
          await persistStripeBilling(tenantId, { status: mapped });
          await applyVoiceSafeBillingStatus(tenantId, mapped, "stripe-webhook");
        }
        break;
      }
      default:
        break;
    }

    await attachStripeWebhookTenant(event.id, tenantId || null);
    return { event: event.type, tenantId };
  } catch (err) {
    await releaseStripeWebhookEvent(event.id);
    throw err;
  }
}

export async function handleStripeWebhook(
  body: Buffer,
  signature: string,
): Promise<{ event: string; tenantId?: string; duplicate?: boolean }> {
  const stripe = getStripe();
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) throw new Error("STRIPE_WEBHOOK_SECRET is not set");
  const event = stripe.webhooks.constructEvent(body, signature, webhookSecret);
  return applyStripeEvent(event);
}

export interface CatalogPrice {
  id: string;
  lookupKey: string;
  sku: string;
  name: string;
  planTier: "professional" | "pilot" | null;
  priceCents: number;
  currency: string;
  billingInterval: string;
  kind: "recurring" | "setup";
  setupPriceId: string | null;
  setupPriceCents: number | null;
  productName: string | null;
  livemode: boolean;
}

function catalogPriceFromEntry(entry: StripeCatalogEntry, overrides: Partial<CatalogPrice> = {}): CatalogPrice {
  return {
    id: catalogPriceId(entry),
    lookupKey: entry.lookupKey,
    sku: entry.lookupKey,
    name: entry.planName || entry.lookupKey,
    planTier: entry.planTier,
    priceCents: entry.defaultAmountCents,
    currency: "usd",
    billingInterval: entry.kind === "recurring" ? "monthly" : "one_time",
    kind: entry.kind,
    setupPriceId: entry.kind === "recurring" ? setupPriceIdForMonthly(entry) : null,
    setupPriceCents: entry.kind === "recurring" ? setupAmountCentsForMonthly(entry) : null,
    productName: entry.planName,
    livemode: false,
    ...overrides,
  };
}

function catalogPriceFromStripe(price: Stripe.Price, entry: StripeCatalogEntry): CatalogPrice {
  const product = typeof price.product === "object" && price.product && !("deleted" in price.product && price.product.deleted)
    ? price.product
    : null;
  return catalogPriceFromEntry(entry, {
    id: price.id,
    name: entry.planName || price.nickname || (product && "name" in product ? String(product.name) : entry.lookupKey),
    priceCents: price.unit_amount ?? entry.defaultAmountCents,
    currency: price.currency || "usd",
    billingInterval: price.recurring
      ? billingIntervalFromStripe(price.recurring.interval, price.recurring.interval_count)
      : "one_time",
    productName: product && "name" in product ? String(product.name) : entry.planName,
    livemode: Boolean(price.livemode),
  });
}

function attachSetupCents(items: CatalogPrice[]): CatalogPrice[] {
  const byId = new Map(items.map((p) => [p.id, p]));
  const byKey = new Map(items.map((p) => [p.lookupKey, p]));
  return items.map((p) => {
    if (p.kind !== "recurring") return p;
    const entry = STRIPE_CATALOG[p.lookupKey as keyof typeof STRIPE_CATALOG];
    const setup =
      (p.setupPriceId && byId.get(p.setupPriceId)) ||
      (entry?.setupLookupKey ? byKey.get(entry.setupLookupKey) : null);
    const setupPriceCents =
      (setup && setup.priceCents) ||
      (entry ? setupAmountCentsForMonthly(entry) : null);
    return { ...p, setupPriceCents: setupPriceCents || null };
  });
}

export function staticCatalogPrices(): CatalogPrice[] {
  return attachSetupCents(STRIPE_LOOKUP_KEYS.map((key) => catalogPriceFromEntry(STRIPE_CATALOG[key])));
}

export async function listCatalogPrices(): Promise<CatalogPrice[]> {
  const stripe = getStripe();
  const ids = catalogPriceIds();
  const found = new Map<string, CatalogPrice>();

  try {
    const byLookup = await stripe.prices.list({
      lookup_keys: [...STRIPE_LOOKUP_KEYS],
      active: true,
      expand: ["data.product"],
      limit: 20,
    });
    for (const price of byLookup.data) {
      const entry =
        resolveCatalogEntry({
          priceId: price.id,
          lookupKey: price.lookup_key,
          sku: price.metadata?.sku,
        }) || (price.lookup_key ? STRIPE_CATALOG[price.lookup_key as keyof typeof STRIPE_CATALOG] : null);
      if (!entry) continue;
      found.set(entry.lookupKey, catalogPriceFromStripe(price, entry));
    }
  } catch (err) {
    console.warn("[stripe] lookup_keys list failed; falling back to price ids", err);
  }

  for (const key of STRIPE_LOOKUP_KEYS) {
    if (found.has(key)) continue;
    const entry = STRIPE_CATALOG[key];
    try {
      const price = await stripe.prices.retrieve(ids[key], { expand: ["product"] });
      if (price.active === false) continue;
      found.set(key, catalogPriceFromStripe(price, entry));
    } catch (err) {
      console.warn(`[stripe] catalog price missing: ${key} ${ids[key]}`, err);
    }
  }

  const merged = STRIPE_LOOKUP_KEYS.map((k) => found.get(k) || catalogPriceFromEntry(STRIPE_CATALOG[k]));
  return attachSetupCents(merged);
}

/** @deprecated Local stripe_plans table. Live catalog is listCatalogPrices. */
export async function listStripePlans(): Promise<CatalogPrice[]> {
  if (!isStripeConfigured()) return staticCatalogPrices();
  return listCatalogPrices();
}

export async function createStripePlan(): Promise<never> {
  throw Object.assign(new Error("Creating Stripe products/prices is disabled. Use the live catalog."), {
    code: "catalog_readonly",
  });
}

export async function deleteStripePlan(_planId: string): Promise<boolean> {
  throw Object.assign(new Error("Archiving Stripe products/prices is disabled. Use the live catalog."), {
    code: "catalog_readonly",
  });
}

export async function serializeSubscriptionPayload(
  tenantId: string,
  actor: { owner?: boolean } = {},
): Promise<Record<string, unknown>> {
  const sub = await getSubscription(tenantId);
  const limits = await getTenantLimits(tenantId);
  const billingState: BillingState = deriveBillingState({
    stripeSubscriptionId: sub?.stripeSubscriptionId,
    status: sub?.status,
  });
  const configured = billingState !== "unbilled";
  const liveMode = isStripeLiveMode();

  const serviceStatus = limits.billingStatus;
  const base = {
    configured,
    tenantId,
    billingState,
    billingStateLabel: BILLING_STATE_LABELS[billingState],
    liveMode,
    planName: configured ? sub?.planName || limits.planName : limits.planName,
    planTier: limits.planTier,
    priceCents: configured ? sub?.priceCents ?? null : null,
    currency: sub?.currency || "usd",
    billingFrequency: sub?.billingFrequency || null,
    billingInterval: sub?.billingFrequency || null,
    status: sub?.status || null,
    currentPeriodStart: sub?.currentPeriodStart || null,
    currentPeriodEnd: sub?.currentPeriodEnd || sub?.nextBillingDate || null,
    nextBillingDate: sub?.nextBillingDate || sub?.currentPeriodEnd || null,
    cancelAtPeriodEnd: false,
    showBillingPortal: Boolean(sub?.showBillingPortal),
    entitlements: {
      planName: limits.planName,
      planTier: limits.planTier,
      billingStatus: serviceStatus,
    },
    serviceStatus,
  };

  if (actor.owner) {
    return {
      ...base,
      adminNotes: undefined,
    };
  }

  return {
    ...base,
    stripeCustomerId: sub?.stripeCustomerId || null,
    stripeSubscriptionId: sub?.stripeSubscriptionId || null,
    stripePriceId: sub?.stripePriceId || null,
    stripeProductId: sub?.stripeProductId || null,
    adminNotes: sub?.adminNotes || null,
    paymentMethodBrand: sub?.paymentMethodBrand || null,
    paymentMethodLast4: sub?.paymentMethodLast4 || null,
    webhookUrl: webhookPublicUrl(),
  };
}

export { catalogPriceId };
