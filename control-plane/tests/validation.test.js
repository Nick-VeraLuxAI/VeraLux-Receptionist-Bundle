"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { isUuid, sanitizeCallControlId } = require("../dist/utils/validation.js");

test("isUuid accepts valid UUIDs", () => {
  assert.equal(isUuid("550e8400-e29b-41d4-a716-446655440000"), true);
  assert.equal(isUuid("6ba7b810-9dad-11d1-80b4-00c04fd430c8"), true);
  assert.equal(isUuid(" 550e8400-e29b-41d4-a716-446655440000 "), true);
});

test("isUuid rejects non-UUID strings", () => {
  assert.equal(isUuid(""), false);
  assert.equal(isUuid("not-a-uuid"), false);
  assert.equal(isUuid("550e8400-e29b-41d4-a716"), false);
  assert.equal(isUuid("550e8400-e29b-41d4-a716-446655440000-extra"), false);
  assert.equal(isUuid("550e8400e29b41d4a716446655440000"), false);
});

test("isUuid rejects non-strings", () => {
  assert.equal(isUuid(null), false);
  assert.equal(isUuid(undefined), false);
  assert.equal(isUuid(123), false);
});

test("sanitizeCallControlId accepts Telnyx v3 ids", () => {
  const id = "v3:YGHT2f6J9kLmN0pQrStuVwXyZ_abc-123";
  assert.equal(sanitizeCallControlId(id), id);
  assert.equal(sanitizeCallControlId(` ${id} `), id);
});

test("sanitizeCallControlId rejects injection and empty values", () => {
  assert.equal(sanitizeCallControlId(""), null);
  assert.equal(sanitizeCallControlId("id with space"), null);
  assert.equal(sanitizeCallControlId("id'; drop table x; --"), null);
  assert.equal(sanitizeCallControlId(null), null);
  assert.equal(sanitizeCallControlId("a".repeat(257)), null);
});
