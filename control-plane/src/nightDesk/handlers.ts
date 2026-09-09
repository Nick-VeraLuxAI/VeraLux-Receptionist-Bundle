import type { Express, NextFunction, Request, Response } from "express";
import { randomUUID } from "crypto";
import { z } from "zod";
import {
  CALL_COMPLETIONS,
  CUTOVER_ITEM_IDS,
  DEFAULT_SHOP_PLAYBOOK,
  evaluateShopAction,
  normalizeShopPlaybook,
  shopPlaybookRuntimeSchema,
  planReceptionistTurn,
  normalizeIntakeProfile,
} from "@veralux/shared";
import {
  completionMetrics,
  completionDailySeries,
  completeOncallDrill,
  attachCallRecording,
  createApproval,
  decideApproval,
  getApproval,
  getCutover,
  getFsmConnections,
  hasCutoverEvidence,
  getShopPlaybookRow,
  insertInboundLead,
  insertOncallDrill,
  insertQaScore,
  latestOncallDrill,
  listApprovals,
  listCompletionEvents,
  listCompletionsSince,
  listOncallRotation,
  listQaScores,
  listShopPlaybookVersions,
  mirrorCompletionToCallAndLeads,
  replaceOncallRotation,
  setPlaybookFlags,
  upsertCutoverItem,
  upsertCallCompletion,
  upsertShopPlaybook,
} from "./db";
import {
  sendNightDeskSms,
  TENANT_TELNYX_API_KEY,
  TENANT_TELNYX_CONNECTION_ID,
  TENANT_TELNYX_PHONE_NUMBER,
  TENANT_TELNYX_PUBLIC_KEY,
} from "./sms";
import { finalizeCallCompletion } from "./complete";
import { lookupCustomerByPhone, writeBoardJob } from "../fsm";
import { secretStore } from "../secretStore";
import {
  JOBBER_MEMBERSHIP_FIELD_KEY,
  JOBBER_SECRET_KEY,
  JOBBER_WARRANTY_FIELD_KEY,
} from "../fsm/jobber";
import { HCP_SECRET_KEY } from "../fsm/housecallPro";
import { upsertFsmConnection } from "./db";
import { autoPublishTenantRuntimeAfterSave } from "../tenantRuntimePublish";
import { resolveOnCallE164 } from "./oncallResolve";
import { buildMorningDigest, sendMorningDigest } from "./digest";
import { tenants } from "../tenants";
import { getTenantLimits } from "../db";
import { processNightDeskTurn } from "./evaluate";
import { handleOncallTransferOutcome } from "./oncallWorker";
import {
  beginJobberOAuth,
  completeJobberOAuth,
  disconnectJobber,
  JOBBER_TOKEN_SECRET_KEY,
} from "../fsm/jobberOAuth";
import { presentQaScore, scoreNightDeskCall } from "./qa";
import { startVoiceOncallDrill } from "./drill";

type AuthedRequest = Request & {
  ctx?: { isSuperAdmin?: boolean; email?: string; tenantId?: string; ownerConsole?: boolean };
};
type Guard = (req: Request, res: Response, next: NextFunction) => unknown;

const inboundLeadSchema = z
  .object({
    tenantId: z.string().min(1).max(200).optional(),
    source: z.enum(["form", "sms", "paid_lead", "webhook"]).default("form"),
    name: z.string().max(300).optional(),
    phone: z.string().max(100).optional(),
    email: z.string().email().optional(),
    message: z.string().max(20_000).optional(),
    issue: z.string().max(2_000).optional(),
    address: z.string().max(1_000).optional(),
    serviceAddress: z.string().max(1_000).optional(),
    city: z.string().max(200).optional(),
    zip: z.string().max(20).optional(),
    jobType: z.string().max(500).optional(),
    service: z.string().max(500).optional(),
    completion: z.enum(CALL_COMPLETIONS).optional(),
    membership: z.string().max(500).optional(),
    existingOpenJobs: z.number().int().nonnegative().optional(),
    quoteCents: z.number().int().nonnegative().optional(),
    bookedCents: z.number().int().nonnegative().optional(),
    startIso: z.string().datetime().optional(),
  })
  .passthrough();

function tenantFrom(req: AuthedRequest, fallback?: string): string | undefined {
  const q = typeof req.query.tenantId === "string" ? req.query.tenantId : undefined;
  const b = typeof req.body?.tenantId === "string" ? req.body.tenantId : undefined;
  const headerValue = req.headers["x-tenant-id"];
  const h =
    typeof headerValue === "string"
      ? headerValue.trim()
      : Array.isArray(headerValue)
        ? String(headerValue[0] || "").trim()
        : undefined;
  return b || q || req.params?.tenantId || h || fallback || req.ctx?.tenantId;
}

function publicControlPlaneBase(req: Request): string {
  const configured = String(
    process.env.CONTROL_PLANE_PUBLIC_URL ||
      process.env.PUBLIC_CONTROL_PLANE_URL ||
      process.env.VERALUX_DEPLOYMENT_PUBLIC_URL ||
      "",
  )
    .trim()
    .replace(/\/+$/, "");
  if (configured) return configured;
  const proto = String(req.headers["x-forwarded-proto"] || req.protocol)
    .split(",")[0]
    .trim();
  const host = String(req.headers["x-forwarded-host"] || req.get("host") || "")
    .split(",")[0]
    .trim();
  return `${proto}://${host}`;
}

export function registerNightDeskRoutes(
  app: Express,
  deps: {
    adminGuard: (role: "admin" | "viewer") => Guard;
    ensureTenantAccess: (req: Request, res: Response, tenantId: string) => boolean;
  },
): void {
  const { adminGuard, ensureTenantAccess } = deps;

  const ingestLead = async (
    tenantId: string,
    body: Record<string, unknown>,
  ) => {
    const parsedBody = inboundLeadSchema.parse(body);
    const callId = `inbound-${randomUUID()}`;
    const message = String(
      parsedBody.message || parsedBody.issue || "Inbound lead",
    );
    const requested =
      typeof parsedBody.completion === "string" &&
      CALL_COMPLETIONS.includes(
        parsedBody.completion as (typeof CALL_COMPLETIONS)[number],
      )
        ? parsedBody.completion
        : undefined;
    const proposedReply =
      requested === "booked"
        ? "I've booked your service call."
        : /emerg|gas|flood|no heat|burst pipe/i.test(message)
          ? "I am paging the on-call technician now."
          : "Your request has been received.";
    const evaluated = await processNightDeskTurn({
      tenantId,
      callId,
      callerId: parsedBody.phone,
      utterance: message,
      proposedReply,
      transcript: message,
      lead: parsedBody,
      membership:
        parsedBody.membership,
      existingOpenJobs:
        parsedBody.existingOpenJobs,
    });
    const final = evaluated.persisted
      ? { completion: evaluated.completion || "tasked" }
      : await finalizeCallCompletion({
          tenantId,
          callId,
          callerId: parsedBody.phone,
          transcript: message,
          lead: parsedBody,
          claimed: "tasked",
        });
    const lead = await insertInboundLead({
      tenantId,
      source: parsedBody.source,
      name: parsedBody.name,
      phone: parsedBody.phone,
      payload: { ...parsedBody, callId, evaluation: evaluated },
      completion: final.completion,
    });
    return { lead, callId, evaluation: evaluated, completion: final.completion };
  };

  app.get("/api/admin/shop-playbook", adminGuard("viewer"), async (req: AuthedRequest, res) => {
    const tenantId = tenantFrom(req);
    if (!tenantId || !ensureTenantAccess(req, res, tenantId)) return;
    const row = await getShopPlaybookRow(tenantId);
    res.json({
      playbook: row?.playbook || DEFAULT_SHOP_PLAYBOOK,
      ownerCanEdit: row?.ownerCanEdit || false,
      nightDeskLive: row?.nightDeskLive || false,
      version: row?.version || 0,
    });
  });

  app.get(
    "/api/admin/shop-playbook/versions",
    adminGuard("viewer"),
    async (req: AuthedRequest, res) => {
      const tenantId = tenantFrom(req);
      if (!tenantId || !ensureTenantAccess(req, res, tenantId)) return;
      res.json({
        versions: await listShopPlaybookVersions(
          tenantId,
          Number(req.query.limit) || 50,
        ),
      });
    },
  );

  app.put("/api/admin/shop-playbook", adminGuard("admin"), async (req: AuthedRequest, res) => {
    const tenantId = tenantFrom(req);
    if (!tenantId || !ensureTenantAccess(req, res, tenantId)) return;
    const row = await getShopPlaybookRow(tenantId);
    if (req.ctx?.ownerConsole && !row?.ownerCanEdit) {
      return res.status(403).json({ error: "owner_rules_read_only" });
    }
    const parsedPlaybook = shopPlaybookRuntimeSchema.safeParse(
      req.body?.playbook || req.body,
    );
    if (!parsedPlaybook.success) {
      return res.status(400).json({
        error: "invalid_shop_playbook",
        details: parsedPlaybook.error.issues,
      });
    }
    const playbook = parsedPlaybook.data;
    if (
      row &&
      JSON.stringify(row.playbook.serviceArea) !==
        JSON.stringify(playbook.serviceArea)
    ) {
      await upsertCutoverItem(
        tenantId,
        "refuse_out_of_area",
        false,
        "Service area changed; rerun test",
      );
    }
    if (
      row &&
      (row.playbook.quoteHoldCents !== playbook.quoteHoldCents ||
        JSON.stringify(row.playbook.stormMode) !==
          JSON.stringify(playbook.stormMode))
    ) {
      await upsertCutoverItem(
        tenantId,
        "book_or_hold",
        false,
        "Hold policy changed; rerun test",
      );
    }
    if (
      row &&
      (row.playbook.onCallE164 !== playbook.onCallE164 ||
        row.playbook.onCallTimeoutSecs !== playbook.onCallTimeoutSecs)
    ) {
      await upsertCutoverItem(
        tenantId,
        "oncall_sms",
        false,
        "On-call line changed; rerun drill",
      );
    }
    const saved = await upsertShopPlaybook(tenantId, playbook, req.ctx?.email);
    await upsertCutoverItem(
      tenantId,
      "playbook_published",
      false,
      "Publish pending",
    );
    const pub = await autoPublishTenantRuntimeAfterSave(tenantId, { settingArea: "shop_playbook", actorRole: "admin" });
    if (pub.published) {
      await upsertCutoverItem(
        tenantId,
        "playbook_published",
        true,
        "Automatically verified after runtime publish",
      );
    }
    res.json({ ...saved, published: pub.published });
  });

  app.patch(
    "/api/admin/shop-playbook/permissions",
    adminGuard("admin"),
    async (req: AuthedRequest, res) => {
      const tenantId = tenantFrom(req);
      if (!tenantId || !ensureTenantAccess(req, res, tenantId)) return;
      if (!req.ctx?.isSuperAdmin) {
        return res.status(403).json({ error: "superadmin_required" });
      }
      if (typeof req.body?.ownerCanEdit !== "boolean") {
        return res.status(400).json({ error: "owner_can_edit_required" });
      }
      await setPlaybookFlags(tenantId, {
        ownerCanEdit: req.body.ownerCanEdit,
      });
      res.json({ ownerCanEdit: req.body.ownerCanEdit });
    },
  );

  app.post("/api/admin/shop-playbook/evaluate", adminGuard("viewer"), async (req: AuthedRequest, res) => {
    const tenantId = tenantFrom(req);
    if (!tenantId || !ensureTenantAccess(req, res, tenantId)) return;
    const row = await getShopPlaybookRow(tenantId);
    const result = evaluateShopAction(row?.playbook, req.body || {});
    if (result.reason === "out_of_area" && result.completion === "refused") {
      await upsertCutoverItem(
        tenantId,
        "refuse_out_of_area",
        true,
        "Verified by deterministic evaluator",
      );
    }
    if (
      ["quote_hold", "bookable"].includes(result.reason) &&
      ["approval_held", "booked"].includes(result.completion || "")
    ) {
      await upsertCutoverItem(
        tenantId,
        "book_or_hold",
        true,
        "Verified by deterministic evaluator",
      );
      if (result.reason === "quote_hold") {
        await upsertCutoverItem(
          tenantId,
          "quote_or_hold",
          true,
          "Verified by deterministic evaluator",
        );
      }
    }
    res.json({ evaluation: result });
  });

  app.post("/api/admin/call-board/plan", adminGuard("viewer"), async (req: AuthedRequest, res) => {
    const tenantId = tenantFrom(req);
    if (!tenantId || !ensureTenantAccess(req, res, tenantId)) return;
    const row = await getShopPlaybookRow(tenantId);
    const utterance = String(req.body?.utterance || "");
    const history = Array.isArray(req.body?.history)
      ? req.body.history
      : [{ role: "user", content: utterance }];
    const plan = planReceptionistTurn({
      utterance,
      history,
      callerId: req.body?.callerId,
      existing: req.body?.existing,
      profile: normalizeIntakeProfile(req.body?.intakeProfile, tenantId),
      tenantId,
      playbook: row?.playbook,
      afterHours: Boolean(req.body?.afterHours),
      transfersAllowed: req.body?.transfersAllowed !== false,
      transferProfiles: req.body?.transferProfiles,
      posted: Boolean(req.body?.posted),
      pricingItems: req.body?.pricingItems,
      quickReply: req.body?.quickReply,
    });
    if (plan.intent === "faq") {
      await upsertCutoverItem(tenantId, "faq_hours", true, `Call board FAQ plan on ${utterance.slice(0, 80)}`);
    }
    if (plan.intent === "transfer" || plan.intent === "message" || plan.writeTask) {
      await upsertCutoverItem(tenantId, "transfer_or_message", true, "Call board transfer-or-message plan");
    }
    if (plan.intent === "status" || plan.board.have.some((line) => line.startsWith("existing-customer:"))) {
      await upsertCutoverItem(tenantId, "existing_cid", true, "Call board existing-customer HAVE");
    }
    if (plan.intent === "quote" || plan.shop.decision === "hold") {
      await upsertCutoverItem(tenantId, "quote_or_hold", true, "Call board quote or hold");
    }
    res.json({ plan });
  });

  app.post(
    "/api/runtime/night-desk/evaluate",
    adminGuard("admin"),
    async (req: AuthedRequest, res) => {
      const tenantId = tenantFrom(req);
      if (!tenantId || !ensureTenantAccess(req, res, tenantId)) return;
      const parsed = z
        .object({
          callId: z.string().min(1).max(200),
          callerId: z.string().max(100).optional(),
          utterance: z.string().min(1).max(10_000),
          proposedReply: z.string().max(20_000),
          transcript: z.string().max(100_000).optional(),
          lead: z.record(z.unknown()).optional(),
          afterHours: z.boolean().optional(),
          distanceMiles: z.number().nonnegative().optional(),
          existingOpenJobs: z.number().int().nonnegative().optional(),
          membership: z.string().max(500).optional(),
          allowDryRun: z.boolean().optional(),
        })
        .safeParse(req.body || {});
      if (!parsed.success) {
        return res.status(400).json({
          error: "invalid_night_desk_turn",
          details: parsed.error.issues,
        });
      }
      const result = await processNightDeskTurn({
        tenantId,
        ...parsed.data,
        // Runtime cannot opt itself into a fake board write.
        allowDryRun: req.ctx?.isSuperAdmin
          ? Boolean(parsed.data.allowDryRun)
          : false,
      });
      res.json(result);
    },
  );

  app.post(
    "/api/runtime/oncall-outcome",
    adminGuard("admin"),
    async (req: AuthedRequest, res) => {
      const tenantId = tenantFrom(req);
      if (!tenantId || !ensureTenantAccess(req, res, tenantId)) return;
      const parsed = z
        .object({
          callId: z.string().min(1).max(200),
          transferCallControlId: z.string().max(200).optional(),
          status: z.enum(["initiated", "answered", "failed"]),
          reason: z.string().max(500).optional(),
        })
        .safeParse(req.body || {});
      if (!parsed.success) {
        return res.status(400).json({
          error: "invalid_oncall_outcome",
          details: parsed.error.issues,
        });
      }
      await handleOncallTransferOutcome({ tenantId, ...parsed.data });
      res.json({ ok: true });
    },
  );

  app.post(
    "/api/runtime/oncall-drill-outcome",
    adminGuard("admin"),
    async (req: AuthedRequest, res) => {
      const tenantId = tenantFrom(req);
      if (!tenantId || !ensureTenantAccess(req, res, tenantId)) return;
      const parsed = z
        .object({
          drillId: z.string().uuid(),
          callControlId: z.string().max(200).optional(),
          status: z.enum(["answered", "failed"]),
          latencyMs: z.number().int().nonnegative().optional(),
          reason: z.string().max(500).optional(),
        })
        .safeParse(req.body || {});
      if (!parsed.success) {
        return res.status(400).json({
          error: "invalid_oncall_drill_outcome",
          details: parsed.error.issues,
        });
      }
      const drill = await completeOncallDrill({
        tenantId,
        id: parsed.data.drillId,
        ok: parsed.data.status === "answered",
        latencyMs: parsed.data.latencyMs,
        reason: parsed.data.reason,
        callControlId: parsed.data.callControlId,
      });
      if (!drill) return res.status(404).json({ error: "drill_not_found" });
      if (parsed.data.status === "answered") {
        await upsertCutoverItem(
          tenantId,
          "oncall_sms",
          true,
          `Voice drill answered in ${parsed.data.latencyMs || 0} ms`,
        );
      }
      res.json({ drill });
    },
  );

  app.post(
    "/api/runtime/call-recording",
    adminGuard("admin"),
    async (req: AuthedRequest, res) => {
      const tenantId = tenantFrom(req);
      if (!tenantId || !ensureTenantAccess(req, res, tenantId)) return;
      const parsed = z
        .object({
          callId: z.string().min(1).max(200),
          recordingUrl: z.string().url().max(4000),
        })
        .safeParse(req.body || {});
      if (!parsed.success) {
        return res.status(400).json({
          error: "invalid_call_recording",
          details: parsed.error.issues,
        });
      }
      await attachCallRecording({
        tenantId,
        callId: parsed.data.callId,
        recordingUrl: parsed.data.recordingUrl,
      });
      res.json({ ok: true });
    },
  );

  app.get("/api/admin/completions", adminGuard("viewer"), async (req: AuthedRequest, res) => {
    const tenantId = tenantFrom(req);
    if (!tenantId || !ensureTenantAccess(req, res, tenantId)) return;
    const metrics = await completionMetrics(tenantId);
    res.json({
      metrics,
      completionRate: metrics.total ? (metrics.total - metrics.orphans) / metrics.total : 1,
      orphanPromise: metrics.orphans,
      audit: await listCompletionEvents(tenantId, 50),
    });
  });

  app.post("/api/admin/completions", adminGuard("admin"), async (req: AuthedRequest, res) => {
    const tenantId = tenantFrom(req);
    if (!tenantId || !ensureTenantAccess(req, res, tenantId)) return;
    const completion = CALL_COMPLETIONS.includes(req.body?.completion) ? req.body.completion : undefined;
    const out = await finalizeCallCompletion({
      tenantId,
      callId: String(req.body?.callId || `manual-${Date.now()}`),
      callerId: req.body?.callerId,
      transcript: req.body?.transcript,
      lead: req.body?.lead,
      claimed: completion,
    });
    res.json(out);
  });

  app.get("/api/admin/cutover", adminGuard("viewer"), async (req: AuthedRequest, res) => {
    const tenantId = tenantFrom(req);
    if (!tenantId || !ensureTenantAccess(req, res, tenantId)) return;
    const cut = await getCutover(tenantId);
    res.json(cut);
  });

  app.put("/api/admin/cutover/:itemId", adminGuard("admin"), async (req: AuthedRequest, res) => {
    const tenantId = tenantFrom(req);
    if (!tenantId || !ensureTenantAccess(req, res, tenantId)) return;
    const itemId = req.params.itemId;
    if (!CUTOVER_ITEM_IDS.includes(itemId as (typeof CUTOVER_ITEM_IDS)[number])) {
      return res.status(400).json({ error: "unknown_cutover_item" });
    }
    const passed = Boolean(req.body?.passed);
    if (
      passed &&
      !(await hasCutoverEvidence(
        tenantId,
        itemId as (typeof CUTOVER_ITEM_IDS)[number],
      ))
    ) {
      return res.status(409).json({
        error: "cutover_evidence_missing",
        itemId,
      });
    }
    await upsertCutoverItem(tenantId, itemId, passed, req.body?.note);
    const cut = await getCutover(tenantId);
    await setPlaybookFlags(tenantId, { nightDeskLive: cut.live });
    res.json(cut);
  });

  app.get("/api/admin/approvals", adminGuard("viewer"), async (req: AuthedRequest, res) => {
    const tenantId = tenantFrom(req);
    if (!tenantId || !ensureTenantAccess(req, res, tenantId)) return;
    res.json({ approvals: await listApprovals(tenantId, typeof req.query.status === "string" ? req.query.status : undefined) });
  });

  app.post("/api/admin/approvals", adminGuard("admin"), async (req: AuthedRequest, res) => {
    const tenantId = tenantFrom(req);
    if (!tenantId || !ensureTenantAccess(req, res, tenantId)) return;
    const row = await createApproval(tenantId, String(req.body?.summary || "Held booking"), req.body?.payload || {}, req.body?.callId);
    res.json({ approval: row });
  });

  app.post("/api/admin/approvals/:id/decide", adminGuard("admin"), async (req: AuthedRequest, res) => {
    const tenantId = tenantFrom(req);
    if (!tenantId || !ensureTenantAccess(req, res, tenantId)) return;
    const status = req.body?.status === "rejected" ? "rejected" : "approved";
    const approval = await getApproval(tenantId, req.params.id);
    if (!approval) return res.status(404).json({ error: "not_found" });
    if (approval.status !== "pending") {
      return res.status(409).json({ error: "approval_already_decided" });
    }
    let fsmResult: Awaited<ReturnType<typeof writeBoardJob>> | undefined;
    if (status === "approved") {
      const payload =
        approval.payload && typeof approval.payload === "object"
          ? approval.payload
          : {};
      fsmResult = await writeBoardJob(tenantId, {
        callId: String(approval.call_id || `approval-${approval.id}`),
        idempotencyKey: String(approval.call_id || approval.id),
        customer: {
          name: String(payload.name || payload.customerName || ""),
          phone: String(payload.phone || payload.callerId || ""),
          email:
            typeof payload.email === "string" ? payload.email : undefined,
          address: String(
            payload.address || payload.serviceAddress || payload.zip || "",
          ),
        },
        jobType: String(
          payload.jobType || payload.service || payload.issue || "Service call",
        ),
        notes: String(payload.notes || approval.summary || ""),
        membership:
          typeof payload.membership === "string"
            ? payload.membership
            : undefined,
        warranty:
          typeof payload.warranty === "string"
            ? payload.warranty
            : undefined,
        startIso:
          typeof payload.startIso === "string"
            ? payload.startIso
            : undefined,
      });
      if (!fsmResult.ok || !fsmResult.jobId || fsmResult.dryRun) {
        return res.status(409).json({
          error: fsmResult.dryRun
            ? "fsm_not_connected"
            : "fsm_write_failed",
          details: fsmResult.error,
        });
      }
    }
    const row = await decideApproval(tenantId, req.params.id, status, req.ctx?.email);
    if (!row) return res.status(404).json({ error: "not_found" });
    const completion = status === "approved" ? "booked" : "refused";
    if (approval.call_id) {
      await upsertCallCompletion({
        tenantId,
        callId: approval.call_id,
        completion,
        reason:
          status === "approved"
            ? "owner_approved_fsm_written"
            : "owner_rejected_hold",
        source: "approval_decision",
        input: approval.payload,
        fsmJobId: fsmResult?.jobId,
        fsmProvider: fsmResult?.provider,
        actor: req.ctx?.email || "owner",
      });
      await mirrorCompletionToCallAndLeads({
        tenantId,
        callId: approval.call_id,
        completion,
        reason:
          status === "approved"
            ? "owner_approved_fsm_written"
            : "owner_rejected_hold",
      });
    }
    res.json({ approval: row, completion, fsm: fsmResult });
  });

  app.get("/api/admin/oncall", adminGuard("viewer"), async (req: AuthedRequest, res) => {
    const tenantId = tenantFrom(req);
    if (!tenantId || !ensureTenantAccess(req, res, tenantId)) return;
    const playbook = await getShopPlaybookRow(tenantId);
    const resolved = await resolveOnCallE164(tenantId);
    res.json({
      staticE164: playbook?.playbook.onCallE164 || null,
      timeoutSecs: playbook?.playbook.onCallTimeoutSecs || 75,
      resolved,
      rotation: await listOncallRotation(tenantId),
      lastDrill: await latestOncallDrill(tenantId),
    });
  });

  app.put("/api/admin/oncall/rotation", adminGuard("admin"), async (req: AuthedRequest, res) => {
    const tenantId = tenantFrom(req);
    if (!tenantId || !ensureTenantAccess(req, res, tenantId)) return;
    const rows = z
      .array(
        z.object({
          label: z.string().min(1).max(120),
          e164: z.string().regex(/^\+[1-9]\d{7,14}$/),
          weekday: z.number().int().min(0).max(6).optional(),
          startHhmm: z
            .string()
            .regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/)
            .optional(),
          endHhmm: z
            .string()
            .regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/)
            .optional(),
          quietHours: z.boolean().optional(),
        }),
      )
      .parse(req.body?.rotation || []);
    await replaceOncallRotation(tenantId, rows);
    res.json({ rotation: await listOncallRotation(tenantId) });
  });

  app.post("/api/admin/oncall/page", adminGuard("admin"), async (req: AuthedRequest, res) => {
    const tenantId = tenantFrom(req);
    if (!tenantId || !ensureTenantAccess(req, res, tenantId)) return;
    const resolved = await resolveOnCallE164(tenantId);
    const to = String(req.body?.e164 || resolved.e164 || "");
    if (!to) return res.status(400).json({ error: "oncall_e164_required" });
    const sent = await sendNightDeskSms(
      to,
      String(
        req.body?.text ||
          "VeraLux on-call page — answer or we will task the owner.",
      ),
      tenantId,
    );
    res.json({ sent, to, timeoutSecs: resolved.timeoutSecs, quietHours: resolved.quietHours });
  });

  app.post("/api/admin/oncall/drill", adminGuard("admin"), async (req: AuthedRequest, res) => {
    const tenantId = tenantFrom(req);
    if (!tenantId || !ensureTenantAccess(req, res, tenantId)) return;
    const resolved = await resolveOnCallE164(tenantId);
    const to = String(req.body?.e164 || resolved.e164 || "");
    const started = Date.now();
    const sent = to
      ? await sendNightDeskSms(
          to,
          "VeraLux drill: reply OK if you received this page.",
          tenantId,
        )
      : false;
    const voice = to
      ? await startVoiceOncallDrill({
          tenantId,
          e164: to,
          timeoutSecs: Number(req.body?.timeoutSecs) || 30,
        })
      : {
          drill: await insertOncallDrill(
            tenantId,
            "none",
            Date.now() - started,
            false,
            "failed",
          ),
          dialed: false,
          error: "oncall_e164_required",
        };
    res.json({ drill: voice.drill, smsSent: sent, voiceDialed: voice.dialed, error: voice.error });
  });

  app.post(
    "/api/admin/fsm/jobber/oauth/start",
    adminGuard("admin"),
    async (req: AuthedRequest, res) => {
      const tenantId = tenantFrom(req);
      if (!tenantId || !ensureTenantAccess(req, res, tenantId)) return;
      if (req.ctx?.ownerConsole && !req.ctx.isSuperAdmin) {
        return res.status(403).json({ error: "admin_required" });
      }
      const redirectUri = `${publicControlPlaneBase(
        req,
      )}/api/admin/fsm/jobber/oauth/callback`;
      const result = await beginJobberOAuth(tenantId, redirectUri);
      res.json(result);
    },
  );

  app.get(
    "/api/admin/fsm/jobber/oauth/callback",
    async (req: Request, res: Response) => {
      const state = String(req.query.state || "");
      const code = String(req.query.code || "");
      if (!state || !code) {
        return res.status(400).send("Missing Jobber OAuth code or state.");
      }
      try {
        await completeJobberOAuth(state, code);
        return res.redirect("/admin/settings?jobber=connected");
      } catch (error) {
        return res
          .status(400)
          .send(
            `Jobber connection failed: ${
              error instanceof Error ? error.message : "unknown error"
            }`,
          );
      }
    },
  );

  app.delete(
    "/api/admin/fsm/jobber",
    adminGuard("admin"),
    async (req: AuthedRequest, res) => {
      const tenantId = tenantFrom(req);
      if (!tenantId || !ensureTenantAccess(req, res, tenantId)) return;
      if (req.ctx?.ownerConsole && !req.ctx.isSuperAdmin) {
        return res.status(403).json({ error: "admin_required" });
      }
      await disconnectJobber(tenantId);
      res.json({ ok: true });
    },
  );

  app.get("/api/admin/fsm", adminGuard("viewer"), async (req: AuthedRequest, res) => {
    const tenantId = tenantFrom(req);
    if (!tenantId || !ensureTenantAccess(req, res, tenantId)) return;
    res.json({
      connections: await getFsmConnections(tenantId),
      jobberConfigured:
        (await secretStore.hasSecret(tenantId, JOBBER_TOKEN_SECRET_KEY)) ||
        (await secretStore.hasSecret(tenantId, JOBBER_SECRET_KEY)),
      housecallProConfigured: await secretStore.hasSecret(tenantId, HCP_SECRET_KEY),
      jobberMembershipFieldConfigured: await secretStore.hasSecret(
        tenantId,
        JOBBER_MEMBERSHIP_FIELD_KEY,
      ),
      jobberWarrantyFieldConfigured: await secretStore.hasSecret(
        tenantId,
        JOBBER_WARRANTY_FIELD_KEY,
      ),
    });
  });

  app.put(
    "/api/admin/fsm/jobber/custom-fields",
    adminGuard("admin"),
    async (req: AuthedRequest, res) => {
      const tenantId = tenantFrom(req);
      if (!tenantId || !ensureTenantAccess(req, res, tenantId)) return;
      if (req.ctx?.ownerConsole && !req.ctx.isSuperAdmin) {
        return res.status(403).json({ error: "admin_required" });
      }
      const membershipFieldId = String(
        req.body?.membershipFieldId || "",
      ).trim();
      const warrantyFieldId = String(
        req.body?.warrantyFieldId || "",
      ).trim();
      if (membershipFieldId) {
        await secretStore.setSecret(
          tenantId,
          JOBBER_MEMBERSHIP_FIELD_KEY,
          membershipFieldId,
        );
      }
      if (warrantyFieldId) {
        await secretStore.setSecret(
          tenantId,
          JOBBER_WARRANTY_FIELD_KEY,
          warrantyFieldId,
        );
      }
      res.json({ ok: true });
    },
  );

  app.put("/api/admin/fsm/:provider/token", adminGuard("admin"), async (req: AuthedRequest, res) => {
    const tenantId = tenantFrom(req);
    if (!tenantId || !ensureTenantAccess(req, res, tenantId)) return;
    const provider = req.params.provider;
    if (!["jobber", "housecall_pro"].includes(provider)) {
      return res.status(400).json({ error: "unsupported_fsm_provider" });
    }
    if (req.ctx?.ownerConsole && !req.ctx.isSuperAdmin) {
      return res.status(403).json({ error: "admin_required" });
    }
    const token = String(req.body?.token || "").trim();
    if (!token) return res.status(400).json({ error: "token_required" });
    const key = provider === "housecall_pro" ? HCP_SECRET_KEY : JOBBER_SECRET_KEY;
    await secretStore.setSecret(tenantId, key, token);
    await upsertFsmConnection(tenantId, provider === "housecall_pro" ? "housecall_pro" : "jobber", "connected");
    res.json({ ok: true, provider });
  });

  app.post("/api/admin/fsm/write", adminGuard("admin"), async (req: AuthedRequest, res) => {
    const tenantId = tenantFrom(req);
    if (!tenantId || !ensureTenantAccess(req, res, tenantId)) return;
    const result = await writeBoardJob(tenantId, {
      callId: String(req.body?.callId || `manual-${Date.now()}`),
      customer: req.body?.customer || {},
      jobType: req.body?.jobType,
      notes: req.body?.notes,
      membership: req.body?.membership,
      startIso: req.body?.startIso,
    });
    res.json({ result });
  });

  app.get("/api/admin/cid-lookup", adminGuard("viewer"), async (req: AuthedRequest, res) => {
    const tenantId = tenantFrom(req);
    if (!tenantId || !ensureTenantAccess(req, res, tenantId)) return;
    const phone = String(req.query.phone || "");
    if (!phone) return res.status(400).json({ error: "phone_required" });
    const hit = await lookupCustomerByPhone(tenantId, phone);
    res.json({ match: hit });
  });

  app.get("/api/admin/digest", adminGuard("viewer"), async (req: AuthedRequest, res) => {
    const tenantId = tenantFrom(req);
    if (!tenantId || !ensureTenantAccess(req, res, tenantId)) return;
    const digest = await buildMorningDigest(
      tenantId,
      typeof req.query.localDate === "string"
        ? req.query.localDate
        : undefined,
    );
    const approvals = await listApprovals(tenantId, "pending");
    const limits = await getTenantLimits(tenantId);
    res.json({
      localDate: digest.localDate,
      timezone: digest.timezone,
      metrics: digest.metrics,
      series: await completionDailySeries(
        tenantId,
        digest.timezone,
        30,
      ),
      approvalsPending: approvals.length,
      calls: digest.rows.length,
      items: digest.rows.map((r) => ({
        ...r,
        callerName: r.caller_name || null,
        callerId: r.caller_id || null,
        portalUrl: `/portal/calls?call=${encodeURIComponent(r.call_id)}`,
        adminUrl: `/admin/calls?call=${encodeURIComponent(r.call_id)}`,
        recordingUrl: limits.callRecording
          ? r.resolved_recording_url || null
          : null,
      })),
    });
  });

  app.get(
    "/api/admin/digest.csv",
    adminGuard("viewer"),
    async (req: AuthedRequest, res) => {
      const tenantId = tenantFrom(req);
      if (!tenantId || !ensureTenantAccess(req, res, tenantId)) return;
      const digest = await buildMorningDigest(
        tenantId,
        typeof req.query.localDate === "string"
          ? req.query.localDate
          : undefined,
      );
      const escape = (value: unknown) =>
        `"${String(value ?? "").replace(/"/g, '""')}"`;
      const lines = [
        [
          "created_at",
          "call_id",
          "completion",
          "reason",
          "booked_cents",
          "fsm_provider",
          "fsm_job_id",
        ].join(","),
        ...digest.rows.map((row) =>
          [
            row.created_at,
            row.call_id,
            row.completion,
            row.reason,
            row.booked_cents,
            row.fsm_provider,
            row.fsm_job_id,
          ]
            .map(escape)
            .join(","),
        ),
      ];
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="veralux-night-desk-${digest.localDate}.csv"`,
      );
      res.send(lines.join("\n"));
    },
  );

  app.post("/api/admin/digest/send", adminGuard("admin"), async (req: AuthedRequest, res) => {
    const tenantId = tenantFrom(req);
    if (!tenantId || !ensureTenantAccess(req, res, tenantId)) return;
    const out = await sendMorningDigest(tenantId, { force: true });
    res.json(out);
  });

  app.post("/api/admin/inbound-leads", adminGuard("admin"), async (req: AuthedRequest, res) => {
    const tenantId = tenantFrom(req);
    if (!tenantId || !ensureTenantAccess(req, res, tenantId)) return;
    res.json(await ingestLead(tenantId, req.body || {}));
  });

  app.post("/api/admin/qa", adminGuard("admin"), async (req: AuthedRequest, res) => {
    const tenantId = tenantFrom(req);
    if (!tenantId || !ensureTenantAccess(req, res, tenantId)) return;
    const row = await scoreNightDeskCall({
      tenantId,
      callId: String(req.body?.callId || "unknown"),
      transcript: String(req.body?.transcript || ""),
    });
    res.json({ score: row });
  });

  app.get("/api/admin/qa", adminGuard("viewer"), async (req: AuthedRequest, res) => {
    const tenantId = tenantFrom(req);
    if (!tenantId || !ensureTenantAccess(req, res, tenantId)) return;
    const rows = await listQaScores(tenantId);
    const scores = rows.map((row) => presentQaScore(row as Record<string, unknown>));
    res.json({
      scores,
      needsReview: scores.filter((s) => s.needsReview).length,
      averageScore: scores.length
        ? Math.round(scores.reduce((sum, s) => sum + s.score, 0) / scores.length)
        : 0,
    });
  });

  app.get("/api/runtime/cid-lookup", adminGuard("admin"), async (req: AuthedRequest, res) => {
    const tenantId = tenantFrom(req);
    if (!tenantId || !ensureTenantAccess(req, res, tenantId)) return;
    const phone = String(req.query.phone || "");
    if (!phone) return res.status(400).json({ error: "phone_required" });
    const hit = await lookupCustomerByPhone(tenantId, phone);
    res.json({ match: hit });
  });

  app.post("/api/runtime/oncall-page", adminGuard("admin"), async (req: AuthedRequest, res) => {
    const tenantId = tenantFrom(req);
    if (!tenantId || !ensureTenantAccess(req, res, tenantId)) return;
    const resolved = await resolveOnCallE164(tenantId);
    const to = String(req.body?.e164 || resolved.e164 || "");
    if (!to) return res.status(400).json({ error: "oncall_e164_required" });
    const sent = await sendNightDeskSms(
      to,
      String(req.body?.text || `VeraLux on-call page for ${req.body?.callerId || "unknown"}. Answer or we will task the owner.`),
      tenantId,
    );
    res.json({ sent, to, timeoutSecs: resolved.timeoutSecs, quietHours: resolved.quietHours });
  });

  app.post("/api/public/inbound-lead", async (req: Request, res) => {
    const token = String(req.headers["x-inbound-token"] || req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    const expected = String(process.env.INBOUND_LEAD_TOKEN || "").trim();
    if (!expected) {
      return res.status(503).json({ error: "inbound_lead_disabled" });
    }
    if (token !== expected) {
      return res.status(401).json({ error: "inbound_auth_required" });
    }
    const tenantId = String(req.body?.tenantId || req.headers["x-tenant-id"] || "");
    if (!tenantId) return res.status(400).json({ error: "tenant_id_required" });
    res.json(await ingestLead(tenantId, req.body || {}));
  });

  const STT_PRESETS = ["whisper_http", "deepgram", "openai_whisper"] as const;
  app.get("/api/admin/owned-voice", adminGuard("viewer"), async (req: AuthedRequest, res) => {
    const tenantId = tenantFrom(req);
    if (!tenantId || !ensureTenantAccess(req, res, tenantId)) return;
    const ctx = tenants.getOrCreate(tenantId);
    const stt = ctx.config.getSttConfig();
    res.json({
      sttMode: stt.mode || "whisper_http",
      presets: STT_PRESETS,
      telnyxOwned: await secretStore.hasSecret(
        tenantId,
        TENANT_TELNYX_API_KEY,
      ),
      ownerCannotSetRawUrls: true,
    });
  });

  app.put("/api/admin/owned-voice", adminGuard("admin"), async (req: AuthedRequest, res) => {
    const tenantId = tenantFrom(req);
    if (!tenantId || !ensureTenantAccess(req, res, tenantId)) return;
    const mode = String(req.body?.sttMode || "");
    if (!STT_PRESETS.includes(mode as (typeof STT_PRESETS)[number])) {
      return res.status(400).json({ error: "invalid_stt_preset" });
    }
    const ctx = tenants.getOrCreate(tenantId);
    ctx.config.setSttConfig({ mode: mode as "whisper_http" | "deepgram" | "openai_whisper" });
    tenants.persistConfig(tenantId);
    const pub = await autoPublishTenantRuntimeAfterSave(tenantId, { settingArea: "owned_voice", actorRole: "admin" });
    res.json({ sttMode: mode, published: pub.published });
  });

  app.put("/api/admin/telnyx/tenant-credentials", adminGuard("admin"), async (req: AuthedRequest, res) => {
    const tenantId = tenantFrom(req);
    if (!tenantId || !ensureTenantAccess(req, res, tenantId)) return;
    if (req.ctx?.ownerConsole && !req.ctx.isSuperAdmin) {
      return res.status(403).json({ error: "admin_required" });
    }
    const key = String(req.body?.apiKey || "").trim();
    if (!key) return res.status(400).json({ error: "api_key_required" });
    const phone = req.body?.phoneNumber
      ? String(req.body.phoneNumber).trim()
      : undefined;
    const publicKey = req.body?.publicKey
      ? String(req.body.publicKey).trim()
      : undefined;
    if (phone && !/^\+[1-9]\d{7,14}$/.test(phone)) {
      return res.status(400).json({ error: "invalid_phone_number" });
    }
    if (publicKey && publicKey.length < 16) {
      return res.status(400).json({ error: "invalid_telnyx_public_key" });
    }
    await secretStore.setSecret(tenantId, TENANT_TELNYX_API_KEY, key);
    if (req.body?.connectionId) {
      await secretStore.setSecret(
        tenantId,
        TENANT_TELNYX_CONNECTION_ID,
        String(req.body.connectionId),
      );
    }
    if (phone) {
      await secretStore.setSecret(
        tenantId,
        TENANT_TELNYX_PHONE_NUMBER,
        phone,
      );
    }
    if (publicKey) {
      await secretStore.setSecret(
        tenantId,
        TENANT_TELNYX_PUBLIC_KEY,
        publicKey,
      );
    }
    const pub = await autoPublishTenantRuntimeAfterSave(tenantId, {
      settingArea: "tenant_telnyx_credentials",
      actorRole: "superadmin",
    });
    res.json({ ok: true, telnyxOwned: true, published: pub.published });
  });

  app.get(
    "/api/runtime/tenant-telnyx-credentials",
    adminGuard("admin"),
    async (req: AuthedRequest, res) => {
      const tenantId = tenantFrom(req);
      if (!tenantId || !ensureTenantAccess(req, res, tenantId)) return;
      if (!req.ctx?.isSuperAdmin) {
        return res.status(403).json({ error: "superadmin_required" });
      }
      const [apiKey, connectionId, phoneNumber, publicKey] = await Promise.all([
        secretStore.getSecret(tenantId, TENANT_TELNYX_API_KEY),
        secretStore.getSecret(tenantId, TENANT_TELNYX_CONNECTION_ID),
        secretStore.getSecret(tenantId, TENANT_TELNYX_PHONE_NUMBER),
        secretStore.getSecret(tenantId, TENANT_TELNYX_PUBLIC_KEY),
      ]);
      res.setHeader("Cache-Control", "no-store");
      res.json({
        configured: Boolean(apiKey),
        apiKey: apiKey || null,
        connectionId: connectionId || null,
        phoneNumber: phoneNumber || null,
        publicKey: publicKey || null,
      });
    },
  );
}
