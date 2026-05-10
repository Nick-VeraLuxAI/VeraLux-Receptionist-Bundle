const test = require("node:test");
const assert = require("node:assert/strict");
const {
  businessHoursSchema,
  evaluateBusinessHours,
  voiceReplyFromBusinessHours,
} = require("../dist/businessHours.js");

test("businessHoursSchema rejects invalid timezone empty", () => {
  const r = businessHoursSchema.safeParse({ timezone: "", weekly: {} });
  assert.equal(r.success, false);
});

test("evaluateBusinessHours falls back when config missing", () => {
  const ev = evaluateBusinessHours({});
  assert.equal(ev.isOpen, false);
  assert.match(ev.summary, /not configured|invalid/i);
});

test("evaluateBusinessHours open inside window (fixed instant)", () => {
  const cfg = {
    timezone: "UTC",
    weekly: {
      mon: { closed: true },
      tue: { closed: true },
      wed: { closed: true },
      thu: { closed: true },
      fri: { closed: true },
      sat: { closed: true },
      sun: { open: "10:00", close: "16:00" },
    },
  };
  const now = new Date("2026-05-10T12:00:00Z");
  const ev = evaluateBusinessHours(cfg, now);
  assert.equal(ev.isOpen, true);
});

test("evaluateBusinessHours closed outside window", () => {
  const cfg = {
    timezone: "UTC",
    weekly: {
      mon: { open: "09:00", close: "12:00" },
      tue: { closed: true },
      wed: { closed: true },
      thu: { closed: true },
      fri: { closed: true },
      sat: { closed: true },
      sun: { closed: true },
    },
  };
  const now = new Date("2026-05-11T15:00:00Z");
  const ev = evaluateBusinessHours(cfg, now);
  assert.equal(ev.isOpen, false);
});

test("voiceReplyFromBusinessHours null for non-hours utterance", () => {
  const cfg = {
    timezone: "UTC",
    weekly: {
      mon: { open: "09:00", close: "17:00" },
      tue: { open: "09:00", close: "17:00" },
      wed: { open: "09:00", close: "17:00" },
      thu: { open: "09:00", close: "17:00" },
      fri: { open: "09:00", close: "17:00" },
      sat: { closed: true },
      sun: { closed: true },
    },
  };
  const now = new Date("2026-05-11T14:00:00Z");
  assert.equal(voiceReplyFromBusinessHours("what is your price", cfg, now), null);
});

test("voiceReplyFromBusinessHours close time uses tenant schedule", () => {
  const cfg = {
    timezone: "UTC",
    weekly: {
      mon: { open: "09:00", close: "17:00" },
      tue: { open: "09:00", close: "17:00" },
      wed: { open: "09:00", close: "17:00" },
      thu: { open: "09:00", close: "17:00" },
      fri: { open: "09:00", close: "17:00" },
      sat: { closed: true },
      sun: { closed: true },
    },
  };
  const now = new Date("2026-05-11T14:00:00Z");
  const r = voiceReplyFromBusinessHours("When do you close?", cfg, now);
  assert.ok(r && /close at 5 PM/i.test(r), `expected close reply, got ${r}`);
});

test("voiceReplyFromBusinessHours closed day", () => {
  const cfg = {
    timezone: "UTC",
    weekly: {
      mon: { open: "09:00", close: "17:00" },
      tue: { closed: true },
      wed: { closed: true },
      thu: { closed: true },
      fri: { closed: true },
      sat: { closed: true },
      sun: { closed: true },
    },
    afterHoursMessage: "Leave a message.",
  };
  const now = new Date("2026-05-10T14:00:00Z");
  const r = voiceReplyFromBusinessHours("When do you close?", cfg, now);
  assert.ok(r && /closed today/i.test(r), r);
  assert.ok(r && /message/i.test(r), r);
});
