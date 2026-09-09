import { pool } from "../db";
import {
  CUTOVER_ITEM_IDS,
  normalizeShopPlaybook,
  type CallCompletion,
  type ShopPlaybook,
} from "@veralux/shared";

export async function getShopPlaybookRow(tenantId: string): Promise<{
  playbook: ShopPlaybook;
  ownerCanEdit: boolean;
  nightDeskLive: boolean;
  version: number;
} | null> {
  const r = await pool.query(
    `SELECT playbook, owner_can_edit, night_desk_live, version FROM shop_playbooks WHERE tenant_id = $1`,
    [tenantId],
  );
  if (!r.rows[0]) return null;
  return {
    playbook: normalizeShopPlaybook(r.rows[0].playbook),
    ownerCanEdit: r.rows[0].owner_can_edit,
    nightDeskLive: r.rows[0].night_desk_live,
    version: r.rows[0].version,
  };
}

export async function upsertShopPlaybook(
  tenantId: string,
  playbook: ShopPlaybook,
  actor?: string,
): Promise<{ playbook: ShopPlaybook; version: number }> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const current = await client.query(
      `SELECT version FROM shop_playbooks WHERE tenant_id = $1 FOR UPDATE`,
      [tenantId],
    );
    const version = Number(current.rows[0]?.version || 0) + 1;
    const next = normalizeShopPlaybook({
      ...playbook,
      version,
      publishedAt: new Date().toISOString(),
    });
    await client.query(
      `INSERT INTO shop_playbooks (tenant_id, playbook, version, updated_at)
       VALUES ($1, $2::jsonb, $3, now())
       ON CONFLICT (tenant_id) DO UPDATE SET
         playbook = EXCLUDED.playbook,
         version = EXCLUDED.version,
         updated_at = now()`,
      [tenantId, JSON.stringify(next), version],
    );
    await client.query(
      `INSERT INTO shop_playbook_versions (tenant_id, version, playbook, actor)
       VALUES ($1, $2, $3::jsonb, $4)`,
      [tenantId, version, JSON.stringify(next), actor || null],
    );
    await client.query("COMMIT");
    return { playbook: next, version };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function listShopPlaybookVersions(
  tenantId: string,
  limit = 50,
) {
  const result = await pool.query(
    `SELECT id, version, playbook, actor, created_at
     FROM shop_playbook_versions
     WHERE tenant_id = $1
     ORDER BY version DESC
     LIMIT $2`,
    [tenantId, Math.min(200, Math.max(1, limit))],
  );
  return result.rows;
}

export async function setPlaybookFlags(
  tenantId: string,
  flags: { ownerCanEdit?: boolean; nightDeskLive?: boolean },
): Promise<void> {
  await pool.query(
    `INSERT INTO shop_playbooks (tenant_id, playbook)
     VALUES ($1, $2::jsonb)
     ON CONFLICT (tenant_id) DO NOTHING`,
    [tenantId, JSON.stringify(normalizeShopPlaybook())],
  );
  if (flags.ownerCanEdit !== undefined) {
    await pool.query(`UPDATE shop_playbooks SET owner_can_edit = $2, updated_at = now() WHERE tenant_id = $1`, [
      tenantId,
      flags.ownerCanEdit,
    ]);
  }
  if (flags.nightDeskLive !== undefined) {
    await pool.query(`UPDATE shop_playbooks SET night_desk_live = $2, updated_at = now() WHERE tenant_id = $1`, [
      tenantId,
      flags.nightDeskLive,
    ]);
  }
}

export async function upsertCallCompletion(row: {
  tenantId: string;
  callId: string;
  completion: CallCompletion;
  reason?: string;
  bookedCents?: number;
  quoteCents?: number;
  orphanPromise?: boolean;
  source?: string;
  input?: unknown;
  fsmJobId?: string;
  fsmProvider?: string;
  recordingUrl?: string;
  actor?: string;
  details?: unknown;
}): Promise<Record<string, unknown>> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const prior = await client.query(
      `SELECT completion, reason FROM call_completions
       WHERE tenant_id = $1 AND call_id = $2 FOR UPDATE`,
      [row.tenantId, row.callId],
    );
    const result = await client.query(
      `INSERT INTO call_completions (
         tenant_id, call_id, completion, reason, booked_cents, quote_cents,
         orphan_promise, source, input, fsm_job_id, fsm_provider,
         recording_url, updated_at
       )
       VALUES (
         $1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,
         COALESCE(
           $12,
           (SELECT recording_url FROM call_recordings
            WHERE tenant_id = $1 AND call_id = $2)
         ),
         now()
       )
       ON CONFLICT (tenant_id, call_id) DO UPDATE SET
         completion = EXCLUDED.completion,
         reason = EXCLUDED.reason,
         booked_cents = COALESCE(EXCLUDED.booked_cents, call_completions.booked_cents),
         quote_cents = COALESCE(EXCLUDED.quote_cents, call_completions.quote_cents),
         orphan_promise = call_completions.orphan_promise OR EXCLUDED.orphan_promise,
         source = EXCLUDED.source,
         input = call_completions.input || EXCLUDED.input,
         fsm_job_id = COALESCE(EXCLUDED.fsm_job_id, call_completions.fsm_job_id),
         fsm_provider = COALESCE(EXCLUDED.fsm_provider, call_completions.fsm_provider),
         recording_url = COALESCE(EXCLUDED.recording_url, call_completions.recording_url),
         updated_at = now()
       RETURNING *`,
      [
        row.tenantId,
        row.callId,
        row.completion,
        row.reason || null,
        row.bookedCents ?? null,
        row.quoteCents ?? null,
        Boolean(row.orphanPromise),
        row.source || "call_end",
        JSON.stringify(row.input || {}),
        row.fsmJobId || null,
        row.fsmProvider || null,
        row.recordingUrl || null,
      ],
    );
    const before = prior.rows[0];
    if (result.rows[0]?.recording_url) {
      await client.query(
        `UPDATE calls SET
           lead = COALESCE(lead, '{}'::jsonb) ||
             jsonb_build_object('recordingUrl', $3::text),
           updated_at = now()
         WHERE tenant_id = $1
           AND (
             id::text = $2
             OR lead->>'voiceCallControlId' = $2
           )`,
        [row.tenantId, row.callId, result.rows[0].recording_url],
      );
    }
    if (
      !before ||
      before.completion !== row.completion ||
      before.reason !== (row.reason || null)
    ) {
      await client.query(
        `INSERT INTO call_completion_events (
           tenant_id, call_id, from_completion, to_completion, reason, actor, details
         ) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)`,
        [
          row.tenantId,
          row.callId,
          before?.completion || null,
          row.completion,
          row.reason || "unspecified",
          row.actor || null,
          JSON.stringify(row.details || {}),
        ],
      );
    }
    await client.query("COMMIT");
    return result.rows[0];
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function getCallCompletion(
  tenantId: string,
  callId: string,
): Promise<Record<string, unknown> | null> {
  const result = await pool.query(
    `SELECT * FROM call_completions WHERE tenant_id = $1 AND call_id = $2`,
    [tenantId, callId],
  );
  return result.rows[0] || null;
}

export async function mirrorCompletionToCallAndLeads(input: {
  tenantId: string;
  callId: string;
  completion: CallCompletion;
  reason?: string;
}): Promise<void> {
  const patch = JSON.stringify({
    completion: input.completion,
    completionReason: input.reason || null,
  });
  await Promise.all([
    pool.query(
      `UPDATE calls SET
         lead = COALESCE(lead, '{}'::jsonb) || $3::jsonb,
         updated_at = now()
       WHERE tenant_id = $1
         AND (
           id::text = $2
           OR lead->>'voiceCallControlId' = $2
         )`,
      [input.tenantId, input.callId, patch],
    ),
    pool.query(
      `UPDATE leads SET
         raw_extract = COALESCE(raw_extract, '{}'::jsonb) || $3::jsonb
       WHERE tenant_id = $1 AND call_id = $2`,
      [input.tenantId, input.callId, patch],
    ),
  ]);
}

export async function attachCallRecording(input: {
  tenantId: string;
  callId: string;
  recordingUrl: string;
}): Promise<void> {
  await pool.query(
    `INSERT INTO call_recordings (
       tenant_id, call_id, recording_url, updated_at
     ) VALUES ($1,$2,$3,now())
     ON CONFLICT (tenant_id, call_id) DO UPDATE SET
       recording_url = EXCLUDED.recording_url,
       updated_at = now()`,
    [input.tenantId, input.callId, input.recordingUrl],
  );
  await Promise.all([
    pool.query(
      `UPDATE call_completions SET recording_url = $3, updated_at = now()
       WHERE tenant_id = $1 AND call_id = $2`,
      [input.tenantId, input.callId, input.recordingUrl],
    ),
    pool.query(
      `UPDATE calls SET
         lead = COALESCE(lead, '{}'::jsonb) ||
           jsonb_build_object('recordingUrl', $3::text),
         updated_at = now()
       WHERE tenant_id = $1
         AND (
           id::text = $2
           OR lead->>'voiceCallControlId' = $2
         )`,
      [input.tenantId, input.callId, input.recordingUrl],
    ),
  ]);
}

export async function listCompletionEvents(tenantId: string, limit = 100) {
  const result = await pool.query(
    `SELECT * FROM call_completion_events
     WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [tenantId, Math.min(500, Math.max(1, limit))],
  );
  return result.rows;
}

export async function completionMetrics(tenantId: string, sinceIso?: string): Promise<{
  total: number;
  byCompletion: Record<string, number>;
  orphans: number;
  preventedPromises: number;
  bookedCents: number;
}> {
  const r = await pool.query(
    `SELECT completion, COUNT(*)::int AS n, COALESCE(SUM(booked_cents),0)::int AS cents,
            COALESCE(SUM(CASE WHEN orphan_promise THEN 1 ELSE 0 END),0)::int AS orphans
            ,COALESCE(SUM(CASE WHEN reason LIKE '%empty_promise%' THEN 1 ELSE 0 END),0)::int AS prevented
     FROM call_completions
     WHERE tenant_id = $1 AND created_at >= $2::timestamptz
     GROUP BY completion`,
    [tenantId, sinceIso || new Date(Date.now() - 30 * 86400000).toISOString()],
  );
  const byCompletion: Record<string, number> = {};
  let total = 0;
  let orphans = 0;
  let preventedPromises = 0;
  let bookedCents = 0;
  for (const row of r.rows) {
    byCompletion[row.completion] = row.n;
    total += row.n;
    orphans += row.orphans;
    preventedPromises += row.prevented;
    bookedCents += row.cents;
  }
  return { total, byCompletion, orphans, preventedPromises, bookedCents };
}

export async function listCompletionsSince(tenantId: string, sinceIso: string) {
  const r = await pool.query(
    `SELECT cc.*,
            COALESCE(
              cc.recording_url,
              cr.recording_url,
              c.lead->>'recordingUrl',
              c.lead->>'recording_url'
            ) AS resolved_recording_url
     FROM call_completions cc
     LEFT JOIN calls c
       ON c.tenant_id = cc.tenant_id
      AND (
        c.id::text = cc.call_id
        OR c.lead->>'voiceCallControlId' = cc.call_id
      )
     LEFT JOIN call_recordings cr
       ON cr.tenant_id = cc.tenant_id AND cr.call_id = cc.call_id
     WHERE cc.tenant_id = $1 AND cc.created_at >= $2::timestamptz
     ORDER BY cc.created_at DESC`,
    [tenantId, sinceIso],
  );
  return r.rows;
}

export async function listCompletionsForLocalDate(
  tenantId: string,
  timezone: string,
  localDate: string,
) {
  const result = await pool.query(
    `SELECT cc.*,
            COALESCE(
              cc.recording_url,
              cr.recording_url,
              c.lead->>'recordingUrl',
              c.lead->>'recording_url'
            ) AS resolved_recording_url,
            c.caller_id AS caller_id,
            COALESCE(c.lead->>'name', c.lead->>'callerName') AS caller_name
     FROM call_completions cc
     LEFT JOIN calls c
       ON c.tenant_id = cc.tenant_id
      AND (
        c.id::text = cc.call_id
        OR c.lead->>'voiceCallControlId' = cc.call_id
      )
     LEFT JOIN call_recordings cr
       ON cr.tenant_id = cc.tenant_id AND cr.call_id = cc.call_id
     WHERE cc.tenant_id = $1
       AND (cc.created_at AT TIME ZONE $2)::date = $3::date
     ORDER BY cc.created_at DESC`,
    [tenantId, timezone, localDate],
  );
  return result.rows;
}

export async function completionDailySeries(
  tenantId: string,
  timezone: string,
  days = 30,
) {
  const result = await pool.query(
    `SELECT
       (created_at AT TIME ZONE $2)::date::text AS date,
       completion,
       COUNT(*)::int AS count,
       COALESCE(SUM(booked_cents), 0)::int AS booked_cents
     FROM call_completions
     WHERE tenant_id = $1
       AND created_at >= now() - ($3::text || ' days')::interval
     GROUP BY 1, completion
     ORDER BY 1`,
    [tenantId, timezone, Math.min(365, Math.max(1, days))],
  );
  const byDate = new Map<string, Record<string, string | number>>();
  for (const row of result.rows) {
    const item: Record<string, string | number> =
      byDate.get(String(row.date)) || {
        date: String(row.date),
        booked: 0,
        approval_held: 0,
        on_call_paged: 0,
        tasked: 0,
        refused: 0,
        bookedCents: 0,
      };
    item[String(row.completion)] = Number(row.count);
    item.bookedCents = Number(item.bookedCents || 0) + row.booked_cents;
    byDate.set(String(row.date), item);
  }
  return [...byDate.values()];
}

export async function getCutover(tenantId: string) {
  const r = await pool.query(`SELECT item_id, passed, note, updated_at FROM cutover_items WHERE tenant_id = $1`, [tenantId]);
  const have = new Map(r.rows.map((x) => [x.item_id, x]));
  const items = CUTOVER_ITEM_IDS.map((id) => ({
    id,
    passed: Boolean(have.get(id)?.passed),
    note: have.get(id)?.note || "",
    updatedAt: have.get(id)?.updated_at || null,
  }));
  const live = items.every((i) => i.passed);
  return { items, live };
}

export async function hasCutoverEvidence(
  tenantId: string,
  itemId: (typeof CUTOVER_ITEM_IDS)[number],
): Promise<boolean> {
  const queries: Record<string, string> = {
    did_inbound:
      "SELECT 1 FROM calls WHERE tenant_id = $1 LIMIT 1",
    hours_published:
      "SELECT 1 FROM tenant_configs WHERE tenant_id = $1 AND business_hours IS NOT NULL AND business_hours <> '{}'::jsonb LIMIT 1",
    playbook_published:
      "SELECT 1 FROM shop_playbooks WHERE tenant_id = $1 AND version > 0 AND playbook->>'publishedAt' IS NOT NULL LIMIT 1",
    oncall_sms:
      "SELECT 1 FROM oncall_drills WHERE tenant_id = $1 AND ok = true LIMIT 1",
    refuse_out_of_area:
      "SELECT 1 FROM call_completions WHERE tenant_id = $1 AND completion = 'refused' AND reason = 'out_of_area' LIMIT 1",
    book_or_hold:
      "SELECT 1 FROM call_completions WHERE tenant_id = $1 AND ((completion = 'booked' AND fsm_job_id IS NOT NULL) OR completion = 'approval_held') LIMIT 1",
    test_call:
      "SELECT 1 FROM tenant_configs WHERE tenant_id = $1 AND operator_state->'testCall'->>'completedAt' IS NOT NULL LIMIT 1",
    faq_hours:
      "SELECT 1 FROM tenant_configs WHERE tenant_id = $1 AND business_hours IS NOT NULL AND business_hours <> '{}'::jsonb LIMIT 1",
    transfer_or_message:
      "SELECT 1 FROM shop_playbooks WHERE tenant_id = $1 AND version > 0 LIMIT 1",
    existing_cid:
      "SELECT 1 FROM calls WHERE tenant_id = $1 LIMIT 1",
    quote_or_hold:
      "SELECT 1 FROM call_completions WHERE tenant_id = $1 AND ((completion = 'booked' AND fsm_job_id IS NOT NULL) OR completion = 'approval_held') LIMIT 1",
  };
  const query = queries[itemId];
  if (!query) return false;
  const result = await pool.query(query, [tenantId]);
  return Boolean(result.rows[0]);
}

export async function upsertCutoverItem(tenantId: string, itemId: string, passed: boolean, note?: string) {
  await pool.query(
    `INSERT INTO cutover_items (tenant_id, item_id, passed, note, updated_at)
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (tenant_id, item_id) DO UPDATE SET passed = EXCLUDED.passed, note = EXCLUDED.note, updated_at = now()`,
    [tenantId, itemId, passed, note || null],
  );
  await pool.query(
    `UPDATE shop_playbooks SET
       night_desk_live = (
         SELECT COUNT(*)::int = $2
         FROM cutover_items
         WHERE tenant_id = $1
           AND item_id = ANY($3::text[])
           AND passed = true
       ),
       updated_at = now()
     WHERE tenant_id = $1`,
    [tenantId, CUTOVER_ITEM_IDS.length, [...CUTOVER_ITEM_IDS]],
  );
  if (itemId === "test_call" && passed) {
    /* keep existing operator_state.testCall via caller */
  }
}

export async function createApproval(tenantId: string, summary: string, payload: unknown, callId?: string) {
  const r = await pool.query(
    `INSERT INTO booking_approvals (tenant_id, call_id, summary, payload)
     VALUES ($1, $2, $3, $4::jsonb)
     ON CONFLICT (tenant_id, call_id)
       WHERE call_id IS NOT NULL AND status = 'pending'
     DO UPDATE SET summary = EXCLUDED.summary, payload = EXCLUDED.payload
     RETURNING *`,
    [tenantId, callId || null, summary, JSON.stringify(payload || {})],
  );
  return r.rows[0];
}

export async function listApprovals(tenantId: string, status?: string) {
  const r = status
    ? await pool.query(`SELECT * FROM booking_approvals WHERE tenant_id = $1 AND status = $2 ORDER BY created_at DESC LIMIT 100`, [
        tenantId,
        status,
      ])
    : await pool.query(`SELECT * FROM booking_approvals WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 100`, [tenantId]);
  return r.rows;
}

export async function getApproval(tenantId: string, id: string) {
  const result = await pool.query(
    `SELECT * FROM booking_approvals WHERE tenant_id = $1 AND id = $2`,
    [tenantId, id],
  );
  return result.rows[0] || null;
}

export async function decideApproval(tenantId: string, id: string, status: "approved" | "rejected", actor?: string) {
  const r = await pool.query(
    `UPDATE booking_approvals SET status = $3, decided_by = $4, decided_at = now()
     WHERE id = $1 AND tenant_id = $2 AND status = 'pending' RETURNING *`,
    [id, tenantId, status, actor || null],
  );
  return r.rows[0] || null;
}

export async function listOncallRotation(tenantId: string) {
  const r = await pool.query(`SELECT * FROM oncall_rotations WHERE tenant_id = $1 ORDER BY sort_order, label`, [tenantId]);
  return r.rows;
}

export async function replaceOncallRotation(
  tenantId: string,
  rows: Array<{ label: string; e164: string; weekday?: number; startHhmm?: string; endHhmm?: string; quietHours?: boolean }>,
) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`DELETE FROM oncall_rotations WHERE tenant_id = $1`, [tenantId]);
    for (const [i, row] of rows.entries()) {
      await client.query(
        `INSERT INTO oncall_rotations (
           tenant_id, label, e164, weekday, start_hhmm, end_hhmm,
           quiet_hours, sort_order
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          tenantId,
          row.label,
          row.e164,
          row.weekday ?? null,
          row.startHhmm || null,
          row.endHhmm || null,
          Boolean(row.quietHours),
          i,
        ],
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function insertOncallDrill(
  tenantId: string,
  e164: string,
  latencyMs = 0,
  ok = false,
  status = "pending",
) {
  const r = await pool.query(
    `INSERT INTO oncall_drills (tenant_id, e164, latency_ms, ok, status)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [tenantId, e164, latencyMs, ok, status],
  );
  return r.rows[0];
}

export async function setOncallDrillCallId(
  tenantId: string,
  id: string,
  callControlId: string,
) {
  const result = await pool.query(
    `UPDATE oncall_drills SET call_control_id = $3
     WHERE tenant_id = $1 AND id = $2 RETURNING *`,
    [tenantId, id, callControlId],
  );
  return result.rows[0] || null;
}

export async function completeOncallDrill(input: {
  tenantId: string;
  id: string;
  ok: boolean;
  latencyMs?: number;
  reason?: string;
  callControlId?: string;
}) {
  const result = await pool.query(
    `UPDATE oncall_drills SET
       ok = ok OR $3,
       status = CASE
         WHEN status = 'answered' THEN 'answered'
         WHEN $3 THEN 'answered'
         ELSE 'failed'
       END,
       latency_ms = COALESCE($4, latency_ms),
       answered_at = CASE WHEN $3 THEN now() ELSE answered_at END,
       failure_reason = CASE
         WHEN status = 'answered' OR $3 THEN failure_reason
         ELSE COALESCE($5, failure_reason)
       END,
       call_control_id = COALESCE($6, call_control_id)
     WHERE tenant_id = $1 AND id = $2 RETURNING *`,
    [
      input.tenantId,
      input.id,
      input.ok,
      input.latencyMs ?? null,
      input.reason || null,
      input.callControlId || null,
    ],
  );
  return result.rows[0] || null;
}

export async function latestOncallDrill(tenantId: string) {
  const r = await pool.query(`SELECT * FROM oncall_drills WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 1`, [tenantId]);
  return r.rows[0] || null;
}

export async function createOncallPage(input: {
  tenantId: string;
  callId: string;
  destinationE164: string;
  timeoutSecs: number;
}) {
  const result = await pool.query(
    `INSERT INTO oncall_pages (
       tenant_id, call_id, destination_e164, deadline_at
     ) VALUES ($1,$2,$3,now() + ($4::text || ' seconds')::interval)
     ON CONFLICT (tenant_id, call_id) DO UPDATE SET
       destination_e164 = EXCLUDED.destination_e164,
       deadline_at = EXCLUDED.deadline_at,
       status = CASE
         WHEN oncall_pages.status = 'answered' THEN oncall_pages.status
         ELSE 'pending'
       END,
       updated_at = now()
     RETURNING *`,
    [
      input.tenantId,
      input.callId,
      input.destinationE164,
      Math.min(120, Math.max(5, Math.round(input.timeoutSecs))),
    ],
  );
  return result.rows[0];
}

export async function setOncallTransferLeg(
  tenantId: string,
  callId: string,
  transferCallControlId: string,
) {
  const result = await pool.query(
    `UPDATE oncall_pages SET transfer_call_control_id = $3, updated_at = now()
     WHERE tenant_id = $1 AND call_id = $2 RETURNING *`,
    [tenantId, callId, transferCallControlId],
  );
  return result.rows[0] || null;
}

export async function resolveOncallPage(input: {
  tenantId: string;
  callId: string;
  status: "answered" | "failed" | "tasked";
  transferCallControlId?: string;
  reason?: string;
}) {
  const result = await pool.query(
    `UPDATE oncall_pages SET
       status = $3,
       transfer_call_control_id = COALESCE($4, transfer_call_control_id),
       answered_at = CASE WHEN $3 = 'answered' THEN now() ELSE answered_at END,
       failed_at = CASE WHEN $3 = 'failed' THEN now() ELSE failed_at END,
       fallback_tasked_at = CASE WHEN $3 = 'tasked' THEN now() ELSE fallback_tasked_at END,
       failure_reason = COALESCE($5, failure_reason),
       updated_at = now()
     WHERE tenant_id = $1 AND call_id = $2
       AND status <> 'answered'
       AND (status <> 'tasked' OR $3 = 'tasked')
     RETURNING *`,
    [
      input.tenantId,
      input.callId,
      input.status,
      input.transferCallControlId || null,
      input.reason || null,
    ],
  );
  return result.rows[0] || null;
}

export async function claimDueOncallPages(limit = 100) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query(
      `WITH due AS (
         SELECT id FROM oncall_pages
         WHERE (
           status = 'pending' AND deadline_at <= now()
         ) OR (
           status = 'failed'
         ) OR (
           status = 'processing' AND updated_at < now() - interval '2 minutes'
         )
         ORDER BY deadline_at
         FOR UPDATE SKIP LOCKED
         LIMIT $1
       )
       UPDATE oncall_pages p SET
         status = 'processing',
         failure_reason = COALESCE(failure_reason, 'page_timeout'),
         updated_at = now()
       FROM due WHERE p.id = due.id
       RETURNING p.*`,
      [Math.min(500, Math.max(1, limit))],
    );
    await client.query("COMMIT");
    return result.rows;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function upsertFsmConnection(
  tenantId: string,
  provider: string,
  status: string,
  label?: string,
  metadata?: {
    accountId?: string;
    scopes?: string[];
    tokenExpiresAt?: string;
    refreshExpiresAt?: string;
  },
) {
  await pool.query(
    `INSERT INTO fsm_connections (
       tenant_id, provider, status, account_label, account_id, scopes,
       token_expires_at, refresh_expires_at, updated_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,now())
     ON CONFLICT (tenant_id, provider) DO UPDATE SET
       status = EXCLUDED.status,
       account_label = COALESCE(EXCLUDED.account_label, fsm_connections.account_label),
       account_id = COALESCE(EXCLUDED.account_id, fsm_connections.account_id),
       scopes = CASE
         WHEN cardinality(EXCLUDED.scopes) > 0 THEN EXCLUDED.scopes
         ELSE fsm_connections.scopes
       END,
       token_expires_at = COALESCE(EXCLUDED.token_expires_at, fsm_connections.token_expires_at),
       refresh_expires_at = COALESCE(EXCLUDED.refresh_expires_at, fsm_connections.refresh_expires_at),
       updated_at = now()`,
    [
      tenantId,
      provider,
      status,
      label || null,
      metadata?.accountId || null,
      metadata?.scopes || [],
      metadata?.tokenExpiresAt || null,
      metadata?.refreshExpiresAt || null,
    ],
  );
}

export async function getFsmConnections(tenantId: string) {
  const r = await pool.query(
    `SELECT provider, status, account_label, account_id, scopes,
            token_expires_at, refresh_expires_at, updated_at
     FROM fsm_connections WHERE tenant_id = $1`,
    [tenantId],
  );
  return r.rows;
}

export async function getFsmConnection(tenantId: string, provider: string) {
  const result = await pool.query(
    `SELECT * FROM fsm_connections WHERE tenant_id = $1 AND provider = $2`,
    [tenantId, provider],
  );
  return result.rows[0] || null;
}

export async function getFsmJobWrite(
  tenantId: string,
  provider: string,
  idempotencyKey: string,
) {
  const result = await pool.query(
    `SELECT * FROM fsm_job_writes
     WHERE tenant_id = $1 AND provider = $2 AND idempotency_key = $3`,
    [tenantId, provider, idempotencyKey],
  );
  return result.rows[0] || null;
}

export async function reserveFsmJobWrite(input: {
  tenantId: string;
  provider: string;
  idempotencyKey: string;
  callId: string;
}) {
  const result = await pool.query(
    `INSERT INTO fsm_job_writes (
       tenant_id, provider, idempotency_key, call_id, status
     ) VALUES ($1,$2,$3,$4,'pending')
     ON CONFLICT (tenant_id, provider, idempotency_key) DO NOTHING
     RETURNING *`,
    [input.tenantId, input.provider, input.idempotencyKey, input.callId],
  );
  return result.rows[0] || null;
}

export async function finishFsmJobWrite(input: {
  tenantId: string;
  provider: string;
  idempotencyKey: string;
  status: "completed" | "failed";
  customerId?: string;
  propertyId?: string;
  jobId?: string;
  error?: string;
  response?: unknown;
}) {
  const result = await pool.query(
    `UPDATE fsm_job_writes SET
       status = $4,
       customer_id = COALESCE($5, customer_id),
       property_id = COALESCE($6, property_id),
       job_id = COALESCE($7, job_id),
       error = $8,
       response = $9::jsonb,
       updated_at = now()
     WHERE tenant_id = $1 AND provider = $2 AND idempotency_key = $3
     RETURNING *`,
    [
      input.tenantId,
      input.provider,
      input.idempotencyKey,
      input.status,
      input.customerId || null,
      input.propertyId || null,
      input.jobId || null,
      input.error || null,
      JSON.stringify(input.response || {}),
    ],
  );
  return result.rows[0] || null;
}

export async function insertInboundLead(row: {
  tenantId: string;
  source: string;
  name?: string;
  phone?: string;
  payload?: unknown;
  completion?: string;
}) {
  const r = await pool.query(
    `INSERT INTO inbound_leads (tenant_id, source, name, phone, payload, completion)
     VALUES ($1,$2,$3,$4,$5::jsonb,$6) RETURNING *`,
    [row.tenantId, row.source, row.name || null, row.phone || null, JSON.stringify(row.payload || {}), row.completion || null],
  );
  return r.rows[0];
}

export async function lookupLocalCaller(tenantId: string, phone: string) {
  const normalized = String(phone || "").replace(/\D/g, "");
  if (!normalized) return null;
  const result = await pool.query(
    `SELECT name, phone, raw_extract
     FROM leads
     WHERE tenant_id = $1
       AND regexp_replace(COALESCE(phone, ''), '[^0-9]', '', 'g') = $2
     ORDER BY created_at DESC
     LIMIT 1`,
    [tenantId, normalized],
  );
  const row = result.rows[0];
  if (!row) return null;
  const raw =
    row.raw_extract && typeof row.raw_extract === "object"
      ? row.raw_extract
      : {};
  return {
    name: row.name || undefined,
    phone: row.phone || phone,
    openJobs: Array.isArray(raw.openJobs) ? raw.openJobs : [],
    membership:
      typeof raw.membership === "string" ? raw.membership : undefined,
    warranty: typeof raw.warranty === "string" ? raw.warranty : undefined,
  };
}

export async function ensureCompletionLead(input: {
  tenantId: string;
  callId: string;
  name?: string;
  phone?: string;
  email?: string;
  issue: string;
  category: string;
  priority: "normal" | "urgent";
  notes?: string;
  rawExtract?: unknown;
}) {
  const result = await pool.query(
    `INSERT INTO leads (
       tenant_id, call_id, name, phone, email, issue, category, priority,
       notes, raw_extract
     )
     SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb
     WHERE NOT EXISTS (
       SELECT 1 FROM leads
       WHERE tenant_id = $1 AND call_id = $2 AND category = $7
     )
     RETURNING *`,
    [
      input.tenantId,
      input.callId,
      input.name || null,
      input.phone || null,
      input.email || null,
      input.issue,
      input.category,
      input.priority,
      input.notes || null,
      JSON.stringify(input.rawExtract || {}),
    ],
  );
  if (result.rows[0]) return result.rows[0];
  const existing = await pool.query(
    `SELECT * FROM leads
     WHERE tenant_id = $1 AND call_id = $2 AND category = $3
     ORDER BY created_at DESC LIMIT 1`,
    [input.tenantId, input.callId, input.category],
  );
  return existing.rows[0] || null;
}

export async function insertQaScore(tenantId: string, callId: string, score: number, rubric: unknown) {
  const r = await pool.query(
    `INSERT INTO call_qa_scores (tenant_id, call_id, score, rubric)
     VALUES ($1,$2,$3,$4::jsonb)
     ON CONFLICT (tenant_id, call_id) DO UPDATE SET
       score = EXCLUDED.score,
       rubric = EXCLUDED.rubric,
       created_at = now()
     RETURNING *`,
    [tenantId, callId, score, JSON.stringify(rubric || {})],
  );
  return r.rows[0];
}

export async function listQaScores(tenantId: string) {
  const r = await pool.query(
    `SELECT q.*,
            c.caller_id,
            COALESCE(c.lead->>'name', c.lead->>'callerName') AS caller_name,
            COALESCE(c.lead->>'issue', c.lead->>'jobType', c.lead->>'category') AS issue,
            c.lead,
            c.history,
            cc.completion,
            cc.reason,
            cc.booked_cents,
            cc.quote_cents,
            COALESCE(cc.recording_url, c.lead->>'recordingUrl') AS recording_url
     FROM call_qa_scores q
     LEFT JOIN calls c
       ON c.tenant_id = q.tenant_id
      AND (
        c.id::text = q.call_id
        OR c.lead->>'voiceCallControlId' = q.call_id
      )
     LEFT JOIN call_completions cc
       ON cc.tenant_id = q.tenant_id
      AND cc.call_id = q.call_id
     WHERE q.tenant_id = $1
     ORDER BY q.created_at DESC
     LIMIT 50`,
    [tenantId],
  );
  return r.rows;
}

export async function recordDigestDelivery(input: {
  tenantId: string;
  localDate: string;
  channel: "sms" | "email";
  destinationHash: string;
  status: "sent" | "failed" | "skipped";
  error?: string;
}) {
  const result = await pool.query(
    `INSERT INTO morning_digest_deliveries (
       tenant_id, local_date, channel, destination_hash, status, error
     ) VALUES ($1,$2::date,$3,$4,$5,$6)
     ON CONFLICT (tenant_id, local_date, channel, destination_hash)
     DO UPDATE SET
       status = EXCLUDED.status,
       error = EXCLUDED.error,
       updated_at = now()
     RETURNING *`,
    [
      input.tenantId,
      input.localDate,
      input.channel,
      input.destinationHash,
      input.status,
      input.error || null,
    ],
  );
  return result.rows[0];
}

export async function hasDigestDelivery(input: {
  tenantId: string;
  localDate: string;
  channel: "sms" | "email";
  destinationHash: string;
}) {
  const result = await pool.query(
    `SELECT 1 FROM morning_digest_deliveries
     WHERE tenant_id = $1 AND local_date = $2::date
       AND channel = $3 AND destination_hash = $4 AND status = 'sent'`,
    [
      input.tenantId,
      input.localDate,
      input.channel,
      input.destinationHash,
    ],
  );
  return Boolean(result.rows[0]);
}

export async function claimDigestDelivery(input: {
  tenantId: string;
  localDate: string;
  channel: "sms" | "email";
  destinationHash: string;
  force?: boolean;
}) {
  if (input.force) {
    await pool.query(
      `DELETE FROM morning_digest_deliveries
       WHERE tenant_id = $1 AND local_date = $2::date
         AND channel = $3 AND destination_hash = $4`,
      [
        input.tenantId,
        input.localDate,
        input.channel,
        input.destinationHash,
      ],
    );
  }
  const result = await pool.query(
    `INSERT INTO morning_digest_deliveries (
       tenant_id, local_date, channel, destination_hash, status
     ) VALUES ($1,$2::date,$3,$4,'pending')
     ON CONFLICT (tenant_id, local_date, channel, destination_hash)
     DO UPDATE SET status = 'pending', error = NULL, updated_at = now()
       WHERE morning_digest_deliveries.status = 'failed'
          OR (
            morning_digest_deliveries.status = 'pending'
            AND morning_digest_deliveries.updated_at < now() - interval '10 minutes'
          )
     RETURNING id`,
    [
      input.tenantId,
      input.localDate,
      input.channel,
      input.destinationHash,
    ],
  );
  return Boolean(result.rows[0]);
}
