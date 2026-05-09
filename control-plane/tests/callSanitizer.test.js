const test = require("node:test");
const assert = require("node:assert/strict");
const { maskCallerId, summarizeHistory, isMissedCallRow } = require("../dist/callSanitizer.js");

test("maskCallerId redacts to last four", () => {
  assert.equal(maskCallerId("+15551234567"), "••••••4567");
  assert.equal(maskCallerId(null), "Unknown");
});

test("summarizeHistory clips roles and length", () => {
  const hist = [
    { role: "user", message: "Hello there" },
    { role: "assistant", message: "Hi! How can I help?" },
  ];
  const s = summarizeHistory(hist, 200);
  assert.match(s, /user:/);
  assert.match(s, /assistant:/);
});

test("isMissedCallRow detects stage and lead", () => {
  assert.equal(isMissedCallRow({ stage: "missed", lead: {} }), true);
  assert.equal(isMissedCallRow({ stage: "completed", lead: { missed: true } }), true);
  assert.equal(isMissedCallRow({ stage: "completed", lead: {} }), false);
});
