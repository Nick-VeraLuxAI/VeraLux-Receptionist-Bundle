const test = require("node:test");
const assert = require("node:assert/strict");

const {
  tenantLimitsSchema,
  PLAN_DEFAULTS,
  RECOMMENDED_DEFAULT_PLAN_TIER,
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

