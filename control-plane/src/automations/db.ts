/**
 * Database helpers for the workflow automation engine.
 */

import { pool } from "../db";
import type {
  Workflow, WorkflowRun, Lead, RunStatus,
  TriggerType, TriggerConfig, WorkflowStep, WorkflowSettings,
} from "./types";

// ── Row mappers ──────────────────────────────────

function rowToWorkflow(r: any): Workflow {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    name: r.name,
    enabled: r.enabled,
    triggerType: r.trigger_type as TriggerType,
    triggerConfig: r.trigger_config ?? {},
    steps: r.steps ?? [],
    createdBy: r.created_by,
    adminLocked: r.admin_locked,
    templateId: r.template_id ?? null,
    createdAt: r.created_at?.toISOString?.() ?? r.created_at,
    updatedAt: r.updated_at?.toISOString?.() ?? r.updated_at,
  };
}

function rowToRun(r: any): WorkflowRun {
  return {
    id: r.id,
    workflowId: r.workflow_id,
    tenantId: r.tenant_id,
    triggerEvent: r.trigger_event ?? {},
    status: r.status as RunStatus,
    stepsCompleted: r.steps_completed,
    stepsTotal: r.steps_total,
    result: r.result ?? [],
    error: r.error ?? null,
    startedAt: r.started_at?.toISOString?.() ?? r.started_at,
    completedAt: r.completed_at?.toISOString?.() ?? r.completed_at ?? null,
    workflowName: r.workflow_name ?? undefined,
  };
}

const LEAD_STAGES = new Set(["inquiry", "qualified", "ready_to_book", "booked", "lost"]);

function rowToLead(r: any): Lead {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    callId: r.call_id ?? null,
    name: r.name ?? null,
    phone: r.phone ?? null,
    email: r.email ?? null,
    issue: r.issue ?? null,
    category: r.category ?? null,
    priority: r.priority ?? "normal",
    notes: r.notes ?? null,
    rawExtract: r.raw_extract ?? null,
    sourceWorkflowId: r.source_workflow_id ?? null,
    createdAt: r.created_at?.toISOString?.() ?? r.created_at,
  };
}

/** Extra fields the admin/portal lead table actually renders. */
export function presentLead(lead: Lead): Lead & {
  intent: string | null;
  stage: string;
  updatedAt: string;
  callerDisplay: string | null;
  needsAttention: boolean;
} {
  const raw = lead.rawExtract && typeof lead.rawExtract === "object" ? lead.rawExtract : {};
  const rawStage = String(raw.stage || raw.leadStage || "").toLowerCase();
  const category = String(lead.category || "").toLowerCase();
  const stage = LEAD_STAGES.has(rawStage) ? rawStage : LEAD_STAGES.has(category) ? category : "inquiry";
  const intent =
    lead.issue ||
    (typeof raw.intent === "string" ? raw.intent : null) ||
    (typeof raw.interestedIn === "string" ? raw.interestedIn : null) ||
    (typeof raw.service === "string" ? raw.service : null) ||
    lead.category ||
    null;
  return {
    ...lead,
    intent,
    stage,
    updatedAt: lead.createdAt,
    callerDisplay: lead.phone || null,
    needsAttention: lead.priority === "high" || lead.priority === "urgent" || raw.needsAttention === true,
  };
}

// ── Workflows CRUD ───────────────────────────────

export async function listWorkflows(tenantId: string): Promise<Workflow[]> {
  const client = await pool.connect();
  try {
    const res = await client.query(
      "SELECT * FROM workflows WHERE tenant_id = $1 ORDER BY created_at DESC",
      [tenantId]
    );
    return res.rows.map(rowToWorkflow);
  } finally {
    client.release();
  }
}

export async function getWorkflow(id: string): Promise<Workflow | null> {
  const client = await pool.connect();
  try {
    const res = await client.query("SELECT * FROM workflows WHERE id = $1", [id]);
    return res.rows[0] ? rowToWorkflow(res.rows[0]) : null;
  } finally {
    client.release();
  }
}

export async function getEnabledWorkflowsByTrigger(
  tenantId: string,
  triggerType: TriggerType
): Promise<Workflow[]> {
  const client = await pool.connect();
  try {
    const res = await client.query(
      "SELECT * FROM workflows WHERE tenant_id = $1 AND trigger_type = $2 AND enabled = true",
      [tenantId, triggerType]
    );
    return res.rows.map(rowToWorkflow);
  } finally {
    client.release();
  }
}

export async function createWorkflow(params: {
  tenantId: string;
  name: string;
  triggerType: TriggerType;
  triggerConfig: TriggerConfig;
  steps: WorkflowStep[];
  createdBy?: string;
  adminLocked?: boolean;
  enabled?: boolean;
  templateId?: string | null;
}): Promise<Workflow> {
  const client = await pool.connect();
  try {
    const res = await client.query(
      `INSERT INTO workflows (tenant_id, name, trigger_type, trigger_config, steps, created_by, admin_locked, enabled, template_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [
        params.tenantId,
        params.name,
        params.triggerType,
        JSON.stringify(params.triggerConfig),
        JSON.stringify(params.steps),
        params.createdBy ?? "admin",
        params.adminLocked ?? false,
        params.enabled ?? true,
        params.templateId ?? null,
      ]
    );
    return rowToWorkflow(res.rows[0]);
  } finally {
    client.release();
  }
}

export async function updateWorkflow(
  id: string,
  data: Partial<Pick<Workflow, "name" | "enabled" | "triggerType" | "triggerConfig" | "steps" | "adminLocked" | "templateId">>
): Promise<Workflow | null> {
  const sets: string[] = [];
  const vals: any[] = [];
  let idx = 1;

  if (data.name !== undefined) { sets.push(`name = $${idx++}`); vals.push(data.name); }
  if (data.enabled !== undefined) { sets.push(`enabled = $${idx++}`); vals.push(data.enabled); }
  if (data.triggerType !== undefined) { sets.push(`trigger_type = $${idx++}`); vals.push(data.triggerType); }
  if (data.triggerConfig !== undefined) { sets.push(`trigger_config = $${idx++}`); vals.push(JSON.stringify(data.triggerConfig)); }
  if (data.steps !== undefined) { sets.push(`steps = $${idx++}`); vals.push(JSON.stringify(data.steps)); }
  if (data.adminLocked !== undefined) { sets.push(`admin_locked = $${idx++}`); vals.push(data.adminLocked); }
  if (data.templateId !== undefined) { sets.push(`template_id = $${idx++}`); vals.push(data.templateId); }

  if (sets.length === 0) return getWorkflow(id);

  sets.push(`updated_at = now()`);
  vals.push(id);

  const client = await pool.connect();
  try {
    const res = await client.query(
      `UPDATE workflows SET ${sets.join(", ")} WHERE id = $${idx} RETURNING *`,
      vals
    );
    return res.rows[0] ? rowToWorkflow(res.rows[0]) : null;
  } finally {
    client.release();
  }
}

export async function deleteWorkflow(id: string): Promise<boolean> {
  const client = await pool.connect();
  try {
    const res = await client.query("DELETE FROM workflows WHERE id = $1", [id]);
    return (res.rowCount ?? 0) > 0;
  } finally {
    client.release();
  }
}

// ── Workflow Runs ────────────────────────────────

export async function createRun(params: {
  workflowId: string;
  tenantId: string;
  triggerEvent: Record<string, any>;
  stepsTotal: number;
}): Promise<WorkflowRun> {
  const client = await pool.connect();
  try {
    const res = await client.query(
      `INSERT INTO workflow_runs (workflow_id, tenant_id, trigger_event, status, steps_total)
       VALUES ($1, $2, $3, 'running', $4)
       RETURNING *`,
      [params.workflowId, params.tenantId, JSON.stringify(params.triggerEvent), params.stepsTotal]
    );
    return rowToRun(res.rows[0]);
  } finally {
    client.release();
  }
}

export async function updateRun(
  id: string,
  data: Partial<Pick<WorkflowRun, "status" | "stepsCompleted" | "result" | "error">>
): Promise<void> {
  const sets: string[] = [];
  const vals: any[] = [];
  let idx = 1;

  if (data.status !== undefined) { sets.push(`status = $${idx++}`); vals.push(data.status); }
  if (data.stepsCompleted !== undefined) { sets.push(`steps_completed = $${idx++}`); vals.push(data.stepsCompleted); }
  if (data.result !== undefined) { sets.push(`result = $${idx++}`); vals.push(JSON.stringify(data.result)); }
  if (data.error !== undefined) { sets.push(`error = $${idx++}`); vals.push(data.error); }

  if (data.status === "completed" || data.status === "failed") {
    sets.push(`completed_at = now()`);
  }

  if (sets.length === 0) return;

  vals.push(id);
  const client = await pool.connect();
  try {
    await client.query(
      `UPDATE workflow_runs SET ${sets.join(", ")} WHERE id = $${idx}`,
      vals
    );
  } finally {
    client.release();
  }
}

export async function listRuns(
  tenantId: string,
  limit = 50,
  options: { since?: string; timezone?: string; today?: boolean } = {},
): Promise<WorkflowRun[]> {
  const client = await pool.connect();
  try {
    const tz = options.timezone || "America/Los_Angeles";
    const clauses = ["r.tenant_id = $1"];
    const vals: any[] = [tenantId];
    let idx = 2;
    if (options.today) {
      clauses.push(
        `r.started_at >= (date_trunc('day', timezone($${idx}, now())) AT TIME ZONE $${idx})`,
      );
      vals.push(tz);
      idx += 1;
    } else if (options.since) {
      clauses.push(`r.started_at >= $${idx}::timestamptz`);
      vals.push(options.since);
      idx += 1;
    }
    vals.push(limit);
    const res = await client.query(
      `SELECT r.*, w.name AS workflow_name
       FROM workflow_runs r
       LEFT JOIN workflows w ON w.id = r.workflow_id
       WHERE ${clauses.join(" AND ")}
       ORDER BY r.started_at DESC
       LIMIT $${idx}`,
      vals,
    );
    return res.rows.map(rowToRun);
  } finally {
    client.release();
  }
}

export async function getWorkflowByTemplate(
  tenantId: string,
  templateId: string,
): Promise<Workflow | null> {
  const client = await pool.connect();
  try {
    const res = await client.query(
      "SELECT * FROM workflows WHERE tenant_id = $1 AND template_id = $2 LIMIT 1",
      [tenantId, templateId],
    );
    return res.rows[0] ? rowToWorkflow(res.rows[0]) : null;
  } finally {
    client.release();
  }
}

// ── Leads ────────────────────────────────────────

export async function createLead(params: {
  tenantId: string;
  callId?: string;
  name?: string;
  phone?: string;
  email?: string;
  issue?: string;
  category?: string;
  priority?: string;
  notes?: string;
  rawExtract?: Record<string, any>;
  sourceWorkflowId?: string;
}): Promise<Lead> {
  const client = await pool.connect();
  try {
    const res = await client.query(
      `INSERT INTO leads (tenant_id, call_id, name, phone, email, issue, category, priority, notes, raw_extract, source_workflow_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING *`,
      [
        params.tenantId,
        params.callId ?? null,
        params.name ?? null,
        params.phone ?? null,
        params.email ?? null,
        params.issue ?? null,
        params.category ?? null,
        params.priority ?? "normal",
        params.notes ?? null,
        params.rawExtract ? JSON.stringify(params.rawExtract) : null,
        params.sourceWorkflowId ?? null,
      ]
    );
    return rowToLead(res.rows[0]);
  } finally {
    client.release();
  }
}

export async function listLeads(
  tenantId: string,
  limit = 100
): Promise<Lead[]> {
  const client = await pool.connect();
  try {
    const res = await client.query(
      "SELECT * FROM leads WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT $2",
      [tenantId, limit]
    );
    return res.rows.map((row) => presentLead(rowToLead(row)));
  } finally {
    client.release();
  }
}

/**
 * Delete a lead, optionally scoped to a tenant. When `tenantId` is provided the
 * delete only succeeds if the lead also belongs to that tenant. This prevents
 * cross-tenant lead deletion via guessed/leaked UUIDs.
 */
export async function deleteLead(id: string, tenantId?: string): Promise<boolean> {
  const client = await pool.connect();
  try {
    const res = tenantId
      ? await client.query(
          "DELETE FROM leads WHERE id = $1 AND tenant_id = $2",
          [id, tenantId]
        )
      : await client.query("DELETE FROM leads WHERE id = $1", [id]);
    return (res.rowCount ?? 0) > 0;
  } finally {
    client.release();
  }
}

// ── Workflow Settings ────────────────────────────

export async function getWorkflowSettings(tenantId: string): Promise<WorkflowSettings> {
  const client = await pool.connect();
  try {
    const res = await client.query(
      "SELECT workflow_settings FROM tenant_configs WHERE tenant_id = $1",
      [tenantId]
    );
    return res.rows[0]?.workflow_settings ?? { ownerCanEdit: false };
  } finally {
    client.release();
  }
}

export async function updateWorkflowSettings(
  tenantId: string,
  settings: Partial<WorkflowSettings>
): Promise<WorkflowSettings> {
  const client = await pool.connect();
  try {
    const current = await getWorkflowSettings(tenantId);
    const merged = { ...current, ...settings };
    await client.query(
      `UPDATE tenant_configs SET workflow_settings = $2 WHERE tenant_id = $1`,
      [tenantId, JSON.stringify(merged)]
    );
    return merged;
  } finally {
    client.release();
  }
}

// ── Scheduled workflows ─────────────────────────

export async function getScheduledWorkflows(): Promise<Workflow[]> {
  const client = await pool.connect();
  try {
    const res = await client.query(
      "SELECT * FROM workflows WHERE trigger_type = 'scheduled' AND enabled = true"
    );
    return res.rows.map(rowToWorkflow);
  } finally {
    client.release();
  }
}

export async function findLeadByCallId(
  tenantId: string,
  callId: string,
): Promise<Lead | null> {
  const client = await pool.connect();
  try {
    const res = await client.query(
      "SELECT * FROM leads WHERE tenant_id = $1 AND call_id = $2 ORDER BY created_at DESC LIMIT 1",
      [tenantId, callId],
    );
    return res.rows[0] ? rowToLead(res.rows[0]) : null;
  } finally {
    client.release();
  }
}

export async function updateLead(
  id: string,
  data: Partial<Pick<Lead, "name" | "phone" | "email" | "issue" | "category" | "priority" | "notes" | "rawExtract">>,
): Promise<Lead | null> {
  const sets: string[] = [];
  const vals: any[] = [];
  let idx = 1;
  if (data.name !== undefined) { sets.push(`name = $${idx++}`); vals.push(data.name); }
  if (data.phone !== undefined) { sets.push(`phone = $${idx++}`); vals.push(data.phone); }
  if (data.email !== undefined) { sets.push(`email = $${idx++}`); vals.push(data.email); }
  if (data.issue !== undefined) { sets.push(`issue = $${idx++}`); vals.push(data.issue); }
  if (data.category !== undefined) { sets.push(`category = $${idx++}`); vals.push(data.category); }
  if (data.priority !== undefined) { sets.push(`priority = $${idx++}`); vals.push(data.priority); }
  if (data.notes !== undefined) { sets.push(`notes = $${idx++}`); vals.push(data.notes); }
  if (data.rawExtract !== undefined) {
    sets.push(`raw_extract = $${idx++}`);
    vals.push(JSON.stringify(data.rawExtract));
  }
  if (!sets.length) {
    const client = await pool.connect();
    try {
      const res = await client.query("SELECT * FROM leads WHERE id = $1", [id]);
      return res.rows[0] ? rowToLead(res.rows[0]) : null;
    } finally {
      client.release();
    }
  }
  vals.push(id);
  const client = await pool.connect();
  try {
    const res = await client.query(
      `UPDATE leads SET ${sets.join(", ")} WHERE id = $${idx} RETURNING *`,
      vals,
    );
    return res.rows[0] ? rowToLead(res.rows[0]) : null;
  } finally {
    client.release();
  }
}

export async function claimWorkflowFollowup(params: {
  tenantId: string;
  callId: string;
  kind: string;
  workflowId?: string;
  dueAt?: string;
  payload?: Record<string, unknown>;
}): Promise<{ claimed: boolean; id?: string }> {
  const client = await pool.connect();
  try {
    const existing = await client.query(
      `SELECT id, sent_at FROM workflow_followups
       WHERE tenant_id = $1 AND call_id = $2 AND kind = $3`,
      [params.tenantId, params.callId, params.kind],
    );
    if (existing.rows[0]?.sent_at) return { claimed: false, id: existing.rows[0].id };
    if (existing.rows[0]) {
      const claimed = await client.query(
        `UPDATE workflow_followups
         SET sent_at = now(), payload = COALESCE(payload, '{}'::jsonb) || $2::jsonb
         WHERE id = $1 AND sent_at IS NULL
         RETURNING id`,
        [existing.rows[0].id, JSON.stringify(params.payload || {})],
      );
      return { claimed: (claimed.rowCount ?? 0) > 0, id: existing.rows[0].id };
    }
    const inserted = await client.query(
      `INSERT INTO workflow_followups (tenant_id, workflow_id, call_id, kind, due_at, sent_at, payload)
       VALUES ($1, $2, $3, $4, $5, now(), $6)
       ON CONFLICT (tenant_id, call_id, kind) DO NOTHING
       RETURNING id`,
      [
        params.tenantId,
        params.workflowId ?? null,
        params.callId,
        params.kind,
        params.dueAt || new Date().toISOString(),
        JSON.stringify(params.payload || {}),
      ],
    );
    return { claimed: (inserted.rowCount ?? 0) > 0, id: inserted.rows[0]?.id };
  } finally {
    client.release();
  }
}
