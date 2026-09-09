"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");

const db = require("../dist/db.js");
const { hashPortalPassword } = require("../dist/portalPassword.js");
const consoleAuth = require("../dist/consoleAuth.js");

const originalGet = db.getConsoleCredentialRow;
const originalUpsert = db.upsertConsoleCredentials;
const originalOwnerEmail = db.getTenantIdByPortalEmail;

function saveEnv(keys) {
  const saved = {};
  for (const k of keys) {
    if (process.env[k] !== undefined) saved[k] = process.env[k];
  }
  return saved;
}

function restoreEnv(saved, keys) {
  for (const k of keys) {
    if (saved[k] !== undefined) process.env[k] = saved[k];
    else delete process.env[k];
  }
}

const ENV_KEYS = [
  "INSTALLER_USERNAME",
  "INSTALLER_PASSWORD",
  "ADMIN_CONSOLE_EMAIL",
  "ADMIN_API_KEY",
];

test("env bootstrap login accepts ADMIN_CONSOLE_EMAIL", async () => {
  const saved = saveEnv(ENV_KEYS);
  process.env.INSTALLER_PASSWORD = "bootstrap-secret-1";
  process.env.ADMIN_CONSOLE_EMAIL = "ops@veralux.ai";
  delete process.env.ADMIN_API_KEY;
  db.getConsoleCredentialRow = async () => null;
  try {
    const ok = await consoleAuth.verifyConsoleLogin("ops@veralux.ai", "bootstrap-secret-1");
    assert.equal(ok.ok, true);
    assert.equal(ok.source, "environment");
    const bad = await consoleAuth.verifyConsoleLogin("ops@veralux.ai", "wrong");
    assert.equal(bad.ok, false);
  } finally {
    restoreEnv(saved, ENV_KEYS);
    db.getConsoleCredentialRow = originalGet;
  }
});

test("database credentials win for the saved email", async () => {
  const saved = saveEnv(ENV_KEYS);
  process.env.INSTALLER_PASSWORD = "old-env-password";
  process.env.ADMIN_CONSOLE_EMAIL = "ops@veralux.ai";
  const row = {
    emailNorm: "ops@veralux.ai",
    passwordHash: hashPortalPassword("new-db-password"),
    updatedAt: new Date().toISOString(),
  };
  db.getConsoleCredentialRow = async () => row;
  try {
    const envRejected = await consoleAuth.verifyConsoleLogin("ops@veralux.ai", "old-env-password");
    assert.equal(envRejected.ok, false);
    const dbOk = await consoleAuth.verifyConsoleLogin("ops@veralux.ai", "new-db-password");
    assert.equal(dbOk.ok, true);
    assert.equal(dbOk.source, "database");
  } finally {
    restoreEnv(saved, ENV_KEYS);
    db.getConsoleCredentialRow = originalGet;
  }
});

test("changeConsoleCredentials persists a hashed password and requires current", async () => {
  const saved = saveEnv(ENV_KEYS);
  process.env.INSTALLER_PASSWORD = "bootstrap-secret-1";
  process.env.ADMIN_CONSOLE_EMAIL = "ops@veralux.ai";
  delete process.env.ADMIN_API_KEY;
  db.getConsoleCredentialRow = async () => null;
  db.getTenantIdByPortalEmail = async () => null;
  let stored = null;
  db.upsertConsoleCredentials = async (params) => {
    stored = params;
  };
  try {
    const denied = await consoleAuth.changeConsoleCredentials({
      currentPassword: "nope",
      newPassword: "replacement-password",
      email: "ops@veralux.ai",
    });
    assert.equal(denied.ok, false);
    assert.equal(denied.error, "invalid_current_password");

    const changed = await consoleAuth.changeConsoleCredentials({
      currentPassword: "bootstrap-secret-1",
      newPassword: "replacement-password",
      email: "ops@veralux.ai",
    });
    assert.equal(changed.ok, true);
    assert.equal(changed.email, "ops@veralux.ai");
    assert.ok(stored);
    assert.match(stored.passwordHash, /^scrypt\$/);
    assert.notEqual(stored.passwordHash, "replacement-password");
  } finally {
    restoreEnv(saved, ENV_KEYS);
    db.getConsoleCredentialRow = originalGet;
    db.upsertConsoleCredentials = originalUpsert;
    db.getTenantIdByPortalEmail = originalOwnerEmail;
  }
});

test("describeConsoleAccount reports environment until a row exists", async () => {
  const saved = saveEnv(ENV_KEYS);
  process.env.ADMIN_CONSOLE_EMAIL = "ops@veralux.ai";
  db.getConsoleCredentialRow = async () => null;
  try {
    const snap = await consoleAuth.describeConsoleAccount();
    assert.equal(snap.email, "ops@veralux.ai");
    assert.equal(snap.source, "environment");
    assert.equal(snap.emailIsPlaceholder, false);
  } finally {
    restoreEnv(saved, ENV_KEYS);
    db.getConsoleCredentialRow = originalGet;
  }
});

test.after(() => {
  db.getConsoleCredentialRow = originalGet;
  db.upsertConsoleCredentials = originalUpsert;
  db.getTenantIdByPortalEmail = originalOwnerEmail;
});
