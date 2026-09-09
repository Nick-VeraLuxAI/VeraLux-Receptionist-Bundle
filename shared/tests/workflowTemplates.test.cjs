const test = require("node:test");
const assert = require("node:assert/strict");
const {
  WORKFLOW_TEMPLATES,
  WORKFLOW_TEMPLATE_IDS,
  DEFAULT_ON_TEMPLATE_IDS,
  DEMO_SHOP_LEGACY_WORKFLOW_NAME,
  getWorkflowTemplate,
  instantiateWorkflowTemplate,
  applyTemplateConfig,
  isDemoShopLegacyWorkflowName,
  listWorkflowTemplatesForGallery,
  isWorkflowTemplateId,
} = require("../dist/workflowTemplates.js");

test("catalog has exactly the 16 build-list templates", () => {
  assert.equal(WORKFLOW_TEMPLATES.length, 16);
  assert.deepEqual(
    WORKFLOW_TEMPLATES.map((t) => t.id),
    [...WORKFLOW_TEMPLATE_IDS],
  );
});

test("default ON is templates 1–4 only", () => {
  assert.deepEqual(DEFAULT_ON_TEMPLATE_IDS, [
    "night-desk-capture-book",
    "hot-lead-emergency-alert",
    "morning-digest",
    "missed-call-callback-sms",
  ]);
  for (const t of WORKFLOW_TEMPLATES) {
    if (DEFAULT_ON_TEMPLATE_IDS.includes(t.id)) assert.equal(t.defaultEnabled, true);
    else assert.equal(t.defaultEnabled, false);
  }
});

test("each template has id, name, description, trigger, ordered actions, config fields", () => {
  for (const t of WORKFLOW_TEMPLATES) {
    assert.ok(isWorkflowTemplateId(t.id), t.id);
    assert.ok(t.name);
    assert.ok(t.description);
    assert.ok(t.trigger && t.trigger.type);
    assert.ok(Array.isArray(t.steps) && t.steps.length >= 1);
    const orders = t.steps.map((s) => s.order);
    assert.deepEqual(orders, [...orders].sort((a, b) => a - b));
    assert.ok(Array.isArray(t.configFields));
  }
});

test("gallery splits default vs off-by-default", () => {
  const gallery = listWorkflowTemplatesForGallery();
  assert.equal(gallery.filter((t) => t.category === "default").length, 4);
  assert.equal(gallery.filter((t) => t.category === "gallery").length, 12);
});

test("Demo Shop legacy name maps to night-desk-capture-book", () => {
  assert.equal(isDemoShopLegacyWorkflowName(DEMO_SHOP_LEGACY_WORKFLOW_NAME), true);
  assert.equal(
    isDemoShopLegacyWorkflowName("Demo Shop — store lead + book calendar on call end"),
    true,
  );
  assert.equal(isDemoShopLegacyWorkflowName("Missed call SMS"), false);
  assert.equal(getWorkflowTemplate("night-desk-capture-book")?.name, "Night desk capture & book");
});

test("instantiate night-desk capture & book uses extract → lead → book", () => {
  const inst = instantiateWorkflowTemplate("night-desk-capture-book");
  assert.equal(inst.enabled, true);
  assert.equal(inst.templateId, "night-desk-capture-book");
  assert.equal(inst.triggerType, "call_ended");
  assert.deepEqual(
    inst.steps.map((s) => s.action),
    ["ai_extract", "store_lead", "book_calendar"],
  );
});

test("applyTemplateConfig writes webhook URL and mirrors SMS template", () => {
  const template = getWorkflowTemplate("generic-outbound-webhook");
  const applied = applyTemplateConfig(template, {
    webhookUrl: "https://hooks.example.test/zap",
    webhookSecret: "s3cret",
  });
  assert.equal(applied.steps[0].config.url, "https://hooks.example.test/zap");
  assert.equal(applied.steps[0].config.secret, "s3cret");

  const missed = getWorkflowTemplate("missed-call-callback-sms");
  const sms = applyTemplateConfig(missed, { callbackMessage: "Call us back {{caller}}" });
  assert.equal(sms.steps[0].config.message, "Call us back {{caller}}");
  assert.equal(sms.steps[0].config.template, "Call us back {{caller}}");
});

test("gallery templates instantiate off unless explicitly enabled", () => {
  const jobber = instantiateWorkflowTemplate("jobber-job-write");
  assert.equal(jobber.enabled, false);
  assert.equal(jobber.steps[0].config.provider, "jobber");
  const on = instantiateWorkflowTemplate("jobber-job-write", { enabled: true });
  assert.equal(on.enabled, true);
  const hcp = instantiateWorkflowTemplate("housecall-pro-job-write");
  assert.equal(hcp.steps[0].config.provider, "housecall_pro");
});

test("unknown template throws", () => {
  assert.throws(() => instantiateWorkflowTemplate("not-a-template"), /unknown_workflow_template/);
});
