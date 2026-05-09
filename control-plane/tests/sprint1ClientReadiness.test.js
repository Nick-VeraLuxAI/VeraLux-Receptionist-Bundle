const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

process.env.DATABASE_URL =
  process.env.DATABASE_URL || "postgres://veralux_test:veralux_test@127.0.0.1:55432/veralux_test";

const {
  pingPool,
  runMigrations,
  upsertTenant,
  listCallsForTenantDb,
  getCallByIdForTenantDb,
  pool,
  closePool,
} = require("../dist/db.js");

let dbReady = false;

test("sprint1 setup (db)", async (t) => {
  dbReady = await pingPool();
  if (!dbReady) return t.skip("postgres unavailable in test environment");
  await runMigrations();
  await upsertTenant({ id: "sprint1_ta", name: "Sprint1 A" });
  await upsertTenant({ id: "sprint1_tb", name: "Sprint1 B" });
});

test("call list tenant isolation", async (t) => {
  if (!dbReady) return t.skip("postgres unavailable in test environment");
  const idA = crypto.randomUUID();
  const idB = crypto.randomUUID();
  const client = await pool.connect();
  try {
    await client.query("delete from calls where tenant_id like 'sprint1_%'");
    await client.query(
      `insert into calls (id, tenant_id, caller_id, stage, lead, history) values ($1,$2,$3,$4,$5,$6)`,
      [idA, "sprint1_ta", "+15550001111", "completed", "{}", "[]"],
    );
    await client.query(
      `insert into calls (id, tenant_id, caller_id, stage, lead, history) values ($1,$2,$3,$4,$5,$6)`,
      [idB, "sprint1_tb", "+15550002222", "missed", "{}", "[]"],
    );
  } finally {
    client.release();
  }

  const rowsA = await listCallsForTenantDb("sprint1_ta", 50);
  const rowsB = await listCallsForTenantDb("sprint1_tb", 50);
  assert.ok(rowsA.some((r) => r.id === idA));
  assert.ok(!rowsA.some((r) => r.id === idB));
  assert.ok(rowsB.some((r) => r.id === idB));
  assert.ok(!rowsB.some((r) => r.id === idA));
});

test("getCallByIdForTenantDb does not cross tenants", async (t) => {
  if (!dbReady) return t.skip("postgres unavailable in test environment");
  const rows = await listCallsForTenantDb("sprint1_ta", 5);
  const idA = rows.find((r) => r.caller_id === "+15550001111")?.id;
  assert.ok(idA);
  const wrong = await getCallByIdForTenantDb("sprint1_tb", idA);
  assert.equal(wrong, null);
  const ok = await getCallByIdForTenantDb("sprint1_ta", idA);
  assert.ok(ok);
  assert.equal(ok.tenant_id, "sprint1_ta");
});

test("close pool", async () => {
  await closePool().catch(() => {});
});
