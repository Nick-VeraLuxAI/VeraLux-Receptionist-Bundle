"use strict";

process.env.SECRET_ENCRYPTION_KEY =
  process.env.SECRET_ENCRYPTION_KEY || "test-secret-encryption-key-32bytes-minimum";

const test = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { closePool, pool, runMigrations } = require("../dist/db.js");
const {
  getCallCompletion,
  getShopPlaybookRow,
  listCompletionEvents,
  createOncallPage,
  upsertCallCompletion,
  upsertShopPlaybook,
} = require("../dist/nightDesk/db.js");
const {
  finalizeCallCompletion,
} = require("../dist/nightDesk/complete.js");
const {
  rotationSlotMatches,
} = require("../dist/nightDesk/oncallResolve.js");
const {
  processNightDeskTurn,
} = require("../dist/nightDesk/evaluate.js");
const {
  sweepDueOncallPages,
} = require("../dist/nightDesk/oncallWorker.js");

const tenantId = `night-desk-test-${randomUUID()}`;
let dbAvailable = false;

test("overnight on-call slots cover both sides of midnight", () => {
  const slot = {
    weekday: 6,
    start_hhmm: "17:00",
    end_hhmm: "07:00",
  };
  assert.equal(rotationSlotMatches(slot, 6, "23:30"), true);
  assert.equal(rotationSlotMatches(slot, 0, "02:30"), true);
  assert.equal(rotationSlotMatches(slot, 0, "08:00"), false);
});

test("night desk database setup", async (t) => {
  try {
    await runMigrations();
    await pool.query(
      "INSERT INTO tenants (id, name) VALUES ($1, $2) ON CONFLICT DO NOTHING",
      [tenantId, "Night Desk Test"],
    );
    dbAvailable = true;
  } catch (error) {
    t.skip(`postgres unavailable: ${error.message}`);
  }
});

test("playbook versions are persisted", async (t) => {
  if (!dbAvailable) return t.skip("postgres unavailable");
  const first = await upsertShopPlaybook(
    tenantId,
    {
      version: 1,
      vertical: "plumbing",
      serviceArea: { zips: ["99201"], cities: [] },
      afterHoursFeeCents: 9900,
      refuseServices: ["well drilling"],
      quoteHoldCents: 250000,
      emergencyKeywords: ["gas leak"],
      membershipNames: ["Comfort Club"],
      onCallTimeoutSecs: 75,
      digest: { emails: [] },
      stormMode: { enabled: false, parallelAnswerCap: 2 },
    },
    "test",
  );
  const second = await upsertShopPlaybook(
    tenantId,
    first.playbook,
    "test",
  );
  assert.equal(second.version, first.version + 1);
  assert.equal((await getShopPlaybookRow(tenantId)).version, second.version);
});

test("hangup without terminal creates a durable task and zero orphan", async (t) => {
  if (!dbAvailable) return t.skip("postgres unavailable");
  const callId = `call-${randomUUID()}`;
  const result = await finalizeCallCompletion({
    tenantId,
    callId,
    callerId: "+15095550100",
    transcript: "assistant: Someone will call you tomorrow.",
    lead: { name: "Test Caller", issue: "No heat" },
  });
  assert.equal(result.completion, "tasked");
  assert.equal(result.orphan, false);
  const stored = await getCallCompletion(tenantId, callId);
  assert.equal(stored.completion, "tasked");
  assert.equal(stored.orphan_promise, false);
  const events = await listCompletionEvents(tenantId);
  assert.ok(events.some((event) => event.call_id === callId));
});

test("mid-call gate refuses before a booked claim can be spoken", async (t) => {
  if (!dbAvailable) return t.skip("postgres unavailable");
  const callId = `call-${randomUUID()}`;
  const result = await processNightDeskTurn({
    tenantId,
    callId,
    callerId: "+15095550100",
    utterance: "Please come to 10001",
    proposedReply: "I've booked you for Tuesday.",
    lead: {
      name: "Test Caller",
      address: "100 Main St, New York, NY 10001",
      jobType: "Drain clearing",
      zip: "10001",
    },
  });
  assert.equal(result.completion, "refused");
  assert.match(result.text, /do not service/i);
  assert.equal(
    (await getCallCompletion(tenantId, callId)).completion,
    "refused",
  );
});

test("demo intake books without a service address", async (t) => {
  if (!dbAvailable) return t.skip("postgres unavailable");
  const callId = `call-${randomUUID()}`;
  const result = await processNightDeskTurn({
    tenantId,
    callId,
    callerId: "+15095550100",
    utterance: "Book Tuesday at noon",
    proposedReply: "You're booked for Tuesday at noon.",
    lead: {
      name: "Nick",
      phone: "2086251175",
      startIso: "2026-09-08T12:00:00-07:00",
      intakeProfile: { kind: "demo", writer: "gcal", timezone: "America/Los_Angeles" },
      bookingAdapter: "gcal_helper",
    },
  });
  assert.equal(result.completion, "booked");
  assert.equal(result.reason, "demo_shop_gcal_write_succeeded");
});

test("claimed booked without FSM write becomes a task", async (t) => {
  if (!dbAvailable) return t.skip("postgres unavailable");
  const callId = `call-${randomUUID()}`;
  const result = await finalizeCallCompletion({
    tenantId,
    callId,
    callerId: "+15095550101",
    transcript: "assistant: I've booked you for Tuesday.",
    lead: {
      name: "Test Caller",
      address: "100 Main St, Spokane, WA 99201",
      jobType: "Drain clearing",
    },
    claimed: "booked",
  });
  assert.equal(result.completion, "tasked");
  assert.equal(
    (await getCallCompletion(tenantId, callId)).completion,
    "tasked",
  );
});

test("expired on-call page becomes a durable fallback task", async (t) => {
  if (!dbAvailable) return t.skip("postgres unavailable");
  const callId = `call-${randomUUID()}`;
  await upsertCallCompletion({
    tenantId,
    callId,
    completion: "on_call_paged",
    reason: "emergency_keyword",
    input: { name: "Test Caller", phone: "+15555550123" },
  });
  await createOncallPage({
    tenantId,
    callId,
    destinationE164: "+15555550124",
    timeoutSecs: 60,
  });
  await pool.query(
    "UPDATE oncall_pages SET deadline_at = now() - interval '1 second' WHERE tenant_id = $1 AND call_id = $2",
    [tenantId, callId],
  );
  assert.equal(await sweepDueOncallPages(), 1);
  assert.equal(
    (await getCallCompletion(tenantId, callId)).completion,
    "tasked",
  );
});

test("night desk cleanup", async () => {
  if (dbAvailable) {
    await pool.query("DELETE FROM tenants WHERE id = $1", [tenantId]);
  }
  await closePool();
});
