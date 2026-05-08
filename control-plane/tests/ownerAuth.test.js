"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

const ownerAuth = require("../dist/ownerAuth.js");
const db = require("../dist/db.js");

const originalGetOwnerPasscodeHash = db.getOwnerPasscodeHash;
const originalUpsertOwnerPasscode = db.upsertOwnerPasscode;

function legacyHash(passcode) {
  return crypto.createHash("sha256").update(passcode.trim()).digest("hex");
}

test("legacy sha256 passcodes verify and migrate to modern hash", async () => {
  let stored = legacyHash("1234");
  db.getOwnerPasscodeHash = async () => stored;
  db.upsertOwnerPasscode = async (_tenantId, nextHash) => {
    stored = nextHash;
  };

  const first = await ownerAuth.verifyOwnerPasscode("tenant-1", "1234");
  const second = await ownerAuth.verifyOwnerPasscode("tenant-1", "1234");

  assert.equal(first, true);
  assert.equal(second, true);
  assert.notEqual(stored, legacyHash("1234"));
  assert.match(stored, /^\$(argon2id|2[aby])\$/);
});

test("malformed passcode hashes are rejected", async () => {
  db.getOwnerPasscodeHash = async () => "not-a-real-hash";
  db.upsertOwnerPasscode = async () => {};

  const ok = await ownerAuth.verifyOwnerPasscode("tenant-2", "1234");
  assert.equal(ok, false);
});

test("legacy mismatch comparisons reject safely", async () => {
  const storedLegacy = legacyHash("9876");
  db.getOwnerPasscodeHash = async () => storedLegacy;
  db.upsertOwnerPasscode = async () => {};

  const wrongSameLen = await ownerAuth.verifyOwnerPasscode("tenant-3", "1234");
  const wrongDifferentLen = await ownerAuth.verifyOwnerPasscode("tenant-3", "");

  assert.equal(wrongSameLen, false);
  assert.equal(wrongDifferentLen, false);
});

test.after(() => {
  db.getOwnerPasscodeHash = originalGetOwnerPasscodeHash;
  db.upsertOwnerPasscode = originalUpsertOwnerPasscode;
});
