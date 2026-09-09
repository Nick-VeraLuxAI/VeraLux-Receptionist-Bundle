const test = require("node:test");
const assert = require("node:assert/strict");
const {
  maskCallerId,
  summarizeHistory,
  isMissedCallRow,
  normalizeHistoryForAdminUi,
  presentAdminCall,
  dedupeCallHistoryRows,
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

test("presentAdminCall maps a persisted row for the admin list", () => {
  const presented = presentAdminCall(
    {
      id: "11111111-1111-4111-8111-111111111111",
      tenant_id: "demo-shop",
      caller_id: "+15551234567",
      stage: "end",
      lead: { voiceCallControlId: "cc-1", durationMs: 45000 },
      history: [{ role: "caller", content: "Can I book an oil change?" }],
      created_at: "2026-09-08T12:00:00.000Z",
      updated_at: "2026-09-08T12:01:00.000Z",
    },
    null,
    { includeRecording: false },
  );
  assert.equal(presented.stage, "ended");
  assert.equal(presented.callerId, "+15551234567");
  assert.match(presented.transcriptSummary, /oil change/);
  assert.equal(presented.recordingUrl, null);
  assert.equal(presented.callQuality, null);
});

test("presentAdminCall maps stored qualityStatus onto the Quality column", () => {
  const presented = presentAdminCall(
    {
      id: "11111111-1111-4111-8111-111111111111",
      tenant_id: "demo-shop",
      caller_id: "+15551234567",
      stage: "end",
      lead: { voiceCallControlId: "v3:abc", durationMs: 45000 },
      history: [],
      created_at: "2026-09-08T12:00:00.000Z",
      updated_at: "2026-09-08T12:01:00.000Z",
    },
    {
      qualityStatus: "good",
      avgLlmLatencyMs: 420,
      interruptionDetected: false,
      transcriptQuality: "good",
    },
  );
  assert.equal(presented.callQuality.score, 5);
  assert.equal(presented.callQuality.latencyMs, 420);
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

test("dedupeCallHistoryRows hides greeting stubs paired with an ended call", () => {
  const rows = [
    {
      id: "ended",
      caller_id: "+12086251175",
      stage: "end",
      lead: { voiceCallControlId: "v3:abc" },
      history: [{ role: "caller", content: "hi" }],
      created_at: "2026-09-09T02:17:15.000Z",
    },
    {
      id: "stub",
      caller_id: "+12086251175",
      stage: "greeting",
      lead: {},
      history: [],
      created_at: "2026-09-09T02:15:52.000Z",
    },
    {
      id: "live",
      caller_id: "+15550001111",
      stage: "greeting",
      lead: {},
      history: [],
      created_at: "2026-09-09T03:00:00.000Z",
    },
  ];
  const out = dedupeCallHistoryRows(rows);
  assert.deepEqual(out.map((r) => r.id), ["ended", "live"]);
});
