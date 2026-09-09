"use strict";

process.env.SECRET_MANAGER = process.env.SECRET_MANAGER || "db";
process.env.SECRET_ENCRYPTION_KEY =
  process.env.SECRET_ENCRYPTION_KEY || "test-secret-encryption-key-32bytes-minimum";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  instantiateWorkflowTemplate,
  DEFAULT_ON_TEMPLATE_IDS,
  WORKFLOW_TEMPLATES,
  isDemoShopLegacyWorkflowName,
} = require("@veralux/shared");
const { evaluateConditions } = require("../dist/automations/matcher.js");
const { dryRunPipeline } = require("../dist/automations/pipeline.js");
const { qaLooksRisky } = require("../dist/automations/eventBus.js");
const { actionHandlers } = require("../dist/automations/actions.js");

function wf(partial) {
  return {
    id: "wf-1",
    tenantId: "t1",
    name: "Test",
    enabled: true,
    triggerType: "call_ended",
    triggerConfig: {},
    steps: [],
    createdBy: "admin",
    adminLocked: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...partial,
  };
}

const baseEvent = {
  type: "call_ended",
  tenantId: "t1",
  callId: "c1",
  callerId: "+15555550100",
  timestamp: "2026-09-06T12:00:00.000Z",
  transcript: "I smell gas and need emergency help",
  turns: [
    { role: "user", content: "I smell gas and need emergency help" },
  ],
  durationMs: 90_000,
  lead: { name: "Pat", phone: "+15555550100" },
};

test("catalog defaults and action registry cover the 16 templates", () => {
  assert.equal(WORKFLOW_TEMPLATES.length, 16);
  assert.deepEqual(DEFAULT_ON_TEMPLATE_IDS, [
    "night-desk-capture-book",
    "hot-lead-emergency-alert",
    "morning-digest",
    "missed-call-callback-sms",
  ]);
  for (const tpl of WORKFLOW_TEMPLATES) {
    const inst = instantiateWorkflowTemplate(tpl.id);
    for (const step of inst.steps) {
      assert.equal(
        typeof actionHandlers[step.action],
        "function",
        `missing handler ${step.action} for ${tpl.id}`,
      );
    }
  }
});

test("Demo Shop legacy name is night-desk-capture-book", () => {
  assert.equal(
    isDemoShopLegacyWorkflowName("Demo Shop — store lead + book calendar on call end"),
    true,
  );
});

test("keyword_detected matches emergency transcript", () => {
  const inst = instantiateWorkflowTemplate("hot-lead-emergency-alert");
  assert.equal(
    evaluateConditions(wf({ triggerType: inst.triggerType, triggerConfig: inst.triggerConfig }), baseEvent),
    true,
  );
  assert.equal(
    evaluateConditions(
      wf({ triggerType: inst.triggerType, triggerConfig: inst.triggerConfig }),
      { ...baseEvent, transcript: "just asking about hours" },
    ),
    false,
  );
});

test("out-of-area template matches refused + reason", () => {
  const inst = instantiateWorkflowTemplate("out-of-area-refuse-log");
  assert.equal(
    evaluateConditions(wf({ triggerType: inst.triggerType, triggerConfig: inst.triggerConfig }), {
      ...baseEvent,
      completion: "refused",
      completionReason: "out_of_area",
    }),
    true,
  );
  assert.equal(
    evaluateConditions(wf({ triggerType: inst.triggerType, triggerConfig: inst.triggerConfig }), {
      ...baseEvent,
      completion: "booked",
    }),
    false,
  );
});

test("storm hold only matches when stormMode is on", () => {
  const inst = instantiateWorkflowTemplate("storm-surge-hold");
  assert.equal(
    evaluateConditions(wf({ triggerType: inst.triggerType, triggerConfig: inst.triggerConfig }), {
      ...baseEvent,
      stormMode: true,
    }),
    true,
  );
  assert.equal(
    evaluateConditions(wf({ triggerType: inst.triggerType, triggerConfig: inst.triggerConfig }), {
      ...baseEvent,
      stormMode: false,
    }),
    false,
  );
});

test("booking_succeeded requires booked completion", () => {
  const inst = instantiateWorkflowTemplate("jobber-job-write");
  assert.equal(
    evaluateConditions(wf({ triggerType: inst.triggerType, triggerConfig: inst.triggerConfig }), {
      ...baseEvent,
      type: "booking_succeeded",
      completion: "booked",
    }),
    true,
  );
  assert.equal(
    evaluateConditions(wf({ triggerType: inst.triggerType, triggerConfig: inst.triggerConfig }), {
      ...baseEvent,
      completion: "tasked",
    }),
    false,
  );
});

test("VIP membership match uses playbook names on the event", () => {
  const inst = instantiateWorkflowTemplate("vip-membership-priority-route");
  assert.equal(
    evaluateConditions(wf({ triggerType: inst.triggerType, triggerConfig: inst.triggerConfig }), {
      ...baseEvent,
      transcript: "I am on the Comfort Club plan",
      membershipNames: ["Comfort Club"],
    }),
    true,
  );
});

test("qaLooksRisky flags low score and lawsuit language", () => {
  assert.equal(qaLooksRisky({ score: 40 }), true);
  assert.equal(qaLooksRisky({ score: 95, transcript: "I will sue you" }), true);
  assert.equal(qaLooksRisky({ score: 95, transcript: "thanks, see you Tuesday" }), false);
});

test("dry run reports match + rendered steps for night desk template", async () => {
  const inst = instantiateWorkflowTemplate("night-desk-capture-book");
  const result = await dryRunPipeline(
    wf({
      name: inst.name,
      triggerType: inst.triggerType,
      triggerConfig: inst.triggerConfig,
      steps: inst.steps,
      enabled: true,
    }),
    baseEvent,
  );
  assert.equal(result.matched, true);
  assert.equal(result.enabled, true);
  assert.equal(result.steps.length, 3);
  assert.equal(result.steps[0].type, "ai_extract");
  assert.equal(result.steps[2].type, "book_calendar");
});

test("missed-call template matches short abandoned calls", () => {
  const inst = instantiateWorkflowTemplate("missed-call-callback-sms");
  assert.equal(
    evaluateConditions(wf({ triggerType: inst.triggerType, triggerConfig: inst.triggerConfig }), {
      ...baseEvent,
      durationMs: 4000,
      turns: [{ role: "assistant", content: "Hello?" }],
      lead: {},
    }),
    true,
  );
});
