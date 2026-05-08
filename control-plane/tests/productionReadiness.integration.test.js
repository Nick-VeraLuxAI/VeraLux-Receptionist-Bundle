const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { randomUUID, createHmac } = require("node:crypto");
const { Pool } = require("pg");
const Redis = require("ioredis");
const { pingPool, recordTenantCallStarted, recordTenantCallEnded, closePool } = require("../dist/db.js");

const PORT = Number(process.env.CP_IT_PORT || 4199);
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN_KEY = "it-admin-key";
const JWT_SECRET = "integration-jwt-secret-with-sufficient-length-123456";
const DATABASE_URL =
  process.env.DATABASE_URL || "postgres://veralux_test:veralux_test@127.0.0.1:55432/veralux_test";
const REDIS_URL = process.env.REDIS_URL || "redis://127.0.0.1:56379";

let serverProc;
let pool;
let redis;
let setupOk = false;

function b64url(input) {
  return Buffer.from(input).toString("base64url");
}

function signJwt(payload, secret) {
  const header = { alg: "HS256", typ: "JWT" };
  const now = Math.floor(Date.now() / 1000);
  const body = { iat: now, exp: now + 3600, ...payload };
  const encodedHeader = b64url(JSON.stringify(header));
  const encodedBody = b64url(JSON.stringify(body));
  const sig = createHmac("sha256", secret)
    .update(`${encodedHeader}.${encodedBody}`)
    .digest("base64url");
  return `${encodedHeader}.${encodedBody}.${sig}`;
}

async function waitForHealthy(timeoutMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${BASE}/health`);
      if (res.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("control-plane did not become healthy");
}

async function req(path, options = {}) {
  const res = await fetch(`${BASE}${path}`, options);
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { raw: text };
  }
  return { status: res.status, body, headers: res.headers };
}

function adminHeaders(tenantId, token = ADMIN_KEY) {
  return {
    "Content-Type": "application/json",
    "X-Admin-Key": token,
    ...(tenantId ? { "X-Tenant-ID": tenantId } : {}),
  };
}

async function createTenant(tenantId, number) {
  const created = await req("/api/admin/tenants", {
    method: "POST",
    headers: adminHeaders(tenantId),
    body: JSON.stringify({ id: tenantId, name: tenantId, numbers: [number] }),
  });
  assert.equal(created.status, 200);
}

async function ensureMembership(tenantId, sub, role = "admin") {
  const r = await pool.query(
    `INSERT INTO users (email, idp_sub) VALUES ($1, $2)
     ON CONFLICT (idp_sub) DO UPDATE SET email = EXCLUDED.email
     RETURNING id`,
    [`${sub}@example.com`, sub],
  );
  const userId = r.rows[0].id;
  await pool.query(
    `INSERT INTO tenant_memberships (tenant_id, user_id, role)
     VALUES ($1, $2, $3)
     ON CONFLICT (tenant_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
    [tenantId, userId, role],
  );
}

test("production-readiness integration setup", async () => {
  const dbOk = await pingPool();
  assert.equal(
    dbOk,
    true,
    "Postgres unreachable. Ensure DB is reachable from host process (example: publish 5432 and set DATABASE_URL).",
  );
  redis = new Redis(REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1 });
  await redis.connect();
  const pong = await redis.ping();
  assert.equal(
    pong,
    "PONG",
    "Redis unreachable. Ensure Redis is reachable from host process (example: publish 6379 and set REDIS_URL).",
  );
  await redis.quit();
  redis = null;
  setupOk = true;
});

test("start integration control-plane server", async (t) => {
  if (!setupOk) return t.skip("integration precondition failed: infrastructure not reachable");
  pool = new Pool({ connectionString: DATABASE_URL });
  serverProc = spawn("node", ["dist/server.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(PORT),
      ADMIN_API_KEY: ADMIN_KEY,
      ADMIN_AUTH_MODE: "hybrid",
      ADMIN_JWT_SECRET: JWT_SECRET,
      DATABASE_URL,
      REDIS_URL,
      ENABLE_RUNTIME_ADMIN: "true",
      VOICE_RUNTIME_URL: "http://127.0.0.1:4001",
      RUNTIME_ADMIN_ENABLED: "true",
      SECRET_ENCRYPTION_KEY: "test-secret-encryption-key-32bytes-minimum",
      NODE_ENV: "test",
    },
    stdio: "pipe",
  });

  serverProc.stderr.on("data", () => {});
  serverProc.stdout.on("data", () => {});
  await waitForHealthy();
});

test("admin endpoint auth and lifecycle coverage", async (t) => {
  if (!setupOk) return t.skip("integration precondition failed: infrastructure not reachable");
  const tenantId = `it-${randomUUID().slice(0, 8)}`;
  await createTenant(tenantId, "+15550100001");

  // unauthenticated denied
  {
    const r = await req(`/api/admin/tenants/${tenantId}/limits`);
    assert.equal(r.status, 401);
  }
  // invalid admin denied
  {
    const r = await req(`/api/admin/tenants/${tenantId}/limits`, {
      headers: adminHeaders(tenantId, "bad-admin"),
    });
    assert.equal(r.status, 401);
  }

  // valid admin read
  const limits = await req(`/api/admin/tenants/${tenantId}/limits`, {
    headers: adminHeaders(tenantId),
  });
  assert.equal(limits.status, 200);
  assert.ok(limits.body?.limits?.planTier);

  // invalid values rejected
  {
    const r = await req(`/api/admin/tenants/${tenantId}/limits`, {
      method: "PATCH",
      headers: adminHeaders(tenantId),
      body: JSON.stringify({ maxDailyCalls: -1 }),
    });
    assert.equal(r.status, 400);
  }
  {
    const r = await req(`/api/admin/tenants/${tenantId}/limits`, {
      method: "POST",
      headers: adminHeaders(tenantId),
      body: JSON.stringify({ planTier: "invalid-tier" }),
    });
    assert.ok([404, 400].includes(r.status));
  }
  {
    const r = await req(`/api/admin/tenants/${tenantId}/billing-status`, {
      method: "POST",
      headers: adminHeaders(tenantId),
      body: JSON.stringify({ billingStatus: "invalid" }),
    });
    assert.equal(r.status, 400);
  }

  // valid patch persists and runtime sync can be observed in runtime config payload
  const patched = await req(`/api/admin/tenants/${tenantId}/limits`, {
    method: "PATCH",
    headers: adminHeaders(tenantId),
    body: JSON.stringify({
      planTier: "premium",
      includedMonthlyMinutes: 1,
      maxMonthlyMinutesHardCap: 10,
      maxDailyCalls: 50,
      maxMonthlyCalls: 100,
      overageMode: "allow_and_bill",
    }),
  });
  assert.equal(patched.status, 200);
  assert.equal(patched.body.limits.planTier, "premium");
  const runtimeCfg = await req(`/api/admin/runtime/tenants/${tenantId}/config`, {
    headers: adminHeaders(tenantId),
  });
  if (runtimeCfg.status === 200) {
    assert.equal(runtimeCfg.body?.config?.usageLimits?.planTier, "premium");
  }

  const usage = await req(`/api/admin/tenants/${tenantId}/usage`, {
    headers: adminHeaders(tenantId),
  });
  assert.equal(usage.status, 200);
  assert.equal(usage.body.tenantId, tenantId);

  await recordTenantCallStarted(tenantId);
  await recordTenantCallEnded({ tenantId, durationMs: 120000 });

  const month = new Date().toISOString().slice(0, 7);
  const summary = await req(
    `/api/admin/tenants/${tenantId}/billing-summary?month=${month}`,
    { headers: adminHeaders(tenantId) },
  );
  assert.equal(summary.status, 200);
  assert.ok(summary.body.summary.overageMinutes >= 1);

  const reset = await req(
    `/api/admin/tenants/${tenantId}/limits/reset-to-plan-defaults`,
    {
      method: "POST",
      headers: adminHeaders(tenantId),
      body: JSON.stringify({ planTier: "professional" }),
    },
  );
  assert.equal(reset.status, 200);
  assert.equal(reset.body.limits.planTier, "professional");

  const billing = await req(`/api/admin/tenants/${tenantId}/billing-status`, {
    method: "POST",
    headers: adminHeaders(tenantId),
    body: JSON.stringify({ billingStatus: "past_due" }),
  });
  assert.equal(billing.status, 200);
  assert.equal(billing.body.limits.billingStatus, "past_due");

  // audit trail created
  const audit = await req(`/api/admin/audit`, { headers: adminHeaders(tenantId) });
  assert.equal(audit.status, 200);
  const entries = audit.body.entries || [];
  assert.ok(entries.some((e) => String(e.action || "").includes("/limits")));
});

test("tenant A/B isolation over HTTP with tenant-scoped JWT", async (t) => {
  if (!setupOk) return t.skip("integration precondition failed: infrastructure not reachable");
  const tenantA = `tenantA-${randomUUID().slice(0, 6)}`;
  const tenantB = `tenantB-${randomUUID().slice(0, 6)}`;
  await createTenant(tenantA, "+15550100011");
  await createTenant(tenantB, "+15550100012");

  const subA = `sub-${randomUUID()}`;
  await ensureMembership(tenantA, subA, "admin");
  const jwtA = signJwt({ sub: subA, email: "a@example.com", role: "admin" }, JWT_SECRET);
  const jwtHeadersA = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${jwtA}`,
    "X-Active-Tenant": tenantA,
    "X-Tenant-ID": tenantA,
  };

  const paths = [
    [`/api/admin/tenants/${tenantB}/limits`, "GET"],
    [`/api/admin/tenants/${tenantB}/limits`, "PATCH"],
    [`/api/admin/tenants/${tenantB}/usage`, "GET"],
    [`/api/admin/tenants/${tenantB}/billing-summary?month=${new Date().toISOString().slice(0, 7)}`, "GET"],
    [`/api/admin/tenants/${tenantB}/billing-status`, "POST"],
    [`/api/admin/tenants/${tenantB}/limits/reset-to-plan-defaults`, "POST"],
  ];
  for (const [path, method] of paths) {
    const r = await req(path, {
      method,
      headers: jwtHeadersA,
      body:
        method === "PATCH"
          ? JSON.stringify({ maxDailyCalls: 123 })
          : method === "POST"
            ? JSON.stringify({ billingStatus: "active", planTier: "starter" })
            : undefined,
    });
    assert.equal(r.status, 403, `${method} ${path} should be forbidden for tenantA JWT`);
  }
});

test("cleanup integration resources", async () => {
  if (serverProc && !serverProc.killed) {
    await new Promise((resolve) => {
      const done = () => resolve();
      serverProc.once("exit", done);
      serverProc.kill("SIGTERM");
      setTimeout(() => {
        if (!serverProc.killed) serverProc.kill("SIGKILL");
      }, 1000).unref();
      setTimeout(done, 2500).unref();
    });
  }
  if (pool) {
    await pool.end();
  }
  await closePool().catch(() => {});
});
