const test = require("node:test");
const assert = require("node:assert/strict");
process.env.DATABASE_URL =
  process.env.DATABASE_URL || "postgres://veralux_test:veralux_test@127.0.0.1:55432/veralux_test";
const {
  pingPool,
  runMigrations,
  upsertTenant,
  getTenantLimits,
  upsertTenantLimits,
  resetTenantLimitsToPlanDefaults,
  setTenantBillingStatus,
  recordTenantCallStarted,
  recordTenantCallEnded,
  getTenantUsageSnapshot,
  getTenantBillingSummary,
  closePool,
} = require("../dist/db.js");

let dbReady = false;

test("tenant limits db setup", async (t) => {
  dbReady = await pingPool();
  if (!dbReady) return t.skip("postgres unavailable in test environment");
  await runMigrations();
  await upsertTenant({ id: "tenantA", name: "Tenant A" });
  await upsertTenant({ id: "tenantB", name: "Tenant B" });
});

test("limits lifecycle and billing summary", async (t) => {
  if (!dbReady) return t.skip("postgres unavailable in test environment");
  const base = await getTenantLimits("tenantA");
  assert.ok(base.planTier);

  const patched = await upsertTenantLimits(
    "tenantA",
    {
      planTier: "premium",
      includedMonthlyMinutes: 1,
      monthlyMinuteOverageRateCents: 50,
    },
    "test-admin",
  );
  assert.equal(patched.planTier, "premium");
  assert.equal(patched.includedMonthlyMinutes, 1);

  await recordTenantCallStarted("tenantA");
  await recordTenantCallEnded({ tenantId: "tenantA", durationMs: 120000 });
  const usage = await getTenantUsageSnapshot("tenantA");
  assert.ok(usage.monthlyCalls >= 1);
  assert.ok(usage.monthlyBillableMinutes >= 2);

  const month = new Date().toISOString().slice(0, 7);
  const summary = await getTenantBillingSummary("tenantA", month);
  assert.ok(summary.overageMinutes >= 1);
  assert.ok(summary.estimatedOverageChargeCents >= 50);
});

test("tenant B isolation at data layer", async (t) => {
  if (!dbReady) return t.skip("postgres unavailable in test environment");
  await upsertTenantLimits("tenantB", { planTier: "starter", includedMonthlyMinutes: 999 }, "test-admin");
  const a = await getTenantLimits("tenantA");
  const b = await getTenantLimits("tenantB");
  assert.notEqual(a.planTier, b.planTier);
  assert.notEqual(a.includedMonthlyMinutes, b.includedMonthlyMinutes);
});

test("reset defaults and billing status", async (t) => {
  if (!dbReady) return t.skip("postgres unavailable in test environment");
  const reset = await resetTenantLimitsToPlanDefaults("tenantA", "professional", "test-admin");
  assert.equal(reset.planTier, "professional");
  const updated = await setTenantBillingStatus("tenantA", "past_due", "test-admin");
  assert.equal(updated.billingStatus, "past_due");
});

test("close shared db pool", async () => {
  await closePool().catch(() => {});
});
