const test = require("node:test");
const assert = require("node:assert/strict");
const {
  maskCallerId,
  summarizeHistory,
  isMissedCallRow,
  normalizeHistoryForAdminUi,
} = require("../dist/callSanitizer.js");

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

test("normalizeHistoryForAdminUi maps runtime turns to admin UI shape", () => {
  const out = normalizeHistoryForAdminUi([
    { role: "caller", content: "What are your hours?" },
    { role: "assistant", content: "We open at nine." },
  ]);
  assert.equal(out.length, 2);
  assert.equal(out[0].from, "caller");
  assert.equal(out[0].message, "What are your hours?");
  assert.equal(out[1].from, "assistant");
});
