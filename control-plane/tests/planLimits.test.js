const test = require("node:test");
const assert = require("node:assert/strict");

const {
  tenantLimitsSchema,
  PLAN_DEFAULTS,
  PLAN_TIER_IDS,
  RECOMMENDED_DEFAULT_PLAN_TIER,
  listPlanDefaultsPayload,
} = require("../dist/planLimits.js");

test("recommended default plan is professional", () => {
  assert.equal(RECOMMENDED_DEFAULT_PLAN_TIER, "professional");
});

test("all plan defaults validate against tenant limits schema", () => {
  for (const tier of Object.keys(PLAN_DEFAULTS)) {
    const parsed = tenantLimitsSchema.safeParse(PLAN_DEFAULTS[tier]);
    assert.equal(parsed.success, true, `default plan invalid: ${tier}`);
  }
});

test("pilot is a first-class reset-to-defaults tier", () => {
  assert.ok(PLAN_TIER_IDS.includes("pilot"));
  assert.equal(PLAN_DEFAULTS.pilot.planName, "Pilot");
  const payload = listPlanDefaultsPayload();
  assert.equal(payload.defaults.professional.maxConcurrentCalls, 3);
  assert.equal(payload.defaults.pilot.includedMonthlyMinutes, 1200);
  assert.equal(payload.defaults.professional.monthlyMinuteOverageRateCents, 35);
});

