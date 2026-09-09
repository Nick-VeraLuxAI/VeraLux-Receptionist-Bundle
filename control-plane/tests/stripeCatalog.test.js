"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  STRIPE_LOOKUP_KEYS,
  STRIPE_CATALOG,
  catalogPriceId,
  catalogPriceIds,
  deriveBillingState,
  entryForPriceId,
  isLiveStripeSecret,
  mapStripeSubscriptionStatus,
  resolveCatalogEntry,
  setupAmountCentsForMonthly,
  setupPriceIdForMonthly,
} = require("../dist/stripeCatalog.js");

test("catalog has the four live Receptionist prices", () => {
  assert.equal(STRIPE_LOOKUP_KEYS.length, 4);
  assert.equal(STRIPE_CATALOG.receptionist_list_monthly.defaultPriceId, "price_1UCoHhJySNqJ528kpvc2i0nc");
  assert.equal(STRIPE_CATALOG.receptionist_list_monthly.planName, "Professional");
  assert.equal(STRIPE_CATALOG.receptionist_pilot_monthly.defaultPriceId, "price_1UCoHjJySNqJ528kJyA2NnNK");
  assert.equal(STRIPE_CATALOG.receptionist_pilot_monthly.planName, "Pilot");
  assert.equal(STRIPE_CATALOG.receptionist_pilot_monthly.planTier, "pilot");
  assert.equal(STRIPE_CATALOG.receptionist_list_monthly.defaultAmountCents, 200000);
  assert.equal(STRIPE_CATALOG.receptionist_setup.defaultAmountCents, 500000);
  assert.equal(STRIPE_CATALOG.receptionist_pilot_monthly.defaultAmountCents, 150000);
  assert.equal(STRIPE_CATALOG.receptionist_pilot_setup.defaultAmountCents, 350000);
  assert.equal(STRIPE_CATALOG.receptionist_setup.kind, "setup");
});

test("env overrides win over hardcoded price ids", () => {
  const env = { STRIPE_PRICE_RECEPTIONIST_LIST_MONTHLY: "price_override" };
  assert.equal(catalogPriceId(STRIPE_CATALOG.receptionist_list_monthly, env), "price_override");
  assert.equal(catalogPriceIds(env).receptionist_pilot_setup, STRIPE_CATALOG.receptionist_pilot_setup.defaultPriceId);
});

test("setup fee pairs with the matching monthly sku", () => {
  assert.equal(
    setupPriceIdForMonthly(STRIPE_CATALOG.receptionist_list_monthly),
    STRIPE_CATALOG.receptionist_setup.defaultPriceId,
  );
  assert.equal(
    setupPriceIdForMonthly(STRIPE_CATALOG.receptionist_pilot_monthly),
    STRIPE_CATALOG.receptionist_pilot_setup.defaultPriceId,
  );
  assert.equal(setupAmountCentsForMonthly(STRIPE_CATALOG.receptionist_list_monthly), 500000);
  assert.equal(setupAmountCentsForMonthly(STRIPE_CATALOG.receptionist_pilot_monthly), 350000);
});

test("resolve catalog by price id, lookup key, or sku", () => {
  assert.equal(entryForPriceId("price_1UCoHhJySNqJ528kpvc2i0nc")?.lookupKey, "receptionist_list_monthly");
  assert.equal(resolveCatalogEntry({ lookupKey: "receptionist_pilot_monthly" })?.planName, "Pilot");
  assert.equal(resolveCatalogEntry({ sku: "receptionist_setup" })?.kind, "setup");
  assert.equal(resolveCatalogEntry({ priceId: "price_unknown" }), null);
});

test("live secret detect requires staff confirm", () => {
  assert.equal(isLiveStripeSecret("sk_live_abc"), true);
  assert.equal(isLiveStripeSecret("rk_live_abc"), true);
  assert.equal(isLiveStripeSecret("sk_test_abc"), false);
  assert.equal(isLiveStripeSecret("rk_test_abc"), false);
  assert.equal(isLiveStripeSecret(""), false);
});

test("billing state is unbilled without a Stripe subscription id", () => {
  assert.equal(deriveBillingState({ status: "active" }), "unbilled");
  assert.equal(deriveBillingState({ stripeSubscriptionId: "sub_1", status: "active" }), "subscribed");
  assert.equal(deriveBillingState({ stripeSubscriptionId: "sub_1", status: "past_due" }), "past_due");
  assert.equal(deriveBillingState({ stripeSubscriptionId: "sub_1", status: "cancelled" }), "canceled");
  assert.equal(deriveBillingState({ stripeSubscriptionId: "sub_1", status: "canceled" }), "canceled");
});

test("stripe status mapping does not invent canceled as unpaid", () => {
  assert.equal(mapStripeSubscriptionStatus("active"), "active");
  assert.equal(mapStripeSubscriptionStatus("unpaid"), "past_due");
  assert.equal(mapStripeSubscriptionStatus("trialing"), "trial");
  assert.equal(mapStripeSubscriptionStatus("canceled"), "canceled");
});
