"use strict";

process.env.SECRET_ENCRYPTION_KEY =
  process.env.SECRET_ENCRYPTION_KEY || "test-secret-encryption-key-32bytes-minimum";

const test = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { closePool, pool, runMigrations } = require("../dist/db.js");
const {
  createWorkflow,
  listWorkflows,
  listRuns,
  createRun,
  getWorkflowByTemplate,
} = require("../dist/automations/db.js");
const {
  ensureTenantWorkflows,
  enableWorkflowTemplate,
  adoptDemoShopWorkflows,
  galleryPayload,
} = require("../dist/automations/templates.js");

const tenantId = `wf-tpl-${randomUUID()}`;
let dbAvailable = false;

test("workflow template database setup", async (t) => {
  try {
    await runMigrations();
    await pool.query(
      "INSERT INTO tenants (id, name) VALUES ($1, $2) ON CONFLICT DO NOTHING",
      [tenantId, "Workflow Template Test"],
    );
    dbAvailable = true;
  } catch (error) {
    t.skip(`postgres unavailable: ${error.message}`);
  }
});

test("ensureTenantWorkflows seeds default ON templates 1–4", async (t) => {
  if (!dbAvailable) return t.skip("postgres unavailable");
  const seeded = await ensureTenantWorkflows(tenantId);
  const ids = seeded.map((w) => w.templateId).sort();
  assert.deepEqual(ids, [
    "hot-lead-emergency-alert",
    "missed-call-callback-sms",
    "morning-digest",
    "night-desk-capture-book",
  ].sort());
  assert.ok(seeded.every((w) => w.enabled));
  assert.ok(seeded.every((w) => w.adminLocked));
});

test("ensureTenantWorkflows is idempotent", async (t) => {
  if (!dbAvailable) return t.skip("postgres unavailable");
  const first = await listWorkflows(tenantId);
  const second = await ensureTenantWorkflows(tenantId);
  assert.equal(second.length, first.length);
});

test("gallery lists 16 templates with installed map", async (t) => {
  if (!dbAvailable) return t.skip("postgres unavailable");
  const payload = galleryPayload(await listWorkflows(tenantId));
  assert.equal(payload.templates.length, 16);
  assert.ok(payload.installed["night-desk-capture-book"]);
  assert.equal(payload.installed["jobber-job-write"], undefined);
});

test("enabling a gallery template is off-by-default until enabled, then idempotent", async (t) => {
  if (!dbAvailable) return t.skip("postgres unavailable");
  const first = await enableWorkflowTemplate({
    tenantId,
    templateId: "jobber-job-write",
    enabled: true,
  });
  assert.equal(first.created, true);
  assert.equal(first.workflow.enabled, true);
  assert.equal(first.workflow.steps[0].action, "write_fsm_job");
  const second = await enableWorkflowTemplate({
    tenantId,
    templateId: "jobber-job-write",
    enabled: true,
  });
  assert.equal(second.created, false);
  assert.equal(second.workflow.id, first.workflow.id);
});

test("Demo Shop legacy row is renamed to Night desk capture & book", async (t) => {
  if (!dbAvailable) return t.skip("postgres unavailable");
  const extraTenant = `wf-demo-${randomUUID()}`;
  await pool.query(
    "INSERT INTO tenants (id, name) VALUES ($1, $2) ON CONFLICT DO NOTHING",
    [extraTenant, "Demo Shop"],
  );
  await createWorkflow({
    tenantId: extraTenant,
    name: "Demo Shop — store lead + book calendar on call end",
    triggerType: "call_ended",
    triggerConfig: {},
    steps: [
      { action: "ai_extract", config: {}, order: 0 },
      { action: "store_lead", config: {}, order: 1 },
      { action: "fire_webhook", config: { url: "http://demo-shop-book-helper:8791/book" }, order: 2 },
    ],
    createdBy: "admin",
  });
  const adopted = await adoptDemoShopWorkflows(extraTenant);
  assert.equal(adopted.length, 1);
  assert.equal(adopted[0].name, "Night desk capture & book");
  assert.equal(adopted[0].templateId, "night-desk-capture-book");
  const seeded = await ensureTenantWorkflows(extraTenant);
  assert.ok(seeded.some((w) => w.templateId === "morning-digest"));
  const night = await getWorkflowByTemplate(extraTenant, "night-desk-capture-book");
  assert.equal(night.name, "Night desk capture & book");
});

test("listRuns today returns only today's rows with workflow name", async (t) => {
  if (!dbAvailable) return t.skip("postgres unavailable");
  const wf = (await listWorkflows(tenantId))[0];
  await createRun({
    workflowId: wf.id,
    tenantId,
    triggerEvent: { type: "call_ended" },
    stepsTotal: 1,
  });
  const today = await listRuns(tenantId, 25, { today: true, timezone: "America/Los_Angeles" });
  assert.ok(today.length >= 1);
  assert.ok(today[0].workflowName);
});

test("cleanup workflow template tenant", async () => {
  if (dbAvailable) {
    await pool.query("DELETE FROM tenants WHERE id LIKE 'wf-tpl-%' OR id LIKE 'wf-demo-%'");
  }
  await closePool().catch(() => {});
});
