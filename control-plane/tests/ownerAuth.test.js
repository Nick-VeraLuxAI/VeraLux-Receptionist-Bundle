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

test("owner email change requires current password and rejects taken emails", async () => {
  const { hashPortalPassword } = require("../dist/portalPassword.js");
  const originalCred = db.getOwnerPortalCredentialRow;
  const originalUpsertCred = db.upsertOwnerPortalCredentials;
  const originalByEmail = db.getTenantIdByPortalEmail;
  const originalUser = db.upsertUserBySub;
  let stored = {
    emailNorm: "owner@shop.test",
    passwordHash: hashPortalPassword("current-pass"),
  };
  db.getOwnerPortalCredentialRow = async () => stored;
  db.getTenantIdByPortalEmail = async (email) =>
    email === "taken@shop.test" ? "other-tenant" : null;
  db.upsertOwnerPortalCredentials = async (params) => {
    stored = { emailNorm: params.emailNorm, passwordHash: params.passwordHash };
  };
  db.upsertUserBySub = async () => ({ id: "u1", email: stored.emailNorm, idp_sub: "owner:t1" });
  try {
    const badPw = await ownerAuth.changeOwnerPortalEmailIfValid(
      "t1",
      "wrong",
      "new@shop.test"
    );
    assert.equal(badPw.ok, false);
    assert.equal(badPw.error, "invalid_current");

    const taken = await ownerAuth.changeOwnerPortalEmailIfValid(
      "t1",
      "current-pass",
      "taken@shop.test"
    );
    assert.equal(taken.ok, false);
    assert.equal(taken.error, "email_already_registered");

    const ok = await ownerAuth.changeOwnerPortalEmailIfValid(
      "t1",
      "current-pass",
      "new@shop.test"
    );
    assert.equal(ok.ok, true);
    assert.equal(ok.email, "new@shop.test");
    assert.equal(stored.emailNorm, "new@shop.test");
  } finally {
    db.getOwnerPortalCredentialRow = originalCred;
    db.upsertOwnerPortalCredentials = originalUpsertCred;
    db.getTenantIdByPortalEmail = originalByEmail;
    db.upsertUserBySub = originalUser;
  }
});

test.after(() => {
  db.getOwnerPasscodeHash = originalGetOwnerPasscodeHash;
  db.upsertOwnerPasscode = originalUpsertOwnerPasscode;
});
