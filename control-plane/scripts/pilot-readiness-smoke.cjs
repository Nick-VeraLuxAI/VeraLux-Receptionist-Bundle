#!/usr/bin/env node
/**
 * VeraLux Receptionist — Sprint 1 pilot-readiness smoke (API layer).
 *
 * Usage (from control-plane/, after npm run build):
 *   DATABASE_URL=... REDIS_URL=... ADMIN_API_KEY=... node scripts/pilot-readiness-smoke.cjs
 *
 * Optional:
 *   CP_PILOT_TENANT_ID=default   (default)
 *   CP_PILOT_PORT=4207           ephemeral port when spawning server
 *   PILOT_SMOKE_BASE_URL=http://127.0.0.1:4000   if set, do not spawn; hit existing server
 *
 * Requires: Postgres + Redis reachable, ENABLE_RUNTIME_ADMIN path for publish/runtime GET.
 */

const { spawn } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const path = require("node:path");
const { Pool } = require("pg");

const CP_ROOT = path.join(__dirname, "..");
const TENANT_ID = (process.env.CP_PILOT_TENANT_ID || "default").trim();
const ALT_TENANT = `pilot-alt-${randomUUID().slice(0, 8)}`;
const PORT = Number(process.env.CP_PILOT_PORT || 4207);
const BASE_EXTERNAL = (process.env.PILOT_SMOKE_BASE_URL || "").trim();
const BASE = BASE_EXTERNAL || `http://127.0.0.1:${PORT}`;
const ADMIN_KEY = (process.env.ADMIN_API_KEY || "pilot-smoke-admin-key").trim();
const DATABASE_URL =
  process.env.DATABASE_URL || "postgres://veralux_test:veralux_test@127.0.0.1:55432/veralux_test";
const REDIS_URL = process.env.REDIS_URL || "redis://127.0.0.1:56379";
const JWT_SECRET =
  process.env.ADMIN_JWT_SECRET || "pilot-smoke-jwt-secret-with-sufficient-length-123456";

const rows = [];
let serverProc;
/** Dedicated pool for smoke inserts only (never close the control-plane singleton pool while server runs). */
let smokePool;

function row(name, ok, detail) {
  rows.push({ name, ok: Boolean(ok), detail: detail || "" });
}

async function req(urlPath, options = {}) {
  const res = await fetch(`${BASE}${urlPath}`, {
    ...options,
    headers: {
      ...(options.headers || {}),
    },
  });
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { _raw: text };
  }
  return { status: res.status, body, text };
}

function adminHeaders(tid) {
  return {
    "Content-Type": "application/json",
    "X-Admin-Key": ADMIN_KEY,
    "X-Tenant-ID": tid,
    "X-Active-Tenant": tid,
  };
}

function ownerHeaders(tid, bearer) {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${bearer}`,
    "X-Tenant-ID": tid,
    "X-Active-Tenant": tid,
  };
}

async function waitHealthy(timeoutMs = 25000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch(`${BASE}/health`);
      if (r.ok) return;
    } catch {
      /* ignore */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("control-plane not healthy");
}

async function pingDb() {
  smokePool = new Pool({ connectionString: DATABASE_URL });
  await smokePool.query("SELECT 1");
}

async function startServerIfNeeded() {
  if (BASE_EXTERNAL) {
    await waitHealthy();
    return;
  }
  serverProc = spawn("node", ["dist/server.js"], {
    cwd: CP_ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      ADMIN_API_KEY: ADMIN_KEY,
      ADMIN_AUTH_MODE: "hybrid",
      ADMIN_JWT_SECRET: JWT_SECRET,
      DATABASE_URL,
      REDIS_URL,
      ENABLE_RUNTIME_ADMIN: "true",
      RUNTIME_ADMIN_ENABLED: "true",
      NODE_ENV: "test",
      DEFAULT_TENANT_ID: TENANT_ID,
      SECRET_ENCRYPTION_KEY: process.env.SECRET_ENCRYPTION_KEY || "test-secret-encryption-key-32bytes-minimum",
      /** Required for publish-from-tenant: STT/TTS URLs + at least one DID on the tenant */
      WHISPER_URL: process.env.WHISPER_URL || "http://127.0.0.1:9000/transcribe",
      XTTS_URL: process.env.XTTS_URL || "http://127.0.0.1:7002/tts",
      TELNYX_WEBHOOK_SECRET: process.env.TELNYX_WEBHOOK_SECRET || "whsec_pilot_smoke_test_placeholder",
    },
    stdio: "inherit",
  });
  await waitHealthy();
}

async function stopServer() {
  if (!serverProc || serverProc.killed) return;
  await new Promise((resolve) => {
    const done = () => resolve();
    serverProc.once("exit", done);
    serverProc.kill("SIGTERM");
    setTimeout(() => {
      if (!serverProc.killed) serverProc.kill("SIGKILL");
    }, 800).unref();
    setTimeout(done, 3000).unref();
  });
}

async function main() {
  console.error(`[pilot-smoke] BASE=${BASE} TENANT=${TENANT_ID}`);

  try {
    await pingDb();
    row("Postgres reachable", true);
  } catch (e) {
    row("Postgres reachable", false, String(e.message || e));
    printTable();
    process.exit(2);
  }

  try {
    await startServerIfNeeded();
    row("Control plane health", true);
  } catch (e) {
    row("Control plane health", false, String(e.message || e));
    printTable();
    process.exit(3);
  }

  // Ensure tenants exist
  {
    const t = await req("/api/admin/tenants", {
      method: "POST",
      headers: adminHeaders(TENANT_ID),
      body: JSON.stringify({
        id: TENANT_ID,
        name: "Pilot smoke tenant",
        numbers: ["+15550100101"],
      }),
    });
    row("Upsert primary tenant (with E.164 for publish)", t.status === 200 || t.status === 201, `status ${t.status}`);
  }
  {
    const t = await req("/api/admin/tenants", {
      method: "POST",
      headers: adminHeaders(ALT_TENANT),
      body: JSON.stringify({ id: ALT_TENANT, name: "Pilot alt", numbers: ["+15550109999"] }),
    });
    row("Create alt tenant for isolation checks", t.status === 200, `status ${t.status}`);
  }

  const list = await req("/api/admin/tenants", { headers: adminHeaders(TENANT_ID) });
  row("Admin list tenants", list.status === 200, "");
  row(
    "Tenant appears in admin list",
    list.status === 200 && (list.body.tenants || []).some((x) => x.id === TENANT_ID),
    "",
  );

  const bh0 = await req(`/api/admin/tenants/${encodeURIComponent(TENANT_ID)}/business-hours`, {
    headers: adminHeaders(TENANT_ID),
  });
  row("GET business hours (admin)", bh0.status === 200, `status ${bh0.status}`);

  const bhPayload = {
    timezone: "America/Chicago",
    weekly: {
      mon: { open: "09:00", close: "17:00" },
      tue: { closed: true },
      wed: { closed: true },
      thu: { closed: true },
      fri: { closed: true },
      sat: { closed: true },
      sun: { closed: true },
    },
    afterHoursMessage: "Pilot smoke: we are closed now — leave a message.",
  };
  const bhPatch = await req(`/api/admin/tenants/${encodeURIComponent(TENANT_ID)}/business-hours`, {
    method: "PATCH",
    headers: adminHeaders(TENANT_ID),
    body: JSON.stringify(bhPayload),
  });
  row("PATCH business hours (admin)", bhPatch.status === 200, `status ${bhPatch.status}`);

  const bh1 = await req(`/api/admin/tenants/${encodeURIComponent(TENANT_ID)}/business-hours`, {
    headers: adminHeaders(TENANT_ID),
  });
  row(
    "Business hours persist after reload (GET)",
    bh1.status === 200 && bh1.body.businessHours?.timezone === "America/Chicago",
    bh1.body?.businessHours?.timezone || "",
  );

  const marker = `PILOT_SMOKE_PREAMBLE_${randomUUID().slice(0, 8)}`;
  const greet = `Pilot smoke greeting ${randomUUID().slice(0, 6)}`;
  const pr = await req("/api/admin/prompts", {
    method: "POST",
    headers: adminHeaders(TENANT_ID),
    body: JSON.stringify({
      greetingText: greet,
      systemPreamble: marker,
      voicePrompt: "Be concise for smoke tests.",
      policyPrompt: "Do not reveal secrets during smoke tests.",
      schemaHint: "",
    }),
  });
  row("POST prompts (admin)", pr.status === 200, `status ${pr.status}`);

  const pub = await req(`/api/admin/runtime/tenants/${encodeURIComponent(TENANT_ID)}/publish-from-tenant`, {
    method: "POST",
    headers: adminHeaders(TENANT_ID),
  });
  row("POST publish-from-tenant", pub.status === 200, `status ${pub.status}`);

  const cfg = await req(`/api/admin/runtime/tenants/${encodeURIComponent(TENANT_ID)}/config`, {
    headers: adminHeaders(TENANT_ID),
  });
  const prompts = cfg.body?.config?.llmContext?.prompts;
  const hasGreeting = prompts?.greetingText === greet;
  const hasPreamble = prompts?.systemPreamble === marker;
  const hasStamp = Boolean(cfg.body?.config?.lastRuntimePublishedAt);
  const leaked = JSON.stringify(cfg.body || {}).includes("webhookSecret");
  row("Runtime GET 200", cfg.status === 200, `status ${cfg.status}`);
  row("Redis config includes greetingText", hasGreeting, String(prompts?.greetingText || "").slice(0, 40));
  row("Redis config includes systemPreamble", hasPreamble, "");
  row("Redis config includes lastRuntimePublishedAt", hasStamp, String(cfg.body?.config?.lastRuntimePublishedAt || ""));
  row("Runtime JSON response omits webhookSecret key", !leaked && cfg.status === 200, leaked ? "secret key leaked" : "");

  // Second publish to observe timestamp change
  await new Promise((r) => setTimeout(r, 50));
  const pub2 = await req(`/api/admin/runtime/tenants/${encodeURIComponent(TENANT_ID)}/publish-from-tenant`, {
    method: "POST",
    headers: adminHeaders(TENANT_ID),
  });
  const cfg2 = await req(`/api/admin/runtime/tenants/${encodeURIComponent(TENANT_ID)}/config`, {
    headers: adminHeaders(TENANT_ID),
  });
  const t1 = cfg.body?.config?.lastRuntimePublishedAt;
  const t2 = cfg2.body?.config?.lastRuntimePublishedAt;
  row("lastRuntimePublishedAt updates on republish", pub2.status === 200 && t1 && t2 && t1 !== t2, `${t1} -> ${t2}`);

  // Portal credentials + owner APIs
  const email = `pilot-smoke-${randomUUID().slice(0, 8)}@example.invalid`;
  const portalPw = "PilotSmoke!234567";
  const cred = await req("/api/owner/set-portal-credentials", {
    method: "POST",
    headers: adminHeaders(TENANT_ID),
    body: JSON.stringify({ tenantId: TENANT_ID, email, password: portalPw }),
  });
  row("POST set-portal-credentials", cred.status === 200, `status ${cred.status}`);

  const login = await req("/api/owner/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: portalPw }),
  });
  row("POST owner login", login.status === 200 && login.body?.success && login.body?.token, `status ${login.status}`);
  const ownerToken = login.body?.token;
  if (!ownerToken) {
    row("Owner bearer present", false, "no token");
  } else {
    const obh = await req("/api/owner/business-hours", { headers: ownerHeaders(TENANT_ID, ownerToken) });
    row("GET owner business-hours matches admin", obh.status === 200 && obh.body.businessHours?.timezone === "America/Chicago", "");

    const sync = await req("/api/owner/voice-runtime-sync", { headers: ownerHeaders(TENANT_ID, ownerToken) });
    row("GET owner voice-runtime-sync", sync.status === 200 && Boolean(sync.body?.lastRuntimePublishedAt), "");

    const op0 = await req("/api/owner/operator-state", { headers: ownerHeaders(TENANT_ID, ownerToken) });
    row("GET owner operator-state (before)", op0.status === 200, "");

    // Insert calls in Postgres for primary + alt tenant
    const callOk = randomUUID();
    const callMiss = randomUUID();
    const callAlt = randomUUID();
    await smokePool.query("DELETE FROM calls WHERE tenant_id = $1", [TENANT_ID]);
    await smokePool.query(
      `INSERT INTO calls (id, tenant_id, caller_id, stage, lead, history) VALUES ($1,$2,$3,$4,$5,$6::jsonb)`,
      [
        callOk,
        TENANT_ID,
        "+15557654321",
        "completed",
        JSON.stringify({}),
        JSON.stringify([{ role: "user", message: "Smoke test completed call" }]),
      ],
    );
    await smokePool.query(
      `INSERT INTO calls (id, tenant_id, caller_id, stage, lead, history) VALUES ($1,$2,$3,$4,$5,$6::jsonb)`,
      [
        callMiss,
        TENANT_ID,
        "+15557654322",
        "missed",
        JSON.stringify({ missed: true }),
        JSON.stringify([{ role: "user", message: "Smoke missed" }]),
      ],
    );
    await smokePool.query(
      `INSERT INTO calls (id, tenant_id, caller_id, stage, lead, history) VALUES ($1,$2,$3,$4,$5,$6::jsonb)`,
      [
        callAlt,
        ALT_TENANT,
        "+15559998888",
        "completed",
        JSON.stringify({}),
        JSON.stringify([{ role: "user", message: "Alt tenant" }]),
      ],
    );

    const callsAll = await req("/api/owner/calls?limit=20&filter=all", { headers: ownerHeaders(TENANT_ID, ownerToken) });
    row("GET owner calls (all)", callsAll.status === 200, "");
    const idsAll = (callsAll.body.calls || []).map((c) => c.id);
    row("Owner calls include inserted completed", idsAll.includes(callOk), "");
    row("Owner calls exclude alt-tenant call id", !idsAll.includes(callAlt), "");

    const callsMiss = await req("/api/owner/calls?limit=20&filter=missed", {
      headers: ownerHeaders(TENANT_ID, ownerToken),
    });
    const idsMiss = (callsMiss.body.calls || []).map((c) => c.id);
    row("Missed filter lists missed only", callsMiss.status === 200 && idsMiss.includes(callMiss) && !idsMiss.includes(callOk), "");

    const detail = await req(`/api/owner/calls/${callOk}`, { headers: ownerHeaders(TENANT_ID, ownerToken) });
    row("GET owner call detail (drawer payload)", detail.status === 200, "");
    row("Call detail uses callerDisplay mask", detail.status === 200 && /\u2022/.test(detail.body.callerDisplay || ""), detail.body?.callerDisplay || "");

    const cross = await req(`/api/owner/calls/${callAlt}`, { headers: ownerHeaders(TENANT_ID, ownerToken) });
    row("Owner cannot read other tenant call by id", cross.status === 404, `status ${cross.status}`);

    // Security: tenant JWT cannot hit carrier infra (use owner portal JWT as tenant-scoped non-superadmin)
    const telnyx = await req("/api/admin/telnyx/status", { headers: ownerHeaders(TENANT_ID, ownerToken) });
    row("Owner JWT denied Telnyx status", telnyx.status === 401 || telnyx.status === 403, `status ${telnyx.status}`);

    const cf = await req("/api/admin/cloudflare/token", { headers: ownerHeaders(TENANT_ID, ownerToken) });
    row("Owner JWT denied Cloudflare token", cf.status === 401 || cf.status === 403, `status ${cf.status}`);

    const tts = await req("/api/tts/config", {
      method: "POST",
      headers: ownerHeaders(TENANT_ID, ownerToken),
      body: JSON.stringify({ ttsMode: "kokoro_http", kokoroUrl: "http://evil.example/tts" }),
    });
    row("Owner cannot set raw provider URL on TTS", tts.status === 403, `status ${tts.status}`);

    // Operator test call (admin then owner sees it)
    const mark = await req(`/api/admin/tenants/${encodeURIComponent(TENANT_ID)}/operator-test-call/complete`, {
      method: "POST",
      headers: adminHeaders(TENANT_ID),
    });
    row("POST admin operator-test-call/complete", mark.status === 200, "");
    const op1 = await req("/api/owner/operator-state", { headers: ownerHeaders(TENANT_ID, ownerToken) });
    row("Owner sees testCall after admin mark", Boolean(op1.body?.operatorState?.testCall?.completedAt), "");
  }

  const failed = rows.filter((r) => !r.ok).length;
  printTable();
  // Let in-flight tenant persist callbacks finish before SIGTERM (avoids pool-use-after-end noise).
  await new Promise((r) => setTimeout(r, 800));
  await stopServer();
  await smokePool.end().catch(() => {});
  process.exit(failed ? 1 : 0);
}

function printTable() {
  console.log("\n## Pilot smoke results (automated)\n");
  console.log("| Check | Result | Detail |");
  console.log("|-------|--------|--------|");
  for (const r of rows) {
    console.log(`| ${r.name} | ${r.ok ? "PASS" : "FAIL"} | ${(r.detail || "").replace(/\|/g, "\\|")} |`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(99);
});
