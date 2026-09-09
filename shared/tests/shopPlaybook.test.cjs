const test = require("node:test");
const assert = require("node:assert/strict");
const {
  evaluateShopAction,
  forwardingProfilesToTransferProfiles,
  mergeTransferProfiles,
  inferCompletionFromText,
  emptyPromise,
  extractQuoteCents,
  normalizeShopPlaybook,
  shopPlaybookRuntimeSchema,
  CUTOVER_ITEM_IDS,
} = require("../dist/shopPlaybook.js");

test("refuses out of area zip", () => {
  const r = evaluateShopAction(
    { serviceArea: { zips: ["99201"], cities: [] } },
    { intent: "book", zip: "10001" },
  );
  assert.equal(r.decision, "refuse");
  assert.equal(r.completion, "refused");
});

test("holds large quotes", () => {
  const r = evaluateShopAction({ quoteHoldCents: 250000 }, { intent: "quote", quoteCents: 400000 });
  assert.equal(r.decision, "hold");
  assert.equal(r.completion, "approval_held");
});

test("escalates gas emergency", () => {
  const r = evaluateShopAction({ onCallE164: "+15095550100" }, { intent: "other", utterance: "I smell gas" });
  assert.equal(r.decision, "escalate");
  assert.equal(r.completion, "on_call_paged");
});

test("maps emergency forwarding line to oncall transfer", () => {
  const mapped = forwardingProfilesToTransferProfiles([
    { name: "Nick", number: "+15095550100", role: "on-call emergency" },
  ]);
  assert.equal(mapped[0].id, "oncall");
  assert.equal(mapped[0].destination, "+15095550100");
  assert.ok(mapped[0].timeoutSecs >= 60);
});

test("removing forwarding removes stale executable on-call profile", () => {
  const merged = mergeTransferProfiles([], [
    {
      id: "oncall",
      responsibilities: ["on-call"],
      destination: "+15095550100",
    },
  ]);
  assert.deepEqual(merged, []);
});

test("empty promise detector", () => {
  assert.equal(emptyPromise("I'll have someone follow up tomorrow"), true);
  assert.equal(emptyPromise("You are booked Tuesday at 2 PM"), false);
});

test("infer booked from confirm speak", () => {
  assert.equal(inferCompletionFromText("I've booked you for Monday at 2 PM"), "booked");
});

test("normalize clamps timeout", () => {
  const p = normalizeShopPlaybook({ onCallTimeoutSecs: 9000 });
  assert.equal(p.onCallTimeoutSecs, 90);
});

test("storm mode holds books", () => {
  const r = evaluateShopAction({ stormMode: { enabled: true } }, { intent: "book" });
  assert.equal(r.decision, "hold");
  assert.equal(r.completion, "approval_held");
});

test("human overflow after emergency check", () => {
  const r = evaluateShopAction(
    { humanOverflowE164: "+15095550999" },
    { intent: "other", utterance: "I want to speak to a manager about a complaint" },
  );
  assert.equal(r.decision, "escalate");
  assert.equal(r.reason, "human_overflow");
});

test("gas still wins over overflow wording", () => {
  const r = evaluateShopAction(
    { onCallE164: "+15095550100", humanOverflowE164: "+15095550999" },
    { intent: "other", utterance: "I smell gas, get me a manager" },
  );
  assert.equal(r.reason, "emergency_keyword");
});

test("refuse-list terminal is refused, not an unwritten callback task", () => {
  const r = evaluateShopAction(
    { refuseServices: ["well drilling"] },
    { intent: "book", utterance: "I need well drilling" },
  );
  assert.equal(r.decision, "refuse");
  assert.equal(r.completion, "refused");
});

test("after-hours fee is returned from configured shop law", () => {
  const r = evaluateShopAction(
    { afterHoursFeeCents: 9900 },
    { intent: "book", afterHours: true },
  );
  assert.equal(r.appliedAfterHoursFeeCents, 9900);
});

test("radius-only booking holds when distance is unverified", () => {
  const r = evaluateShopAction(
    { serviceArea: { zips: [], cities: [], radiusMiles: 25 } },
    { intent: "book", zip: "99201" },
  );
  assert.equal(r.decision, "hold");
  assert.equal(r.reason, "distance_unverified");
});

test("radius booking refuses a measured out-of-area address", () => {
  const r = evaluateShopAction(
    { serviceArea: { zips: [], cities: [], radiusMiles: 25 } },
    { intent: "book", distanceMiles: 40 },
  );
  assert.equal(r.decision, "refuse");
  assert.equal(r.reason, "out_of_area");
});

test("runtime schema upgrades an older partial playbook", () => {
  const parsed = shopPlaybookRuntimeSchema.parse({
    quoteHoldCents: 500000,
    stormMode: { enabled: false },
  });
  assert.equal(parsed.quoteHoldCents, 500000);
  assert.deepEqual(parsed.digest.emails, []);
  assert.equal(parsed.onCallTimeoutSecs, 75);
});

test("quote parser handles STT currency phrasing", () => {
  assert.equal(extractQuoteCents("the quote is 5000 dollars"), 500000);
  assert.equal(extractQuoteCents("about five thousand dollars"), 500000);
  assert.equal(extractQuoteCents("roughly twenty five hundred bucks"), 250000);
  assert.equal(extractQuoteCents("that will be ten grand"), 1000000);
});

test("cutover includes day-desk rows", () => {
  for (const id of ["faq_hours", "transfer_or_message", "existing_cid", "quote_or_hold"]) {
    assert.ok(CUTOVER_ITEM_IDS.includes(id), id);
  }
});
