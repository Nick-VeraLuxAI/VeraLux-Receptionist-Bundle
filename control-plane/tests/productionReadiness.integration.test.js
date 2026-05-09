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

test("Sprint 0: GET /api/admin/tenants is scoped to JWT memberships", async (t) => {
  if (!setupOk) return t.skip("integration precondition failed: infrastructure not reachable");
  const tenantA = `s0a-${randomUUID().slice(0, 6)}`;
  const tenantB = `s0b-${randomUUID().slice(0, 6)}`;
  await createTenant(tenantA, "+15550100021");
  await createTenant(tenantB, "+15550100022");

  // Superadmin (master env key) sees both.
  const adminAll = await req("/api/admin/tenants", { headers: adminHeaders() });
  assert.equal(adminAll.status, 200);
  const adminIds = (adminAll.body.tenants || []).map((m) => m.id);
  assert.ok(adminIds.includes(tenantA), "superadmin lists tenantA");
  assert.ok(adminIds.includes(tenantB), "superadmin lists tenantB");

  // Tenant A JWT only sees tenantA.
  const subA = `sub-s0-${randomUUID()}`;
  await ensureMembership(tenantA, subA, "admin");
  const jwtA = signJwt({ sub: subA, email: "a@example.com", role: "admin" }, JWT_SECRET);
  const tenantAList = await req("/api/admin/tenants", {
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${jwtA}`,
      "X-Active-Tenant": tenantA,
      "X-Tenant-ID": tenantA,
    },
  });
  assert.equal(tenantAList.status, 200);
  const aIds = (tenantAList.body.tenants || []).map((m) => m.id);
  assert.ok(aIds.includes(tenantA), "tenant A JWT can see its own tenant");
  assert.ok(!aIds.includes(tenantB), "tenant A JWT cannot enumerate tenant B");
});

test("Sprint 0: DELETE /api/admin/leads/:id requires tenant match", async (t) => {
  if (!setupOk) return t.skip("integration precondition failed: infrastructure not reachable");
  const tenantA = `s0la-${randomUUID().slice(0, 6)}`;
  const tenantB = `s0lb-${randomUUID().slice(0, 6)}`;
  await createTenant(tenantA, "+15550100031");
  await createTenant(tenantB, "+15550100032");

  // Insert a lead directly into tenant B.
  const leadId = randomUUID();
  await pool.query(
    `INSERT INTO leads (id, tenant_id, name, phone, raw_extract, created_at)
     VALUES ($1, $2, $3, $4, $5::jsonb, NOW())`,
    [leadId, tenantB, "tenant-b-lead", "+15550009999", JSON.stringify({ caller: "tenantB" })],
  );

  // Superadmin acting in tenant A's context cannot delete tenant B's lead.
  const wrongTenantDelete = await req(`/api/admin/leads/${leadId}`, {
    method: "DELETE",
    headers: adminHeaders(tenantA),
  });
  assert.equal(
    wrongTenantDelete.status,
    404,
    "cross-tenant lead delete returns 404, never 200",
  );

  // Confirm lead still exists in DB.
  const stillThere = await pool.query("SELECT id FROM leads WHERE id = $1", [leadId]);
  assert.equal(stillThere.rows.length, 1, "tenant B lead must not be deleted by tenant A request");

  // Correct tenant context succeeds.
  const correctDelete = await req(`/api/admin/leads/${leadId}`, {
    method: "DELETE",
    headers: adminHeaders(tenantB),
  });
  assert.equal(correctDelete.status, 200);
});

test("Sprint 0: /api/runtime/calls and /api/runtime/analytics reject cross-tenant body tenantId", async (t) => {
  if (!setupOk) return t.skip("integration precondition failed: infrastructure not reachable");
  const tenantA = `s0ra-${randomUUID().slice(0, 6)}`;
  const tenantB = `s0rb-${randomUUID().slice(0, 6)}`;
  await createTenant(tenantA, "+15550100041");
  await createTenant(tenantB, "+15550100042");

  // Tenant A JWT (admin role) cannot publish call/analytics for tenant B.
  const subA = `sub-runtime-${randomUUID()}`;
  await ensureMembership(tenantA, subA, "admin");
  const jwtA = signJwt({ sub: subA, email: "ra@example.com", role: "admin" }, JWT_SECRET);
  const headersA = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${jwtA}`,
    "X-Active-Tenant": tenantA,
    "X-Tenant-ID": tenantA,
  };

  const xAnalytics = await req("/api/runtime/analytics", {
    method: "POST",
    headers: headersA,
    body: JSON.stringify({ tenantId: tenantB, event: "call_started" }),
  });
  assert.equal(xAnalytics.status, 403, "cross-tenant analytics is forbidden");

  const xCalls = await req("/api/runtime/calls", {
    method: "POST",
    headers: headersA,
    body: JSON.stringify({ tenantId: tenantB, action: "start", callState: { callerId: "+15550009999" } }),
  });
  assert.equal(xCalls.status, 403, "cross-tenant call publish is forbidden");

  // Same-tenant publish still works.
  const okAnalytics = await req("/api/runtime/analytics", {
    method: "POST",
    headers: headersA,
    body: JSON.stringify({ tenantId: tenantA, event: "call_started" }),
  });
  assert.equal(okAnalytics.status, 200, "same-tenant analytics succeeds");
});

test("Sprint 0: carrier-level Telnyx routes deny tenant JWT and require superadmin", async (t) => {
  if (!setupOk) return t.skip("integration precondition failed: infrastructure not reachable");
  const tenantId = `s0tx-${randomUUID().slice(0, 6)}`;
  await createTenant(tenantId, "+15550100051");

  // Tenant viewer JWT must be denied.
  const subV = `sub-telnyxv-${randomUUID()}`;
  await ensureMembership(tenantId, subV, "viewer");
  const jwtV = signJwt({ sub: subV, email: "v@example.com", role: "viewer" }, JWT_SECRET);
  const viewerHeaders = {
    Authorization: `Bearer ${jwtV}`,
    "X-Active-Tenant": tenantId,
    "X-Tenant-ID": tenantId,
  };

  for (const path of [
    "/api/admin/telnyx/status",
    "/api/admin/telnyx/numbers",
    "/api/admin/telnyx/connections",
  ]) {
    const r = await req(path, { headers: viewerHeaders });
    assert.ok(
      [401, 403].includes(r.status),
      `tenant viewer must NOT reach ${path} (got ${r.status})`,
    );
  }

  // Tenant admin JWT also denied (carrier infra is super-admin only).
  const subA = `sub-telnyxa-${randomUUID()}`;
  await ensureMembership(tenantId, subA, "admin");
  const jwtA = signJwt({ sub: subA, email: "ta@example.com", role: "admin" }, JWT_SECRET);
  const adminTenantHeaders = {
    Authorization: `Bearer ${jwtA}`,
    "X-Active-Tenant": tenantId,
    "X-Tenant-ID": tenantId,
  };
  const tenantAdminProbe = await req("/api/admin/telnyx/status", { headers: adminTenantHeaders });
  assert.equal(
    tenantAdminProbe.status,
    403,
    "tenant-admin JWT must not probe carrier-level Telnyx config",
  );
});

test("Sprint 0: Cloudflare token route is superadmin-only and write is disabled", async (t) => {
  if (!setupOk) return t.skip("integration precondition failed: infrastructure not reachable");
  const tenantId = `s0cf-${randomUUID().slice(0, 6)}`;
  await createTenant(tenantId, "+15550100061");

  // Tenant viewer JWT denied.
  const subV = `sub-cfv-${randomUUID()}`;
  await ensureMembership(tenantId, subV, "viewer");
  const jwtV = signJwt({ sub: subV, email: "cv@example.com", role: "viewer" }, JWT_SECRET);
  const denyGet = await req("/api/admin/cloudflare/token", {
    headers: {
      Authorization: `Bearer ${jwtV}`,
      "X-Active-Tenant": tenantId,
      "X-Tenant-ID": tenantId,
    },
  });
  assert.ok(
    [401, 403].includes(denyGet.status),
    "tenant viewer JWT cannot read Cloudflare tunnel token status",
  );

  // Tenant admin JWT also denied (carrier-shared secret).
  const subA = `sub-cfa-${randomUUID()}`;
  await ensureMembership(tenantId, subA, "admin");
  const jwtA = signJwt({ sub: subA, email: "ca@example.com", role: "admin" }, JWT_SECRET);
  const denyTenantAdmin = await req("/api/admin/cloudflare/token", {
    headers: {
      Authorization: `Bearer ${jwtA}`,
      "X-Active-Tenant": tenantId,
      "X-Tenant-ID": tenantId,
    },
  });
  assert.equal(
    denyTenantAdmin.status,
    403,
    "tenant-admin JWT cannot read Cloudflare tunnel token status",
  );

  // Superadmin GET works.
  const okGet = await req("/api/admin/cloudflare/token", { headers: adminHeaders() });
  assert.equal(okGet.status, 200);
  assert.equal(typeof okGet.body.hasToken, "boolean");

  // POST is intentionally disabled even for superadmin.
  const writeDisabled = await req("/api/admin/cloudflare/token", {
    method: "POST",
    headers: adminHeaders(),
    body: JSON.stringify({ token: "abc" }),
  });
  assert.equal(writeDisabled.status, 410, "in-app Cloudflare token write is disabled (set via env)");
});

test("Sprint 0: /api/tts/config rejects raw provider URL fields from non-superadmin", async (t) => {
  if (!setupOk) return t.skip("integration precondition failed: infrastructure not reachable");
  const tenantId = `s0tts-${randomUUID().slice(0, 6)}`;
  await createTenant(tenantId, "+15550100071");

  const subA = `sub-tts-${randomUUID()}`;
  await ensureMembership(tenantId, subA, "admin");
  const jwtA = signJwt({ sub: subA, email: "tts@example.com", role: "admin" }, JWT_SECRET);
  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${jwtA}`,
    "X-Active-Tenant": tenantId,
    "X-Tenant-ID": tenantId,
  };

  for (const url of [
    { kokoroUrl: "http://attacker.example.com:7001/tts" },
    { qwen3TtsUrl: "http://attacker.example.com:7010" },
    { coquiXttsUrl: "http://attacker.example.com:7002/tts" },
    { chatterboxUrl: "http://attacker.example.com:7005" },
    { xttsUrl: "http://attacker.example.com:7002/tts" },
  ]) {
    const r = await req("/api/tts/config", {
      method: "POST",
      headers,
      body: JSON.stringify({ ttsMode: "kokoro_http", ...url }),
    });
    assert.equal(
      r.status,
      403,
      `non-superadmin must NOT submit raw provider URL: ${Object.keys(url)[0]}`,
    );
    assert.equal(r.body.error, "provider_url_admin_only");
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
