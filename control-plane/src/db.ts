import { Pool, type PoolClient } from "pg";
import fs from "fs";
import path from "path";
import { normalizeE164 } from "./runtime/runtimeContract";
import { syncRedisDidMapAfterTenantNumbersChange } from "./didMappingSync";
import { getPlanDefaults, RECOMMENDED_DEFAULT_PLAN_TIER, type TenantLimits } from "./planLimits";
import { sanitizeCallControlId } from "./utils/validation";

const DEFAULT_DATABASE_URL =
  process.env.DATABASE_URL ||
  "postgres://veralux:veralux@localhost:5432/veralux";

// Configurable pool settings via environment variables
const POOL_MAX = parseInt(process.env.DATABASE_POOL_MAX || "10", 10);
const POOL_MIN = parseInt(process.env.DATABASE_POOL_MIN || "2", 10);
const POOL_IDLE_TIMEOUT = parseInt(process.env.DATABASE_POOL_IDLE_TIMEOUT_MS || "30000", 10);
const POOL_CONNECTION_TIMEOUT = parseInt(process.env.DATABASE_POOL_CONNECTION_TIMEOUT_MS || "5000", 10);

export const pool = new Pool({
  connectionString: DEFAULT_DATABASE_URL,
  max: POOL_MAX,
  min: POOL_MIN,
  idleTimeoutMillis: POOL_IDLE_TIMEOUT,
  connectionTimeoutMillis: POOL_CONNECTION_TIMEOUT,
});

// Log pool errors
pool.on("error", (err) => {
  console.error("[db] Pool error:", err.message);
});

/**
 * Helper to safely rollback and log failures
 */
async function safeRollback(client: PoolClient, context?: string): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch (rollbackErr) {
    console.error("[db] Rollback failed", {
      context,
      error: rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr),
    });
  }
}

const MIGRATIONS_DIR = path.join(process.cwd(), "migrations");
const DOWN_MARKER = /^--\s*@down\b/im;
const isUuid = (s: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    s
  );

function parseMigration(filePath: string): { up: string; down: string } {
  const raw = fs.readFileSync(filePath, "utf8");
  const parts = raw.split(DOWN_MARKER);
  const up = parts[0].trim();
  const down = parts[1] ? parts[1].trim() : "";
  return { up, down };
}

async function getAppliedMigrations(client: PoolClient): Promise<Set<string>> {
  await client.query(`
    create table if not exists schema_migrations (
      id text primary key,
      applied_at timestamptz default now()
    );
  `);
  const res = await client.query<{ id: string }>(
    "select id from schema_migrations order by id asc"
  );
  return new Set(res.rows.map((r: { id: string }) => r.id));
}

async function withDeadlockRetry<T>(
  fn: (attempt: number) => Promise<T>,
  maxAttempts = 5
): Promise<T> {
  let lastErr: any;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (err: any) {
      lastErr = err;

      // Postgres deadlock detected
      const code = err?.code || err?.cause?.code;
      if (code !== "40P01") throw err;

      // small jitter backoff
      const delayMs = 20 * attempt + Math.floor(Math.random() * 50);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }

  throw lastErr;
}


export async function runMigrations(): Promise<void> {
  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  const client = await pool.connect();
  try {
    const applied = await getAppliedMigrations(client);
    for (const file of files) {
      if (applied.has(file)) continue;
      const { up } = parseMigration(path.join(MIGRATIONS_DIR, file));
      if (!up) continue;
      await client.query("begin");
      await client.query(up);
      await client.query(
        "insert into schema_migrations (id, applied_at) values ($1, now())",
        [file]
      );
      await client.query("commit");
    }
  } catch (err) {
    await safeRollback(client, "runMigrations");
    throw err;
  } finally {
    client.release();
  }
}

export interface TenantRow {
  id: string;
  name: string;
  created_at: string;
  updated_at: string;
}

export interface ConfigRow {
  tenant_id: string;
  config: unknown;
  prompts: unknown;
  stt: unknown;
  tts: unknown;
  forwarding_profiles?: unknown;
  pricing?: unknown;
  business_hours?: unknown;
  operator_state?: unknown;
}

export interface CallRow {
  id: string;
  tenant_id: string;
  caller_id: string | null;
  stage: string | null;
  lead: any;
  history: any;
}

export interface AnalyticsRow {
  tenant_id: string;
  call_count: number;
  caller_message_count: number;
  question_counts: Record<string, number>;
}

export interface AdminApiKeyRow {
  id: string;
  name: string;
  role: string;
  token_hash: string;
  created_at: string;
  last_used_at: string | null;
}

export interface SecretRow {
  tenant_id: string;
  key: string;
  cipher: string;
}

export interface UserRow {
  id: string;
  email: string | null;
  idp_sub: string | null;
}

export interface MembershipRow {
  id: string;
  tenant_id: string;
  user_id: string;
  role: string;
}

export interface TenantApiKeyRow {
  id: string;
  tenant_id: string;
  name: string;
  key_hash: string;
  scopes: string | null;
  revoked_at: string | null;
}

export async function fetchTenantsFromDb(): Promise<{
  tenants: TenantRow[];
  numbers: { tenant_id: string; number: string }[];
  configs: ConfigRow[];
  calls: CallRow[];
  analytics: AnalyticsRow[];
  adminKeys: AdminApiKeyRow[];
  secrets: SecretRow[];
}> {
  const client = await pool.connect();
  try {
    const [tenants, numbers, configs, calls, analytics, adminKeys, secrets] =
      await Promise.all([
        client.query<TenantRow>("select * from tenants"),
        client.query<{ tenant_id: string; number: string }>(
          "select tenant_id, number from tenant_numbers"
        ),
        client.query<ConfigRow>("select * from tenant_configs"),
        client.query<CallRow>("select id, tenant_id, caller_id, stage, lead, history from calls"),
        client.query<AnalyticsRow>(
          "select tenant_id, call_count, caller_message_count, question_counts from analytics"
        ),
        client.query<AdminApiKeyRow>(
          "select id, name, role, token_hash, created_at, last_used_at from admin_api_keys"
        ),
        client.query<SecretRow>(
          "select tenant_id, key, cipher from tenant_secrets"
        ),
      ]);

    return {
      tenants: tenants.rows,
      numbers: numbers.rows,
      configs: configs.rows,
      calls: calls.rows,
      analytics: analytics.rows,
      adminKeys: adminKeys.rows,
      secrets: secrets.rows,
    };
  } finally {
    client.release();
  }
}

export async function deleteTenantRow(tenantId: string): Promise<boolean> {
  const client = await pool.connect();
  try {
    const r = await client.query("delete from tenants where id = $1", [tenantId]);
    return (r.rowCount ?? 0) > 0;
  } finally {
    client.release();
  }
}

export async function upsertTenant(meta: {
  id: string;
  name: string;
  createdAt?: number;
  updatedAt?: number;
}): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query(
      `
      insert into tenants (id, name, created_at, updated_at)
      values ($1, $2, to_timestamp($3/1000.0), to_timestamp($4/1000.0))
      on conflict (id) do update set name = excluded.name, updated_at = excluded.updated_at
    `,
      [meta.id, meta.name, meta.createdAt || Date.now(), meta.updatedAt || Date.now()]
    );
  } finally {
    client.release();
  }
}

export async function getTenantNumbers(tenantId: string): Promise<string[]> {
  const client = await pool.connect();
  try {
    const r = await client.query<{ number: string }>(
      "select number from tenant_numbers where tenant_id = $1 order by number",
      [tenantId]
    );
    return r.rows.map((x) => x.number);
  } finally {
    client.release();
  }
}

/** Resolve tenant id for an inbound DID using Postgres (canonical mapping). */
export async function findTenantIdByInboundNumberE164(
  didNormalized: string
): Promise<string | null> {
  const client = await pool.connect();
  try {
    const r = await client.query<{ tenant_id: string; number: string }>(
      "select tenant_id, number from tenant_numbers"
    );
    for (const row of r.rows) {
      try {
        if (normalizeE164(row.number) === didNormalized) {
          return row.tenant_id;
        }
      } catch {
        /* skip malformed row */
      }
    }
    return null;
  } finally {
    client.release();
  }
}

/** Add a DID to a tenant if missing; updates Redis via setTenantNumbers sync. */
export async function addTenantNumberIfMissing(
  tenantId: string,
  rawNumber: string
): Promise<void> {
  const normalized = normalizeE164(String(rawNumber || "").trim());
  const nums = await getTenantNumbers(tenantId);
  for (const n of nums) {
    try {
      if (normalizeE164(n) === normalized) return;
    } catch {
      /* skip */
    }
  }
  await setTenantNumbers(tenantId, [...nums, normalized]);
}

export async function setTenantNumbers(
  tenantId: string,
  numbers: string[]
): Promise<void> {
  const client = await pool.connect();
  try {
    const prevRes = await client.query<{ number: string }>(
      "select number from tenant_numbers where tenant_id = $1",
      [tenantId]
    );
    const previousNumbers = prevRes.rows.map((r) => r.number);

    const cleaned = Array.from(
      new Set(
        (numbers || [])
          .map((n) => String(n || "").trim())
          .filter(Boolean)
      )
    );

    await client.query("begin");

    // Remove all numbers currently attached to this tenant
    await client.query("delete from tenant_numbers where tenant_id = $1", [tenantId]);

    if (cleaned.length > 0) {
      // Guard: if any of these numbers belong to another tenant, fail cleanly.
      const conflict = await client.query<{ number: string; tenant_id: string }>(
        `
        select number, tenant_id
        from tenant_numbers
        where number = any($1::text[])
          and tenant_id <> $2
        `,
        [cleaned, tenantId]
      );

      if (conflict.rows.length > 0) {
        // rollback so we don't wipe this tenant's numbers then fail
        await client.query("rollback");

        const details = conflict.rows
          .map((r) => `${r.number} -> ${r.tenant_id}`)
          .join(", ");

        const err: any = new Error(`number_already_assigned: ${details}`);
        err.code = "NUMBER_ALREADY_ASSIGNED";
        throw err;
      }

      // Insert; if number already exists for SAME tenant (or was just inserted), no crash.
      const values = cleaned.map((_, idx) => `($1, $${idx + 2})`).join(",");
      await client.query(
        `
        insert into tenant_numbers (tenant_id, number)
        values ${values}
        on conflict (number) do update
          set tenant_id = excluded.tenant_id
        `,
        [tenantId, ...cleaned]
      );
    }

    await client.query("commit");

    await syncRedisDidMapAfterTenantNumbersChange(
      tenantId,
      previousNumbers,
      cleaned
    );
  } catch (err) {
    await safeRollback(client, "setTenantNumbers");
    throw err;
  } finally {
    client.release();
  }
}


export async function upsertConfig(row: ConfigRow): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query(
      `
      insert into tenant_configs (
        tenant_id, config, prompts, stt, tts, forwarding_profiles, pricing,
        business_hours, operator_state, updated_at
      )
      values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, now())
      on conflict (tenant_id) do update
      set config = excluded.config,
          prompts = excluded.prompts,
          stt = excluded.stt,
          tts = excluded.tts,
          forwarding_profiles = excluded.forwarding_profiles,
          pricing = excluded.pricing,
          business_hours = excluded.business_hours,
          operator_state = excluded.operator_state,
          updated_at = now()
    `,
      [
        row.tenant_id,
        row.config,
        row.prompts,
        row.stt,
        row.tts,
        row.forwarding_profiles ?? [],
        row.pricing ?? { items: [], notes: "" },
        JSON.stringify(row.business_hours ?? {}),
        JSON.stringify(row.operator_state ?? {}),
      ]
    );
  } finally {
    client.release();
  }
}

/** List recent calls for a tenant (Postgres). */
export async function listCallsForTenantDb(
  tenantId: string,
  limit: number,
): Promise<
  {
    id: string;
    tenant_id: string;
    caller_id: string | null;
    stage: string | null;
    lead: unknown;
    history: unknown;
    created_at: string;
    updated_at: string;
  }[]
> {
  const client = await pool.connect();
  try {
    const lim = Math.min(Math.max(Number(limit) || 50, 1), 200);
    const r = await client.query(
      `
      select id, tenant_id, caller_id, stage, lead, history, created_at, updated_at
      from calls
      where tenant_id = $1
      order by created_at desc nulls last, updated_at desc, id desc
      limit $2
      `,
      [tenantId, lim],
    );
    return r.rows as any[];
  } finally {
    client.release();
  }
}

export async function findCallByVoiceControlId(
  tenantId: string,
  callControlId: string,
): Promise<{
  id: string;
  tenant_id: string;
  caller_id: string | null;
  stage: string | null;
  lead: unknown;
  history: unknown;
  created_at: string;
  updated_at: string;
} | null> {
  const cc = String(callControlId || "").trim();
  if (!cc) return null;
  const client = await pool.connect();
  try {
    const r = await client.query(
      `
      select id, tenant_id, caller_id, stage, lead, history, created_at, updated_at
      from calls
      where tenant_id = $1
        and lead->>'voiceCallControlId' = $2
      order by updated_at desc
      limit 1
      `,
      [tenantId, cc],
    );
    return (r.rows[0] as any) ?? null;
  } finally {
    client.release();
  }
}

export async function findOpenGreetingCall(
  tenantId: string,
  callerId: string,
): Promise<{
  id: string;
  tenant_id: string;
  caller_id: string | null;
  stage: string | null;
  lead: unknown;
  history: unknown;
  created_at: string;
  updated_at: string;
} | null> {
  const caller = String(callerId || "").trim();
  if (!caller) return null;
  const client = await pool.connect();
  try {
    const r = await client.query(
      `
      select id, tenant_id, caller_id, stage, lead, history, created_at, updated_at
      from calls
      where tenant_id = $1
        and caller_id = $2
        and lower(coalesce(stage, '')) not in ('end', 'ended', 'closed', 'completed', 'missed')
        and created_at > now() - interval '2 hours'
      order by created_at desc
      limit 1
      `,
      [tenantId, caller],
    );
    return (r.rows[0] as any) ?? null;
  } finally {
    client.release();
  }
}

export async function getCallByIdForTenantDb(
  tenantId: string,
  callId: string,
): Promise<{
  id: string;
  tenant_id: string;
  caller_id: string | null;
  stage: string | null;
  lead: unknown;
  history: unknown;
  created_at: string;
  updated_at: string;
} | null> {
  if (!isUuid(callId)) return null;
  const client = await pool.connect();
  try {
    const r = await client.query(
      `
      select id, tenant_id, caller_id, stage, lead, history, created_at, updated_at
      from calls
      where tenant_id = $1 and id = $2::uuid
      limit 1
      `,
      [tenantId, callId],
    );
    return (r.rows[0] as any) ?? null;
  } finally {
    client.release();
  }
}

/** Upsert one call row without wiping other rows for the tenant (call history safe). */
export async function upsertCallRowMerge(row: CallRow): Promise<void> {
  if (!isUuid(row.id)) {
    console.warn("[db] upsertCallRowMerge skipped invalid call id", {
      tenant_id: row.tenant_id,
      callId: row.id,
    });
    return;
  }

  const client = await pool.connect();
  try {
    const leadJson = JSON.stringify(row.lead || {});
    const historyJson = JSON.stringify(row.history || []);
    await client.query(
      `
      insert into calls (id, tenant_id, caller_id, stage, lead, history, created_at, updated_at)
      values ($1, $2, $3, $4, $5::jsonb, $6::jsonb, now(), now())
      on conflict (id) do update
      set caller_id = excluded.caller_id,
          stage = excluded.stage,
          lead = excluded.lead,
          history = excluded.history,
          updated_at = now()
    `,
      [row.id, row.tenant_id, row.caller_id, row.stage, leadJson, historyJson],
    );
  } finally {
    client.release();
  }
}

/**
 * Merge in-memory active calls into Postgres. Does **not** delete historical rows
 * (ended calls must remain for owner portal / admin lists).
 */
export async function upsertCalls(
  tenantId: string,
  calls: CallRow[]
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    for (const call of calls) {
      if (!isUuid(call.id)) {
        console.warn("[db] upsertCalls skipped invalid call id", {
          tenantId,
          callId: call.id,
        });
        continue;
      }
      const leadJson = JSON.stringify(call.lead || {});
      const historyJson = JSON.stringify(call.history || []);
      await client.query(
        `
        insert into calls (id, tenant_id, caller_id, stage, lead, history, created_at, updated_at)
        values ($1, $2, $3, $4, $5::jsonb, $6::jsonb, now(), now())
        on conflict (id) do update
        set caller_id = excluded.caller_id,
            stage = excluded.stage,
            lead = excluded.lead,
            history = excluded.history,
            updated_at = now()
      `,
        [
          call.id,
          tenantId,
          call.caller_id,
          call.stage,
          leadJson,
          historyJson,
        ],
      );
    }
    await client.query("COMMIT");
  } catch (err) {
    await safeRollback(client, "upsertCalls");
    throw err;
  } finally {
    client.release();
  }
}

export async function upsertAnalyticsRow(row: AnalyticsRow): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query(
      `
      insert into analytics (tenant_id, call_count, caller_message_count, question_counts, updated_at)
      values ($1, $2, $3, $4::jsonb, now())
      on conflict (tenant_id) do update
      set call_count = excluded.call_count,
          caller_message_count = excluded.caller_message_count,
          question_counts = excluded.question_counts,
          updated_at = now()
    `,
      [
        row.tenant_id,
        row.call_count,
        row.caller_message_count,
        JSON.stringify(row.question_counts || {}),
      ]
    );
  } finally {
    client.release();
  }
}

export async function insertAdminKey(params: {
  name: string;
  role: string;
  tokenHash: string;
}): Promise<string> {
  const client = await pool.connect();
  try {
    const res = await client.query<{ id: string }>(
      `
      insert into admin_api_keys (name, role, token_hash)
      values ($1, $2, $3)
      returning id
    `,
      [params.name, params.role, params.tokenHash]
    );
    return res.rows[0].id;
  } finally {
    client.release();
  }
}

export async function findAdminKeyByHash(
  tokenHash: string
): Promise<AdminApiKeyRow | undefined> {
  const client = await pool.connect();
  try {
    const res = await client.query<AdminApiKeyRow>(
      "select id, name, role, token_hash, created_at, last_used_at from admin_api_keys where token_hash = $1",
      [tokenHash]
    );
    return res.rows[0];
  } finally {
    client.release();
  }
}

export async function listAdminKeys(): Promise<AdminApiKeyRow[]> {
  const client = await pool.connect();
  try {
    const res = await client.query<AdminApiKeyRow>(
      "select id, name, role, created_at, last_used_at from admin_api_keys order by created_at desc"
    );
    return res.rows;
  } finally {
    client.release();
  }
}

export async function deleteAdminKey(id: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("delete from admin_api_keys where id = $1", [id]);
  } finally {
    client.release();
  }
}

export async function touchAdminKeyUsage(id: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query(
      "update admin_api_keys set last_used_at = now() where id = $1",
      [id]
    );
  } finally {
    client.release();
  }
}

export async function insertAuditLog(params: {
  adminKeyId?: string;
  action: string;
  path?: string;
  tenantId?: string;
  status?: string;
  details?: Record<string, unknown> | null;
}): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query(
      `
      insert into admin_audit_logs (admin_key_id, action, path, tenant_id, status, details)
      values ($1, $2, $3, $4, $5, $6::jsonb)
    `,
      [
        params.adminKeyId || null,
        params.action,
        params.path || null,
        params.tenantId || null,
        params.status || null,
        params.details ? JSON.stringify(params.details) : null,
      ]
    );
  } finally {
    client.release();
  }
}

export async function listAuditLogs(limit = 50): Promise<
  {
    id: string;
    admin_key_id: string | null;
    action: string;
    path: string | null;
    tenant_id: string | null;
    status: string | null;
    details: unknown | null;
    created_at: string;
  }[]
> {
  const client = await pool.connect();
  try {
    const res = await client.query(
      `select id, admin_key_id, action, path, tenant_id, status, details, created_at
       from admin_audit_logs
       order by created_at desc
       limit $1`,
      [limit]
    );
    return res.rows as any[];
  } finally {
    client.release();
  }
}

export async function upsertSecretRow(row: {
  tenantId: string;
  key: string;
  cipher: string;
}): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query(
      `
      insert into tenant_secrets (tenant_id, key, cipher, created_at, updated_at)
      values ($1, $2, $3, now(), now())
      on conflict (tenant_id, key) do update
      set cipher = excluded.cipher,
          updated_at = now()
    `,
      [row.tenantId, row.key, row.cipher]
    );
  } finally {
    client.release();
  }
}

export async function getSecretRow(
  tenantId: string,
  key: string
): Promise<SecretRow | undefined> {
  const client = await pool.connect();
  try {
    const res = await client.query<SecretRow>(
      "select tenant_id, key, cipher from tenant_secrets where tenant_id = $1 and key = $2",
      [tenantId, key]
    );
    return res.rows[0];
  } finally {
    client.release();
  }
}

export async function deleteSecretRow(tenantId: string, key: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("delete from tenant_secrets where tenant_id = $1 and key = $2", [
      tenantId,
      key,
    ]);
  } finally {
    client.release();
  }
}

export async function upsertUserBySub(params: {
  idpSub: string;
  email?: string | null;
}): Promise<UserRow> {
  const idpSub = String(params.idpSub || "").trim();
  if (!idpSub) throw new Error("upsertUserBySub: idpSub required");

  const email =
    params.email === undefined
      ? null
      : params.email
      ? String(params.email).trim()
      : null;

  const client = await pool.connect();
  try {
    // IMPORTANT:
    // - Do NOT insert into users.id (uuid). Let DB generate it (or keep existing).
    // - Use idp_sub (text/unique) as the natural key for upsert.
    const res = await client.query<UserRow>(
      `
      insert into users (email, idp_sub)
      values ($1, $2)
      on conflict (idp_sub) do update
        set email = coalesce(excluded.email, users.email)
      returning id, email, idp_sub
      `,
      [email, idpSub]
    );

    return res.rows[0];
  } finally {
    client.release();
  }
}


export async function listMembershipsForUser(userId: string): Promise<MembershipRow[]> {
  const uid = String(userId || "").trim();
  if (!uid) return [];

  const client = await pool.connect();
  try {
    const res = await client.query<MembershipRow>(
      "select id, tenant_id, user_id, role from tenant_memberships where user_id = $1",
      [uid]
    );
    return res.rows;
  } finally {
    client.release();
  }
}


// ── Owner passcode helpers ─────────────────────────

export async function upsertOwnerPasscode(tenantId: string, passcodeHash: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query(
      `INSERT INTO owner_passcodes (tenant_id, passcode_hash, updated_at)
       VALUES ($1, $2, now())
       ON CONFLICT (tenant_id) DO UPDATE
         SET passcode_hash = $2, updated_at = now()`,
      [tenantId, passcodeHash]
    );
  } finally {
    client.release();
  }
}

export async function getOwnerPasscodeHash(tenantId: string): Promise<string | null> {
  const client = await pool.connect();
  try {
    const res = await client.query<{ passcode_hash: string }>(
      "SELECT passcode_hash FROM owner_passcodes WHERE tenant_id = $1",
      [tenantId]
    );
    return res.rows[0]?.passcode_hash ?? null;
  } finally {
    client.release();
  }
}

// ── Owner portal email + password ─────────────────

export async function getTenantIdByPortalEmail(
  emailNorm: string
): Promise<string | null> {
  const e = String(emailNorm || "").trim();
  if (!e) return null;
  const client = await pool.connect();
  try {
    const res = await client.query<{ tenant_id: string }>(
      "SELECT tenant_id FROM owner_portal_credentials WHERE email_norm = $1",
      [e]
    );
    return res.rows[0]?.tenant_id ?? null;
  } finally {
    client.release();
  }
}

export async function getOwnerPortalCredentialRow(tenantId: string): Promise<{
  emailNorm: string;
  passwordHash: string;
} | null> {
  const client = await pool.connect();
  try {
    const res = await client.query<{ email_norm: string; password_hash: string }>(
      "SELECT email_norm, password_hash FROM owner_portal_credentials WHERE tenant_id = $1",
      [tenantId]
    );
    const row = res.rows[0];
    if (!row) return null;
    return { emailNorm: row.email_norm, passwordHash: row.password_hash };
  } finally {
    client.release();
  }
}

export async function getConsoleCredentialRow(): Promise<{
  emailNorm: string;
  passwordHash: string;
  updatedAt: string | null;
} | null> {
  const client = await pool.connect();
  try {
    const res = await client.query<{
      email_norm: string;
      password_hash: string;
      updated_at: Date | null;
    }>(
      "SELECT email_norm, password_hash, updated_at FROM console_credentials WHERE id = 'console'"
    );
    const row = res.rows[0];
    if (!row) return null;
    return {
      emailNorm: row.email_norm,
      passwordHash: row.password_hash,
      updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null,
    };
  } finally {
    client.release();
  }
}

export async function upsertConsoleCredentials(params: {
  emailNorm: string;
  passwordHash: string;
}): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query(
      `INSERT INTO console_credentials (id, email_norm, password_hash, updated_at)
       VALUES ('console', $1, $2, now())
       ON CONFLICT (id) DO UPDATE
         SET email_norm = excluded.email_norm,
             password_hash = excluded.password_hash,
             updated_at = now()`,
      [params.emailNorm, params.passwordHash]
    );
  } finally {
    client.release();
  }
}

export async function upsertOwnerPortalCredentials(params: {
  tenantId: string;
  emailNorm: string;
  passwordHash: string;
}): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query(
      `INSERT INTO owner_portal_credentials (tenant_id, email_norm, password_hash, updated_at)
       VALUES ($1, $2, $3, now())
       ON CONFLICT (tenant_id) DO UPDATE
         SET email_norm = excluded.email_norm,
             password_hash = excluded.password_hash,
             updated_at = now()`,
      [params.tenantId, params.emailNorm, params.passwordHash]
    );
  } finally {
    client.release();
  }
}

export async function upsertTenantMembership(params: {
  tenantId: string;
  userId: string;
  role: string;
}): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query(
      `INSERT INTO tenant_memberships (tenant_id, user_id, role)
       VALUES ($1, $2, $3)
       ON CONFLICT (tenant_id, user_id) DO UPDATE
         SET role = $3`,
      [params.tenantId, params.userId, params.role]
    );
  } finally {
    client.release();
  }
}

// ── Subscription helpers ──────────────────────────

export interface TenantSubscription {
  tenantId: string;
  planName: string;
  priceCents: number;
  currency: string;
  billingFrequency: string;
  status: string;
  paymentMethodBrand: string | null;
  paymentMethodLast4: string | null;
  trialEndsAt: string | null;
  nextBillingDate: string | null;
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
  cancelledAt: string | null;
  showBillingPortal: boolean;
  adminNotes: string | null;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  stripePriceId: string | null;
  stripeProductId: string | null;
  createdAt: string;
  updatedAt: string;
}

function isoOrNull(value: unknown): string | null {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") return value;
  return null;
}

function rowToSubscription(row: any): TenantSubscription {
  return {
    tenantId: row.tenant_id,
    planName: row.plan_name,
    priceCents: row.price_cents,
    currency: row.currency,
    billingFrequency: row.billing_frequency,
    status: row.status,
    paymentMethodBrand: row.payment_method_brand,
    paymentMethodLast4: row.payment_method_last4,
    trialEndsAt: isoOrNull(row.trial_ends_at),
    nextBillingDate: isoOrNull(row.next_billing_date),
    currentPeriodStart: isoOrNull(row.current_period_start),
    currentPeriodEnd: isoOrNull(row.current_period_end ?? row.next_billing_date),
    cancelledAt: isoOrNull(row.cancelled_at),
    showBillingPortal: row.show_billing_portal,
    adminNotes: row.admin_notes,
    stripeCustomerId: row.stripe_customer_id ?? null,
    stripeSubscriptionId: row.stripe_subscription_id ?? null,
    stripePriceId: row.stripe_price_id ?? null,
    stripeProductId: row.stripe_product_id ?? null,
    createdAt: isoOrNull(row.created_at) || "",
    updatedAt: isoOrNull(row.updated_at) || "",
  };
}

export async function getSubscription(tenantId: string): Promise<TenantSubscription | null> {
  const client = await pool.connect();
  try {
    const res = await client.query(
      "SELECT * FROM tenant_subscriptions WHERE tenant_id = $1",
      [tenantId]
    );
    return res.rows[0] ? rowToSubscription(res.rows[0]) : null;
  } finally {
    client.release();
  }
}

export async function upsertSubscription(
  tenantId: string,
  data: Partial<Omit<TenantSubscription, "tenantId" | "createdAt" | "updatedAt">>
): Promise<TenantSubscription> {
  const client = await pool.connect();
  try {
    const res = await client.query(
      `INSERT INTO tenant_subscriptions (
        tenant_id, plan_name, price_cents, currency, billing_frequency,
        status, payment_method_brand, payment_method_last4,
        trial_ends_at, next_billing_date, current_period_start, current_period_end, cancelled_at,
        show_billing_portal, admin_notes,
        stripe_customer_id, stripe_subscription_id, stripe_price_id, stripe_product_id, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, now())
      ON CONFLICT (tenant_id) DO UPDATE SET
        plan_name = COALESCE($2, tenant_subscriptions.plan_name),
        price_cents = COALESCE($3, tenant_subscriptions.price_cents),
        currency = COALESCE($4, tenant_subscriptions.currency),
        billing_frequency = COALESCE($5, tenant_subscriptions.billing_frequency),
        status = COALESCE($6, tenant_subscriptions.status),
        payment_method_brand = COALESCE($7, tenant_subscriptions.payment_method_brand),
        payment_method_last4 = COALESCE($8, tenant_subscriptions.payment_method_last4),
        trial_ends_at = COALESCE($9, tenant_subscriptions.trial_ends_at),
        next_billing_date = COALESCE($10, tenant_subscriptions.next_billing_date),
        current_period_start = COALESCE($11, tenant_subscriptions.current_period_start),
        current_period_end = COALESCE($12, tenant_subscriptions.current_period_end),
        cancelled_at = $13,
        show_billing_portal = COALESCE($14, tenant_subscriptions.show_billing_portal),
        admin_notes = COALESCE($15, tenant_subscriptions.admin_notes),
        stripe_customer_id = COALESCE($16, tenant_subscriptions.stripe_customer_id),
        stripe_subscription_id = COALESCE($17, tenant_subscriptions.stripe_subscription_id),
        stripe_price_id = COALESCE($18, tenant_subscriptions.stripe_price_id),
        stripe_product_id = COALESCE($19, tenant_subscriptions.stripe_product_id),
        updated_at = now()
      RETURNING *`,
      [
        tenantId,
        data.planName ?? "Starter",
        data.priceCents ?? 0,
        data.currency ?? "usd",
        data.billingFrequency ?? "monthly",
        data.status ?? "trial",
        data.paymentMethodBrand ?? null,
        data.paymentMethodLast4 ?? null,
        data.trialEndsAt ?? null,
        data.nextBillingDate ?? data.currentPeriodEnd ?? null,
        data.currentPeriodStart ?? null,
        data.currentPeriodEnd ?? data.nextBillingDate ?? null,
        data.cancelledAt ?? null,
        data.showBillingPortal ?? true,
        data.adminNotes ?? null,
        data.stripeCustomerId ?? null,
        data.stripeSubscriptionId ?? null,
        data.stripePriceId ?? null,
        data.stripeProductId ?? null,
      ]
    );
    return rowToSubscription(res.rows[0]);
  } finally {
    client.release();
  }
}

export async function persistStripeBilling(
  tenantId: string,
  data: Partial<Omit<TenantSubscription, "tenantId" | "createdAt" | "updatedAt">>,
): Promise<TenantSubscription> {
  return upsertSubscription(tenantId, data);
}

export async function findTenantIdByStripeCustomer(customerId: string): Promise<string | null> {
  const client = await pool.connect();
  try {
    const res = await client.query(
      "SELECT tenant_id FROM tenant_subscriptions WHERE stripe_customer_id = $1 LIMIT 1",
      [customerId],
    );
    return res.rows[0]?.tenant_id ?? null;
  } finally {
    client.release();
  }
}

export async function findTenantIdByStripeSubscription(subscriptionId: string): Promise<string | null> {
  const client = await pool.connect();
  try {
    const res = await client.query(
      "SELECT tenant_id FROM tenant_subscriptions WHERE stripe_subscription_id = $1 LIMIT 1",
      [subscriptionId],
    );
    return res.rows[0]?.tenant_id ?? null;
  } finally {
    client.release();
  }
}

/** Returns true when this event id was newly claimed (not seen before). */
export async function claimStripeWebhookEvent(params: {
  eventId: string;
  eventType: string;
  tenantId?: string | null;
}): Promise<boolean> {
  const client = await pool.connect();
  try {
    const res = await client.query(
      `INSERT INTO stripe_webhook_events (event_id, event_type, tenant_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (event_id) DO NOTHING
       RETURNING event_id`,
      [params.eventId, params.eventType, params.tenantId ?? null],
    );
    return Boolean(res.rows[0]);
  } finally {
    client.release();
  }
}

export async function releaseStripeWebhookEvent(eventId: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("DELETE FROM stripe_webhook_events WHERE event_id = $1", [eventId]);
  } finally {
    client.release();
  }
}

export async function attachStripeWebhookTenant(eventId: string, tenantId: string | null): Promise<void> {
  if (!tenantId) return;
  const client = await pool.connect();
  try {
    await client.query(
      "UPDATE stripe_webhook_events SET tenant_id = $2 WHERE event_id = $1",
      [eventId, tenantId],
    );
  } finally {
    client.release();
  }
}

export interface TenantUsageSnapshot {
  tenantId: string;
  day: string;
  month: string;
  dailyCalls: number;
  monthlyCalls: number;
  monthlyBillableMinutes: number;
  fallbackUsageCount: number;
  activeCalls: number;
}

export interface TenantBillingSummary {
  tenantId: string;
  month: string;
  planTier: string;
  billingStatus: string;
  includedMinutes: number;
  billableMinutes: number;
  overageMinutes: number;
  estimatedOverageChargeCents: number;
  callsCount: number;
}

function rowToTenantLimits(row: any): TenantLimits {
  return {
    planName: row.plan_name,
    planTier: row.plan_tier,
    billingStatus: row.billing_status,
    overageMode: row.overage_mode,
    monthlyMinuteOverageRateCents: row.monthly_minute_overage_rate_cents,
    effectiveFrom: row.effective_from?.toISOString?.() ?? null,
    effectiveUntil: row.effective_until?.toISOString?.() ?? null,
    maxConcurrentCalls: row.max_concurrent_calls,
    includedMonthlyMinutes: row.included_monthly_minutes,
    maxMonthlyMinutesHardCap: row.max_monthly_minutes_hard_cap,
    maxDailyCalls: row.max_daily_calls,
    maxMonthlyCalls: row.max_monthly_calls,
    maxKnowledgeBaseSizeMb: row.max_knowledge_base_size_mb,
    maxIntegrations: row.max_integrations,
    maxLocations: row.max_locations,
    maxPhoneNumbers: row.max_phone_numbers,
    maxAdminUsers: row.max_admin_users,
    maxEscalationContacts: row.max_escalation_contacts,
    afterHoursMode: row.after_hours_mode,
    smsFollowup: row.sms_followup,
    calendarIntegration: row.calendar_integration,
    crmIntegration: row.crm_integration,
    advancedAnalytics: row.advanced_analytics,
    callRecording: row.call_recording,
    transcriptRetention: row.transcript_retention,
    multiLocation: row.multi_location,
    customWorkflows: row.custom_workflows,
    prioritySupport: row.priority_support,
    updatedBy: row.updated_by ?? null,
    updatedAt: row.updated_at?.toISOString?.() ?? null,
  };
}

export async function getTenantLimits(tenantId: string): Promise<TenantLimits> {
  const client = await pool.connect();
  try {
    const res = await client.query("SELECT * FROM tenant_limits WHERE tenant_id = $1", [tenantId]);
    if (res.rows[0]) return rowToTenantLimits(res.rows[0]);
  } finally {
    client.release();
  }
  return getPlanDefaults(RECOMMENDED_DEFAULT_PLAN_TIER);
}

export async function upsertTenantLimits(
  tenantId: string,
  limits: Partial<TenantLimits>,
  updatedBy: string | null,
): Promise<TenantLimits> {
  const current = await getTenantLimits(tenantId);
  const merged = { ...current, ...limits } as TenantLimits;
  const client = await pool.connect();
  try {
    const res = await client.query(
      `INSERT INTO tenant_limits (
        tenant_id, plan_name, plan_tier, billing_status, overage_mode, monthly_minute_overage_rate_cents,
        effective_from, effective_until,
        max_concurrent_calls, included_monthly_minutes, max_monthly_minutes_hard_cap,
        max_daily_calls, max_monthly_calls, max_knowledge_base_size_mb, max_integrations, max_locations,
        max_phone_numbers, max_admin_users, max_escalation_contacts,
        after_hours_mode, sms_followup, calendar_integration, crm_integration, advanced_analytics,
        call_recording, transcript_retention, multi_location, custom_workflows, priority_support,
        updated_by, updated_at
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,now()
      )
      ON CONFLICT (tenant_id) DO UPDATE SET
        plan_name = EXCLUDED.plan_name,
        plan_tier = EXCLUDED.plan_tier,
        billing_status = EXCLUDED.billing_status,
        overage_mode = EXCLUDED.overage_mode,
        monthly_minute_overage_rate_cents = EXCLUDED.monthly_minute_overage_rate_cents,
        effective_from = EXCLUDED.effective_from,
        effective_until = EXCLUDED.effective_until,
        max_concurrent_calls = EXCLUDED.max_concurrent_calls,
        included_monthly_minutes = EXCLUDED.included_monthly_minutes,
        max_monthly_minutes_hard_cap = EXCLUDED.max_monthly_minutes_hard_cap,
        max_daily_calls = EXCLUDED.max_daily_calls,
        max_monthly_calls = EXCLUDED.max_monthly_calls,
        max_knowledge_base_size_mb = EXCLUDED.max_knowledge_base_size_mb,
        max_integrations = EXCLUDED.max_integrations,
        max_locations = EXCLUDED.max_locations,
        max_phone_numbers = EXCLUDED.max_phone_numbers,
        max_admin_users = EXCLUDED.max_admin_users,
        max_escalation_contacts = EXCLUDED.max_escalation_contacts,
        after_hours_mode = EXCLUDED.after_hours_mode,
        sms_followup = EXCLUDED.sms_followup,
        calendar_integration = EXCLUDED.calendar_integration,
        crm_integration = EXCLUDED.crm_integration,
        advanced_analytics = EXCLUDED.advanced_analytics,
        call_recording = EXCLUDED.call_recording,
        transcript_retention = EXCLUDED.transcript_retention,
        multi_location = EXCLUDED.multi_location,
        custom_workflows = EXCLUDED.custom_workflows,
        priority_support = EXCLUDED.priority_support,
        updated_by = EXCLUDED.updated_by,
        updated_at = now()
      RETURNING *`,
      [
        tenantId,
        merged.planName,
        merged.planTier,
        merged.billingStatus,
        merged.overageMode,
        merged.monthlyMinuteOverageRateCents,
        merged.effectiveFrom ?? null,
        merged.effectiveUntil ?? null,
        merged.maxConcurrentCalls,
        merged.includedMonthlyMinutes,
        merged.maxMonthlyMinutesHardCap,
        merged.maxDailyCalls,
        merged.maxMonthlyCalls,
        merged.maxKnowledgeBaseSizeMb,
        merged.maxIntegrations,
        merged.maxLocations,
        merged.maxPhoneNumbers,
        merged.maxAdminUsers,
        merged.maxEscalationContacts,
        merged.afterHoursMode,
        merged.smsFollowup,
        merged.calendarIntegration,
        merged.crmIntegration,
        merged.advancedAnalytics,
        merged.callRecording,
        merged.transcriptRetention,
        merged.multiLocation,
        merged.customWorkflows,
        merged.prioritySupport,
        updatedBy,
      ],
    );
    return rowToTenantLimits(res.rows[0]);
  } finally {
    client.release();
  }
}

export async function resetTenantLimitsToPlanDefaults(
  tenantId: string,
  planTier: TenantLimits["planTier"],
  updatedBy: string | null,
): Promise<TenantLimits> {
  const defaults = getPlanDefaults(planTier);
  return upsertTenantLimits(tenantId, defaults, updatedBy);
}

/** Apply tier defaults without flipping staff-controlled Service / billingStatus. */
export async function applyPlanTierDefaultsKeepingService(
  tenantId: string,
  planTier: TenantLimits["planTier"],
  updatedBy: string | null,
): Promise<TenantLimits> {
  const current = await getTenantLimits(tenantId);
  const defaults = getPlanDefaults(planTier);
  return upsertTenantLimits(tenantId, { ...defaults, billingStatus: current.billingStatus }, updatedBy);
}

export async function setTenantBillingStatus(
  tenantId: string,
  billingStatus: TenantLimits["billingStatus"],
  updatedBy: string | null,
): Promise<TenantLimits> {
  return upsertTenantLimits(tenantId, { billingStatus }, updatedBy);
}

function monthKey(now = new Date()): string {
  return now.toISOString().slice(0, 7);
}

export async function recordTenantCallStarted(tenantId: string, at = new Date()): Promise<void> {
  const day = at.toISOString().slice(0, 10);
  const month = monthKey(at);
  const client = await pool.connect();
  try {
    await client.query(
      `INSERT INTO tenant_usage_daily (tenant_id, usage_date, calls_count, updated_at)
       VALUES ($1, $2::date, 1, now())
       ON CONFLICT (tenant_id, usage_date) DO UPDATE
         SET calls_count = tenant_usage_daily.calls_count + 1, updated_at = now()`,
      [tenantId, day],
    );
    await client.query(
      `INSERT INTO tenant_usage_monthly (tenant_id, usage_month, calls_count, updated_at)
       VALUES ($1, $2, 1, now())
       ON CONFLICT (tenant_id, usage_month) DO UPDATE
         SET calls_count = tenant_usage_monthly.calls_count + 1, updated_at = now()`,
      [tenantId, month],
    );
  } finally {
    client.release();
  }
}

export async function recordTenantCallEnded(params: {
  tenantId: string;
  durationMs?: number;
  fallbackUsed?: boolean;
  providerUsage?: Record<string, number>;
  at?: Date;
}): Promise<void> {
  const at = params.at ?? new Date();
  const day = at.toISOString().slice(0, 10);
  const month = monthKey(at);
  const minutes = Math.max(0, Math.ceil((params.durationMs ?? 0) / 60000));
  const fallbackInc = params.fallbackUsed ? 1 : 0;
  const providerUsage = JSON.stringify(params.providerUsage ?? {});
  const client = await pool.connect();
  try {
    await client.query(
      `INSERT INTO tenant_usage_daily (tenant_id, usage_date, billable_minutes, fallback_usage_count, updated_at)
       VALUES ($1, $2::date, $3, $4, now())
       ON CONFLICT (tenant_id, usage_date) DO UPDATE
         SET billable_minutes = tenant_usage_daily.billable_minutes + EXCLUDED.billable_minutes,
             fallback_usage_count = tenant_usage_daily.fallback_usage_count + EXCLUDED.fallback_usage_count,
             updated_at = now()`,
      [params.tenantId, day, minutes, fallbackInc],
    );
    await client.query(
      `INSERT INTO tenant_usage_monthly (tenant_id, usage_month, billable_minutes, fallback_usage_count, provider_usage, updated_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, now())
       ON CONFLICT (tenant_id, usage_month) DO UPDATE
         SET billable_minutes = tenant_usage_monthly.billable_minutes + EXCLUDED.billable_minutes,
             fallback_usage_count = tenant_usage_monthly.fallback_usage_count + EXCLUDED.fallback_usage_count,
             provider_usage = tenant_usage_monthly.provider_usage || EXCLUDED.provider_usage,
             updated_at = now()`,
      [params.tenantId, month, minutes, fallbackInc, providerUsage],
    );
  } finally {
    client.release();
  }
}

export async function getTenantUsageSnapshot(tenantId: string, at = new Date()): Promise<TenantUsageSnapshot> {
  const day = at.toISOString().slice(0, 10);
  const month = monthKey(at);
  const client = await pool.connect();
  try {
    const [daily, monthly, active] = await Promise.all([
      client.query(
        "SELECT calls_count, billable_minutes, fallback_usage_count FROM tenant_usage_daily WHERE tenant_id = $1 AND usage_date = $2::date",
        [tenantId, day],
      ),
      client.query(
        "SELECT calls_count, billable_minutes, fallback_usage_count FROM tenant_usage_monthly WHERE tenant_id = $1 AND usage_month = $2",
        [tenantId, month],
      ),
      client.query(
        `SELECT COUNT(*)::int AS n FROM calls
         WHERE tenant_id = $1
           AND lower(COALESCE(stage, '')) NOT IN ('end', 'ended', 'closed', 'completed', 'missed')
           AND updated_at > now() - interval '30 minutes'`,
        [tenantId],
      ),
    ]);
    return {
      tenantId,
      day,
      month,
      dailyCalls: Number(daily.rows[0]?.calls_count ?? 0),
      monthlyCalls: Number(monthly.rows[0]?.calls_count ?? 0),
      monthlyBillableMinutes: Number(monthly.rows[0]?.billable_minutes ?? 0),
      fallbackUsageCount: Number(monthly.rows[0]?.fallback_usage_count ?? 0),
      activeCalls: Number(active.rows[0]?.n ?? 0),
    };
  } finally {
    client.release();
  }
}

export async function getTenantBillingSummary(tenantId: string, month: string): Promise<TenantBillingSummary> {
  const limits = await getTenantLimits(tenantId);
  const client = await pool.connect();
  try {
    const monthly = await client.query(
      "SELECT calls_count, billable_minutes FROM tenant_usage_monthly WHERE tenant_id = $1 AND usage_month = $2",
      [tenantId, month],
    );
    const callsCount = Number(monthly.rows[0]?.calls_count ?? 0);
    const billableMinutes = Number(monthly.rows[0]?.billable_minutes ?? 0);
    const overageMinutes = Math.max(0, billableMinutes - limits.includedMonthlyMinutes);
    const estimatedOverageChargeCents = overageMinutes * limits.monthlyMinuteOverageRateCents;
    return {
      tenantId,
      month,
      planTier: limits.planTier,
      billingStatus: limits.billingStatus,
      includedMinutes: limits.includedMonthlyMinutes,
      billableMinutes,
      overageMinutes,
      estimatedOverageChargeCents,
      callsCount,
    };
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// Call Quality Analytics (tenant-scoped)
// ---------------------------------------------------------------------------

export type RawAudioDiagnosticsMode =
  | "off"
  | "next_call_only"
  | "failed_calls_only"
  | "all_calls_temporary";

export interface TenantCallQualitySettingsRow {
  tenant_id: string;
  call_quality_analytics_enabled: boolean;
  transcript_storage_enabled: boolean;
  transcript_retention_days: number;
  raw_audio_diagnostics_mode: RawAudioDiagnosticsMode;
  raw_audio_diagnostics_expires_at: string | null;
  raw_audio_diagnostics_enabled_by: string | null;
  raw_audio_diagnostics_reason: string | null;
  raw_audio_diagnostics_next_call_pending: boolean;
  quality_summary_visible_to_client: boolean;
  raw_artifacts_visible_to_client: boolean;
  updated_at: string;
}

function mapCallQualityRow(row: any): TenantCallQualitySettingsRow {
  return {
    tenant_id: row.tenant_id,
    call_quality_analytics_enabled: !!row.call_quality_analytics_enabled,
    transcript_storage_enabled: !!row.transcript_storage_enabled,
    transcript_retention_days: Number(row.transcript_retention_days ?? 30),
    raw_audio_diagnostics_mode: row.raw_audio_diagnostics_mode as RawAudioDiagnosticsMode,
    raw_audio_diagnostics_expires_at: row.raw_audio_diagnostics_expires_at
      ? new Date(row.raw_audio_diagnostics_expires_at).toISOString()
      : null,
    raw_audio_diagnostics_enabled_by: row.raw_audio_diagnostics_enabled_by ?? null,
    raw_audio_diagnostics_reason: row.raw_audio_diagnostics_reason ?? null,
    raw_audio_diagnostics_next_call_pending: !!row.raw_audio_diagnostics_next_call_pending,
    quality_summary_visible_to_client: !!row.quality_summary_visible_to_client,
    raw_artifacts_visible_to_client: !!row.raw_artifacts_visible_to_client,
    updated_at: new Date(row.updated_at).toISOString(),
  };
}

/** Ensures a row exists and returns current settings (safe defaults). */
export async function getTenantCallQualitySettings(
  tenantId: string
): Promise<TenantCallQualitySettingsRow> {
  const client = await pool.connect();
  try {
    await client.query(
      `insert into tenant_call_quality_settings (tenant_id) values ($1)
       on conflict (tenant_id) do nothing`,
      [tenantId]
    );
    const res = await client.query(
      `select * from tenant_call_quality_settings where tenant_id = $1 limit 1`,
      [tenantId]
    );
    const row = res.rows[0];
    if (!row) {
      throw new Error("call_quality_settings_missing");
    }
    return mapCallQualityRow(row);
  } finally {
    client.release();
  }
}

export interface TenantCallQualityPatch {
  callQualityAnalyticsEnabled?: boolean;
  transcriptStorageEnabled?: boolean;
  transcriptRetentionDays?: number;
  rawAudioDiagnosticsMode?: RawAudioDiagnosticsMode;
  rawAudioDiagnosticsExpiresAt?: string | null;
  rawAudioDiagnosticsEnabledBy?: string | null;
  rawAudioDiagnosticsReason?: string | null;
  rawAudioDiagnosticsNextCallPending?: boolean;
  qualitySummaryVisibleToClient?: boolean;
  rawArtifactsVisibleToClient?: boolean;
}

export async function updateTenantCallQualitySettings(
  tenantId: string,
  patch: TenantCallQualityPatch
): Promise<TenantCallQualitySettingsRow> {
  const cur = await getTenantCallQualitySettings(tenantId);
  const next: TenantCallQualitySettingsRow = {
    ...cur,
    ...(patch.callQualityAnalyticsEnabled !== undefined
      ? { call_quality_analytics_enabled: patch.callQualityAnalyticsEnabled }
      : {}),
    ...(patch.transcriptStorageEnabled !== undefined
      ? { transcript_storage_enabled: patch.transcriptStorageEnabled }
      : {}),
    ...(patch.transcriptRetentionDays !== undefined
      ? { transcript_retention_days: patch.transcriptRetentionDays }
      : {}),
    ...(patch.rawAudioDiagnosticsMode !== undefined
      ? { raw_audio_diagnostics_mode: patch.rawAudioDiagnosticsMode }
      : {}),
    ...(patch.rawAudioDiagnosticsExpiresAt !== undefined
      ? {
          raw_audio_diagnostics_expires_at: patch.rawAudioDiagnosticsExpiresAt,
        }
      : {}),
    ...(patch.rawAudioDiagnosticsEnabledBy !== undefined
      ? { raw_audio_diagnostics_enabled_by: patch.rawAudioDiagnosticsEnabledBy }
      : {}),
    ...(patch.rawAudioDiagnosticsReason !== undefined
      ? { raw_audio_diagnostics_reason: patch.rawAudioDiagnosticsReason }
      : {}),
    ...(patch.rawAudioDiagnosticsNextCallPending !== undefined
      ? {
          raw_audio_diagnostics_next_call_pending: patch.rawAudioDiagnosticsNextCallPending,
        }
      : {}),
    ...(patch.qualitySummaryVisibleToClient !== undefined
      ? {
          quality_summary_visible_to_client: patch.qualitySummaryVisibleToClient,
        }
      : {}),
    ...(patch.rawArtifactsVisibleToClient !== undefined
      ? {
          raw_artifacts_visible_to_client: patch.rawArtifactsVisibleToClient,
        }
      : {}),
  };

  const client = await pool.connect();
  try {
    await client.query(
      `
      update tenant_call_quality_settings set
        call_quality_analytics_enabled = $2,
        transcript_storage_enabled = $3,
        transcript_retention_days = $4,
        raw_audio_diagnostics_mode = $5,
        raw_audio_diagnostics_expires_at = $6,
        raw_audio_diagnostics_enabled_by = $7,
        raw_audio_diagnostics_reason = $8,
        raw_audio_diagnostics_next_call_pending = $9,
        quality_summary_visible_to_client = $10,
        raw_artifacts_visible_to_client = $11,
        updated_at = now()
      where tenant_id = $1
    `,
      [
        tenantId,
        next.call_quality_analytics_enabled,
        next.transcript_storage_enabled,
        next.transcript_retention_days,
        next.raw_audio_diagnostics_mode,
        next.raw_audio_diagnostics_expires_at,
        next.raw_audio_diagnostics_enabled_by,
        next.raw_audio_diagnostics_reason,
        next.raw_audio_diagnostics_next_call_pending,
        next.quality_summary_visible_to_client,
        next.raw_artifacts_visible_to_client,
      ]
    );
    return next;
  } finally {
    client.release();
  }
}

/**
 * After the voice runtime starts a call that consumed "next call only" diagnostics,
 * clear the one-shot latch and turn mode off.
 */
export async function consumeTenantNextCallDiagnostics(
  tenantId: string
): Promise<TenantCallQualitySettingsRow> {
  const client = await pool.connect();
  try {
    await client.query(
      `
      update tenant_call_quality_settings
      set
        raw_audio_diagnostics_next_call_pending = false,
        raw_audio_diagnostics_mode = case
          when raw_audio_diagnostics_mode in ('next_call_only', 'failed_calls_only') then 'off'
          else raw_audio_diagnostics_mode
        end,
        updated_at = now()
      where tenant_id = $1
        and raw_audio_diagnostics_next_call_pending = true
        and raw_audio_diagnostics_mode in ('next_call_only', 'failed_calls_only')
    `,
      [tenantId]
    );
    return getTenantCallQualitySettings(tenantId);
  } finally {
    client.release();
  }
}

/** Auto-disable expired temporary all-calls diagnostics. */
export async function expireStaleRawAudioDiagnostics(): Promise<{ tenantsUpdated: string[] }> {
  const client = await pool.connect();
  try {
    const res = await client.query<{ tenant_id: string }>(
      `
      update tenant_call_quality_settings
      set
        raw_audio_diagnostics_mode = 'off',
        raw_audio_diagnostics_next_call_pending = false,
        raw_audio_diagnostics_expires_at = null,
        updated_at = now()
      where raw_audio_diagnostics_mode = 'all_calls_temporary'
        and raw_audio_diagnostics_expires_at is not null
        and raw_audio_diagnostics_expires_at < now()
      returning tenant_id
    `
    );
    return { tenantsUpdated: res.rows.map((r) => r.tenant_id) };
  } finally {
    client.release();
  }
}

export async function upsertCallQualitySummary(params: {
  tenantId: string;
  callControlId: string;
  summary: unknown;
}): Promise<boolean> {
  const cc = sanitizeCallControlId(params.callControlId);
  if (!cc) return false;
  const client = await pool.connect();
  try {
    await client.query(
      `
      insert into call_quality_summaries (tenant_id, call_control_id, summary, updated_at)
      values ($1, $2, $3::jsonb, now())
      on conflict (tenant_id, call_control_id) do update
      set summary = excluded.summary,
          updated_at = now()
    `,
      [params.tenantId, cc, JSON.stringify(params.summary)]
    );
    return true;
  } finally {
    client.release();
  }
}

export async function getCallQualitySummaryForCall(
  tenantId: string,
  callControlId: string
): Promise<{ summary: unknown; updatedAt: string } | null> {
  const cc = sanitizeCallControlId(callControlId);
  if (!cc) return null;
  const client = await pool.connect();
  try {
    const res = await client.query(
      `select summary, updated_at from call_quality_summaries
       where tenant_id = $1 and call_control_id = $2 limit 1`,
      [tenantId, cc]
    );
    const row = res.rows[0];
    if (!row) return null;
    return {
      summary: row.summary,
      updatedAt: new Date(row.updated_at).toISOString(),
    };
  } finally {
    client.release();
  }
}

export async function closePool(): Promise<void> {
  await pool.end();
}

export async function pingPool(): Promise<boolean> {
  try {
    const client = await pool.connect();
    try {
      await client.query("SELECT 1");
      return true;
    } finally {
      client.release();
    }
  } catch {
    return false;
  }
}
