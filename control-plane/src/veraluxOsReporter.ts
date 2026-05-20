import { randomUUID } from "node:crypto";
import { pool } from "./db";

const ENABLED =
  String(process.env.VERALUX_OS_REPORTING_ENABLED || "")
    .trim()
    .toLowerCase() === "true";

const BASE_URL = (process.env.VERALUX_OS_URL || "").replace(/\/+$/, "");
const API_KEY = String(process.env.VERALUX_OS_API_KEY || "").trim();
const DEPLOYMENT_ID = String(process.env.VERALUX_DEPLOYMENT_ID || "").trim();
const PRODUCT_TYPE = String(
  process.env.VERALUX_PRODUCT_TYPE || "receptionist",
).toLowerCase();
const ENVIRONMENT = String(
  process.env.VERALUX_DEPLOYMENT_ENV ||
    process.env.NODE_ENV ||
    "development",
).slice(0, 64);
const PUBLIC_URL = String(
  process.env.VERALUX_DEPLOYMENT_PUBLIC_URL || "",
).trim();

const HEARTBEAT_MS = Math.min(
  Math.max(Number(process.env.VERALUX_OS_HEARTBEAT_INTERVAL_MS || 180000), 60000),
  300000,
);
const METRICS_MS = Math.min(
  Math.max(Number(process.env.VERALUX_OS_METRICS_INTERVAL_MS || 3600000), 300000),
  86400000,
);

let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let metricsTimer: ReturnType<typeof setInterval> | null = null;
let consecutiveFailures = 0;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function nextBackoffMs(): number {
  const base = 2000;
  const cap = 120000;
  const exp = Math.min(cap, base * 2 ** Math.min(consecutiveFailures, 6));
  return exp + Math.floor(Math.random() * 1000);
}

async function postJson(
  path: string,
  body: Record<string, unknown>,
): Promise<{ ok: boolean; skipped?: boolean; status: number; text: string }> {
  if (!BASE_URL || !API_KEY) return { ok: false, skipped: true, status: 0, text: "" };
  const url = `${BASE_URL}${path}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-veralux-api-key": API_KEY,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { ok: res.ok, status: res.status, text };
}

function validateConfigOrWarn(): boolean {
  if (!ENABLED) return false;
  if (PRODUCT_TYPE !== "solomon" && PRODUCT_TYPE !== "receptionist") {
    console.warn(
      "[veralux-os-reporting] VERALUX_PRODUCT_TYPE must be solomon or receptionist; disabling.",
    );
    return false;
  }
  if (!DEPLOYMENT_ID) {
    console.warn("[veralux-os-reporting] VERALUX_DEPLOYMENT_ID missing; disabling.");
    return false;
  }
  if (!BASE_URL) {
    console.warn("[veralux-os-reporting] VERALUX_OS_URL missing; disabling.");
    return false;
  }
  if (!API_KEY) {
    console.warn("[veralux-os-reporting] VERALUX_OS_API_KEY missing; disabling.");
    return false;
  }
  return true;
}

async function fetchLocalReady(): Promise<{
  ok: boolean;
  status: number;
  data: Record<string, unknown>;
}> {
  const port = process.env.PORT || 4000;
  const base =
    process.env.PUBLIC_BASE_URL?.replace(/\/+$/, "") ||
    `http://127.0.0.1:${port}`;
  const url = `${base}/ready`;
  try {
    const res = await fetch(url, { method: "GET" });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return { ok: res.ok, status: res.status, data };
  } catch (e) {
    return {
      ok: false,
      status: 0,
      data: { error: e instanceof Error ? e.message : "fetch_failed" },
    };
  }
}

async function sendHeartbeat(): Promise<void> {
  const ready = await fetchLocalReady();
  const statusField =
    typeof ready.data.status === "string" ? ready.data.status : "";
  const readinessStatus =
    ready.ok && (statusField === "ok" || statusField === "ready")
      ? "ready"
      : "not_ready";

  const slim: Record<string, unknown> = {};
  if (ready.data.checks && typeof ready.data.checks === "object") {
    slim.checks = ready.data.checks;
  }

  const body = {
    schemaVersion: "1.0",
    sourceProduct: PRODUCT_TYPE,
    deploymentId: DEPLOYMENT_ID,
    environment: ENVIRONMENT,
    eventType: "telemetry.heartbeat",
    severity: "info",
    timestamp: new Date().toISOString(),
    correlationId: randomUUID(),
    idempotencyKey: `hb:${DEPLOYMENT_ID}:${Math.floor(Date.now() / HEARTBEAT_MS)}`,
    piiLevel: "none",
    payload: {
      readinessStatus,
      checks: {
        local_ready_http: ready.status,
        ready: slim,
      },
      publicUrl: PUBLIC_URL || undefined,
    },
  };

  const r = await postJson("/api/internal/product-telemetry/v1/heartbeat", body);
  if (!r.ok && !r.skipped) {
    consecutiveFailures += 1;
    console.warn(
      `[veralux-os-reporting] heartbeat failed status=${r.status} body=${r.text.slice(0, 200)}`,
    );
    await sleep(nextBackoffMs());
  } else {
    consecutiveFailures = 0;
  }
}

async function sendMetrics(): Promise<void> {
  const client = await pool.connect();
  try {
    const totalCalls = await client.query(`select count(*)::text as c from calls`);
    const missedCalls = await client.query(
      `select count(*)::text as c from calls where
        lower(coalesce(stage, '')) like '%miss%'
        or lower(coalesce(stage, '')) like '%abandon%'
        or lower(coalesce(stage, '')) = 'no_answer'`,
    );
    const qualityRows = await client.query(
      `select count(*)::text as c from call_quality_summaries`,
    );
    const analyticsAgg = await client.query(
      `select coalesce(sum(call_count), 0)::text as c from analytics`,
    );

    const total = totalCalls.rows[0]?.c ?? "0";
    const missed = missedCalls.rows[0]?.c ?? "0";
    const quality = qualityRows.rows[0]?.c ?? "0";
    const analyticsCalls = analyticsAgg.rows[0]?.c ?? "0";

    const metrics = [
      { name: "calls_rows_total", value: Number(total) || 0, dimensions: {} },
      {
        name: "calls_missed_stage_approx",
        value: Number(missed) || 0,
        dimensions: {},
      },
      {
        name: "call_quality_summary_rows_total",
        value: Number(quality) || 0,
        dimensions: {},
      },
      {
        name: "analytics_call_count_sum",
        value: Number(analyticsCalls) || 0,
        dimensions: {},
      },
    ];

    const body = {
      schemaVersion: "1.0",
      sourceProduct: PRODUCT_TYPE,
      deploymentId: DEPLOYMENT_ID,
      environment: ENVIRONMENT,
      eventType: "telemetry.metrics.batch",
      severity: "info",
      timestamp: new Date().toISOString(),
      correlationId: randomUUID(),
      idempotencyKey: `metrics:${DEPLOYMENT_ID}:${new Date().toISOString().slice(0, 13)}`,
      piiLevel: "none",
      payload: {
        metrics,
        publicUrl: PUBLIC_URL || undefined,
      },
    };

    const r = await postJson("/api/internal/product-telemetry/v1/metrics", body);
    if (!r.ok && !r.skipped) {
      consecutiveFailures += 1;
      console.warn(
        `[veralux-os-reporting] metrics failed status=${r.status} body=${r.text.slice(0, 200)}`,
      );
      await sleep(nextBackoffMs());
    } else {
      consecutiveFailures = 0;
    }
  } finally {
    client.release();
  }
}

function scheduleTimers(): void {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  if (metricsTimer) clearInterval(metricsTimer);

  void sendHeartbeat().catch((e) =>
    console.warn("[veralux-os-reporting] initial heartbeat error:", e),
  );

  heartbeatTimer = setInterval(() => {
    void sendHeartbeat().catch((e) =>
      console.warn("[veralux-os-reporting] heartbeat error:", e),
    );
  }, HEARTBEAT_MS);

  metricsTimer = setInterval(() => {
    void sendMetrics().catch((e) =>
      console.warn("[veralux-os-reporting] metrics error:", e),
    );
  }, METRICS_MS);

  heartbeatTimer.unref();
  metricsTimer.unref();
}

export function startVeraluxOsReporting(): void {
  try {
    if (typeof fetch !== "function") {
      console.warn("[veralux-os-reporting] fetch unavailable; reporting disabled.");
      return;
    }
    if (!validateConfigOrWarn()) return;
    console.log(
      `[veralux-os-reporting] enabled deployment=${DEPLOYMENT_ID} heartbeat=${HEARTBEAT_MS}ms metrics=${METRICS_MS}ms`,
    );
    scheduleTimers();
  } catch (e) {
    console.warn(
      "[veralux-os-reporting] failed to start:",
      e instanceof Error ? e.message : e,
    );
  }
}
