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

test("aggregateCallRowsToAnalytics fills daily, hour, intent, and outcome series", () => {
  const now = new Date("2026-09-07T15:00:00Z");
  const s = aggregateCallRowsToAnalytics(
    [
      {
        stage: "booked",
        lead: { stage: "booked", completion: "booked" },
        history: [{ role: "user", content: "Can I book Tuesday?" }],
        created_at: "2026-09-06T15:30:00Z",
      },
      {
        stage: "missed",
        lead: {},
        history: [],
        created_at: "2026-09-06T08:00:00Z",
      },
    ],
    10,
    { days: 7, now },
  );
  assert.equal(s.totals.calls, 2);
  assert.equal(s.totals.missedCalls, 1);
  assert.equal(s.totals.booked, 1);
  assert.ok(s.daily.some((d) => d.date === "2026-09-06" && d.calls === 2 && d.missed === 1));
  assert.ok(s.byHour[15].calls >= 1);
  assert.ok(s.intents.some((i) => i.intent.includes("book tuesday")));
  assert.ok(s.outcomes.some((o) => o.outcome === "booked"));
  assert.ok(s.leadStages.some((st) => st.stage === "booked"));
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
