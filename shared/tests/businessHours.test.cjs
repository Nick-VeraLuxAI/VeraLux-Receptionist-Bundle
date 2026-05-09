const test = require("node:test");
const assert = require("node:assert/strict");
const {
  businessHoursSchema,
  evaluateBusinessHours,
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
