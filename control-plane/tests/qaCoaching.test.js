"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { presentQaScore } = require("../dist/nightDesk/qa.js");

const allPass = {
  terminalPersisted: true,
  orphanPromiseZero: true,
  noUnwrittenPromise: true,
  bookedClaimBackedByWrite: true,
  emergencyEscalated: true,
  noUnverifiedPrice: true,
};

test("clean booked call explains the job instead of dumping rubric keys", () => {
  const card = presentQaScore({
    id: "1",
    call_id: "v3:GG2vcr3L93KWbHQL",
    created_at: "2026-09-06T20:00:00Z",
    score: 100,
    rubric: allPass,
    completion: "booked",
    booked_cents: 18900,
    caller_name: "Nick DeSantis",
    issue: "drain clearing",
    history: [{ role: "user", content: "Can you come Tuesday?" }],
  });
  assert.equal(card.needsReview, false);
  assert.equal(card.callerDisplay, "Nick DeSantis");
  assert.match(card.headline, /Booked \$189/);
  assert.match(card.headline, /drain clearing/);
  assert.equal(card.nextAction, null);
  assert.equal(card.outcomeLabel, "Booked");
  assert.ok(card.findings.every((f) => f.label && !f.label.includes("noUnverified")));
  assert.ok(!card.headline.includes("noUnverifiedPrice"));
});

test("failed price check tells the owner what to do", () => {
  const card = presentQaScore({
    id: "2",
    call_id: "v3:abc",
    score: 83,
    rubric: { ...allPass, noUnverifiedPrice: false },
    completion: "tasked",
    caller_id: "+12086251175",
    issue: "no heat",
  });
  assert.equal(card.needsReview, true);
  assert.match(card.headline, /dollar amount/i);
  assert.match(card.nextAction, /Listen for the number/);
  const fail = card.findings.find((f) => f.key === "noUnverifiedPrice");
  assert.equal(fail.passed, false);
  assert.equal(fail.label, "Price from the book");
});
