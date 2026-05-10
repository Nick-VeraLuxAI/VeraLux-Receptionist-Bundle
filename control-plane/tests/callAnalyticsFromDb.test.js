const test = require("node:test");
const assert = require("node:assert/strict");
const { aggregateCallRowsToAnalytics } = require("../dist/callAnalyticsFromDb.js");

test("aggregateCallRowsToAnalytics counts calls and caller messages from persisted shape", () => {
  const rows = [
    {
      stage: "end",
      lead: {},
      history: [
        { role: "user", content: "When do you open?" },
        { role: "assistant", content: "Nine AM." },
      ],
    },
    {
      stage: "end",
      lead: {},
      history: [],
    },
  ];
  const s = aggregateCallRowsToAnalytics(rows);
  assert.equal(s.totalCalls, 2);
  assert.equal(s.totalCallerMessages, 1);
  assert.equal(s.callCount, 2);
  assert.equal(s.callerMessageCount, 1);
  assert.equal(s.missedCalls, 0);
  assert.equal(s.answeredCalls, 2);
  assert.ok(s.topQuestions.length >= 1);
});

test("aggregateCallRowsToAnalytics marks missed calls from stage", () => {
  const rows = [
    { stage: "end", lead: {}, history: [] },
    { stage: "missed", lead: {}, history: [] },
  ];
  const s = aggregateCallRowsToAnalytics(rows);
  assert.equal(s.totalCalls, 2);
  assert.equal(s.missedCalls, 1);
  assert.equal(s.answeredCalls, 1);
});

test("aggregateCallRowsToAnalytics accepts legacy from/message history items", () => {
  const rows = [
    {
      stage: "end",
      lead: {},
      history: [{ from: "caller", message: "Hello there" }],
    },
  ];
  const s = aggregateCallRowsToAnalytics(rows);
  assert.equal(s.totalCalls, 1);
  assert.equal(s.totalCallerMessages, 1);
});

test("aggregateCallRowsToAnalytics tenant isolation is caller responsibility (no cross rows)", () => {
  const a = aggregateCallRowsToAnalytics([{ stage: "end", lead: {}, history: [] }]);
  const b = aggregateCallRowsToAnalytics([
    { stage: "end", lead: {}, history: [] },
    { stage: "end", lead: {}, history: [] },
  ]);
  assert.equal(a.totalCalls, 1);
  assert.equal(b.totalCalls, 2);
});
