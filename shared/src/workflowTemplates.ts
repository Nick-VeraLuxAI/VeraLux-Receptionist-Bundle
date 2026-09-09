/**
 * VeraLux workflow template catalog.
 * Admin `/admin/workflows` gallery + control-plane seed/instantiate share this list.
 */

export const WORKFLOW_TRIGGER_TYPES = [
  "call_ended",
  "after_hours_call",
  "keyword_detected",
  "missed_call",
  "scheduled",
  "booking_succeeded",
  "qa_flagged",
  "job_completed",
] as const;
export type WorkflowTriggerType = (typeof WORKFLOW_TRIGGER_TYPES)[number];

export const WORKFLOW_ACTION_TYPES = [
  "send_email",
  "send_sms",
  "fire_webhook",
  "ai_summarize",
  "ai_extract",
  "store_lead",
  "book_calendar",
  "page_on_call",
  "send_digest",
  "create_approval",
  "write_fsm_job",
  "escalate_orphan",
  "hold_booking",
  "estimate_followup",
  "noshow_alert",
] as const;
export type WorkflowActionType = (typeof WORKFLOW_ACTION_TYPES)[number];

export const WORKFLOW_TEMPLATE_IDS = [
  "night-desk-capture-book",
  "hot-lead-emergency-alert",
  "morning-digest",
  "missed-call-callback-sms",
  "jobber-job-write",
  "oncall-page-orphan-escalate",
  "estimate-followup-sms",
  "out-of-area-refuse-log",
  "booked-noshow-owner-alert",
  "post-job-review-ask",
  "storm-surge-hold",
  "qa-flag-to-inbox",
  "call-summary-email",
  "generic-outbound-webhook",
  "housecall-pro-job-write",
  "vip-membership-priority-route",
] as const;
export type WorkflowTemplateId = (typeof WORKFLOW_TEMPLATE_IDS)[number];

export type WorkflowTemplateConfigFieldType =
  | "text"
  | "textarea"
  | "url"
  | "email"
  | "phone"
  | "number"
  | "boolean"
  | "keywords";

export type WorkflowTemplateConfigField = {
  key: string;
  label: string;
  type: WorkflowTemplateConfigFieldType;
  /** Dot path from instantiate root, e.g. steps.2.config.url or triggerConfig.keywords */
  path: string;
  required?: boolean;
  placeholder?: string;
  hint?: string;
  defaultValue?: string | number | boolean | string[];
};

export type WorkflowTemplateStep = {
  action: WorkflowActionType;
  config: Record<string, unknown>;
  order: number;
};

export type WorkflowTemplateWhen = {
  completions?: string[];
  reasons?: string[];
  stormMode?: boolean;
  incompleteCapture?: boolean;
  quoteHeld?: boolean;
  membershipMatch?: boolean;
  qaRisk?: boolean;
  requireKeywords?: boolean;
};

export type WorkflowTemplateTrigger = {
  type: WorkflowTriggerType;
  config: {
    keywords?: string[];
    cronExpression?: string;
    businessHoursStart?: string;
    businessHoursEnd?: string;
    timezone?: string;
    maxDurationSeconds?: number;
    minTurns?: number;
    when?: WorkflowTemplateWhen;
    delayHours?: number;
  };
};

export type WorkflowTemplate = {
  id: WorkflowTemplateId;
  name: string;
  description: string;
  defaultEnabled: boolean;
  trigger: WorkflowTemplateTrigger;
  steps: WorkflowTemplateStep[];
  configFields: WorkflowTemplateConfigField[];
};

export const DEMO_SHOP_LEGACY_WORKFLOW_NAME =
  "Demo Shop — store lead + book calendar on call end";

const HOT_KEYWORDS = [
  "emergency",
  "gas leak",
  "smell gas",
  "flooding",
  "burst pipe",
  "no heat",
  "carbon monoxide",
  "quote hold",
  "urgent",
  "dispatch now",
];

const DEFAULT_EXTRACT_FIELDS = [
  "name",
  "phone",
  "email",
  "issue",
  "address",
  "jobType",
  "startIso",
  "category",
  "priority",
];

export const WORKFLOW_TEMPLATES: WorkflowTemplate[] = [
  {
    id: "night-desk-capture-book",
    name: "Night desk capture & book",
    description:
      "When a call ends, AI-extract structured fields, store the lead, and book the calendar (or hold) via book-helper/webhook.",
    defaultEnabled: true,
    trigger: { type: "call_ended", config: {} },
    steps: [
      {
        action: "ai_extract",
        order: 0,
        config: { fields: DEFAULT_EXTRACT_FIELDS },
      },
      {
        action: "store_lead",
        order: 1,
        config: { fromStep: 0, tag: "night_desk", upsert: true },
      },
      {
        action: "book_calendar",
        order: 2,
        config: {
          url: "",
          includeTranscript: true,
          includeStepOutputs: true,
          holdOnly: false,
        },
      },
    ],
    configFields: [
      {
        key: "bookHelperUrl",
        label: "Book-helper webhook URL",
        type: "url",
        path: "steps.2.config.url",
        placeholder: "http://demo-shop-book-helper:8791/book",
        hint: "Leave blank to use BOOK_HELPER_URL / the Demo Shop helper.",
      },
      {
        key: "holdOnly",
        label: "Hold instead of booking",
        type: "boolean",
        path: "steps.2.config.holdOnly",
        defaultValue: false,
      },
    ],
  },
  {
    id: "hot-lead-emergency-alert",
    name: "Hot lead & emergency alert",
    description:
      "When a call ends (or mid-call escalate) and emergency keywords / quote-hold / hot intent fire, SMS/email the owner and trigger on-call page.",
    defaultEnabled: true,
    trigger: {
      type: "keyword_detected",
      config: { keywords: [...HOT_KEYWORDS] },
    },
    steps: [
      {
        action: "send_sms",
        order: 0,
        config: {
          to: "owner",
          message:
            "VeraLux hot lead: {{caller}} — {{transcript}}",
          template:
            "VeraLux hot lead: {{caller}} — {{transcript}}",
        },
      },
      {
        action: "send_email",
        order: 1,
        config: {
          to: "owner",
          subject: "Hot lead / emergency — {{caller}}",
          body: "A hot or emergency call just ended.\n\nCaller: {{caller}}\nCall: {{callId}}\n\n{{transcript}}",
          template: "A hot or emergency call just ended.",
        },
      },
      { action: "page_on_call", order: 2, config: { reason: "hot_lead" } },
    ],
    configFields: [
      {
        key: "keywords",
        label: "Hot / emergency keywords",
        type: "keywords",
        path: "triggerConfig.keywords",
        hint: "Comma-separated. Matched against the transcript.",
      },
    ],
  },
  {
    id: "morning-digest",
    name: "Morning digest",
    description:
      "Every day at 7am local, send SMS/email digest of overnight calls, leads, books, refuses, and orphan count.",
    defaultEnabled: true,
    trigger: {
      type: "scheduled",
      config: {
        cronExpression: "0 7 * * *",
        timezone: "America/Los_Angeles",
      },
    },
    steps: [{ action: "send_digest", order: 0, config: { force: false } }],
    configFields: [
      {
        key: "timezone",
        label: "Timezone",
        type: "text",
        path: "triggerConfig.timezone",
        defaultValue: "America/Los_Angeles",
        placeholder: "America/Los_Angeles",
      },
      {
        key: "cronExpression",
        label: "Schedule (cron)",
        type: "text",
        path: "triggerConfig.cronExpression",
        defaultValue: "0 7 * * *",
        hint: "Minute hour day month weekday in the timezone above. Default 7:00 local.",
      },
    ],
  },
  {
    id: "missed-call-callback-sms",
    name: "Missed-call callback SMS",
    description:
      "When a call ends abandoned/incomplete (no name+contact or mid-capture hangup), SMS the caller a callback link/message and create/update a lead.",
    defaultEnabled: true,
    trigger: {
      type: "missed_call",
      config: {
        maxDurationSeconds: 15,
        minTurns: 2,
        when: { incompleteCapture: true },
      },
    },
    steps: [
      {
        action: "send_sms",
        order: 0,
        config: {
          to: "caller",
          message:
            "Sorry we missed you. Reply to this text or call us back and we will pick up where you left off.",
          template:
            "Sorry we missed you. Reply to this text or call us back and we will pick up where you left off.",
        },
      },
      {
        action: "store_lead",
        order: 1,
        config: {
          category: "missed_callback",
          tag: "missed_callback",
          upsert: true,
          priority: "normal",
        },
      },
    ],
    configFields: [
      {
        key: "callbackMessage",
        label: "Callback SMS",
        type: "textarea",
        path: "steps.0.config.message",
        hint: "Sent to the caller. Use {{caller}} if needed.",
      },
    ],
  },
  {
    id: "jobber-job-write",
    name: "Jobber job write",
    description:
      "After a successful book, create/update a Jobber job (or request) on the connected Jobber account with caller, address, notes, and slot.",
    defaultEnabled: false,
    trigger: { type: "booking_succeeded", config: {} },
    steps: [
      {
        action: "write_fsm_job",
        order: 0,
        config: { provider: "jobber" },
      },
    ],
    configFields: [],
  },
  {
    id: "oncall-page-orphan-escalate",
    name: "On-call page & orphan escalate",
    description:
      "After-hours emergency → page on-call rotation; if no ACK before page timeout, escalate to overflow and mark orphan for digest/metrics.",
    defaultEnabled: false,
    trigger: {
      type: "after_hours_call",
      config: {
        keywords: [...HOT_KEYWORDS],
        when: { requireKeywords: true },
      },
    },
    steps: [
      { action: "page_on_call", order: 0, config: { reason: "after_hours_emergency" } },
      { action: "escalate_orphan", order: 1, config: {} },
    ],
    configFields: [
      {
        key: "keywords",
        label: "Emergency keywords",
        type: "keywords",
        path: "triggerConfig.keywords",
      },
    ],
  },
  {
    id: "estimate-followup-sms",
    name: "Estimate follow-up SMS",
    description:
      "If an estimate/quote was discussed or held and no owner reply/book in 24h, send a polite follow-up SMS to the caller (or alert owner).",
    defaultEnabled: false,
    trigger: {
      type: "scheduled",
      config: {
        cronExpression: "20 * * * *",
        timezone: "America/Los_Angeles",
        delayHours: 24,
        when: { quoteHeld: true },
      },
    },
    steps: [
      {
        action: "estimate_followup",
        order: 0,
        config: {
          delayHours: 24,
          to: "caller",
          ownerFallback: true,
          message:
            "Hi {{name}}, just checking in on the estimate we discussed. Reply here or call us back when you are ready.",
        },
      },
    ],
    configFields: [
      {
        key: "followupMessage",
        label: "Follow-up SMS",
        type: "textarea",
        path: "steps.0.config.message",
      },
      {
        key: "delayHours",
        label: "Wait hours",
        type: "number",
        path: "steps.0.config.delayHours",
        defaultValue: 24,
      },
    ],
  },
  {
    id: "out-of-area-refuse-log",
    name: "Out-of-area refuse log",
    description:
      "When shop rules refuse for out-of-area, log lead as out-of-area and optionally SMS caller that service isn’t available in their area.",
    defaultEnabled: false,
    trigger: {
      type: "call_ended",
      config: {
        when: { completions: ["refused"], reasons: ["out_of_area"] },
      },
    },
    steps: [
      {
        action: "store_lead",
        order: 0,
        config: {
          category: "out_of_area",
          tag: "out_of_area",
          upsert: true,
          priority: "low",
        },
      },
      {
        action: "send_sms",
        order: 1,
        config: {
          to: "caller",
          message:
            "Thanks for calling. We don’t currently service your area, so we logged your request and won’t dispatch a tech.",
          template:
            "Thanks for calling. We don’t currently service your area, so we logged your request and won’t dispatch a tech.",
        },
      },
    ],
    configFields: [
      {
        key: "refuseMessage",
        label: "Caller SMS (optional)",
        type: "textarea",
        path: "steps.1.config.message",
      },
    ],
  },
  {
    id: "booked-noshow-owner-alert",
    name: "Booked no-show owner alert",
    description:
      "When a booked appointment window passes without check-in/completion signal, alert the owner (SMS/email) to follow up.",
    defaultEnabled: false,
    trigger: {
      type: "scheduled",
      config: {
        cronExpression: "35 * * * *",
        timezone: "America/Los_Angeles",
      },
    },
    steps: [
      {
        action: "noshow_alert",
        order: 0,
        config: {
          windowHours: 2,
          to: "owner",
        },
      },
    ],
    configFields: [
      {
        key: "windowHours",
        label: "Appointment window (hours)",
        type: "number",
        path: "steps.0.config.windowHours",
        defaultValue: 2,
      },
    ],
  },
  {
    id: "post-job-review-ask",
    name: "Post-job review ask",
    description:
      "When a job is marked complete (Jobber/HCP webhook or manual), SMS the customer a review/request link.",
    defaultEnabled: false,
    trigger: { type: "job_completed", config: {} },
    steps: [
      {
        action: "send_sms",
        order: 0,
        config: {
          to: "caller",
          message:
            "Thanks for trusting us with the job. If you have a minute, a quick review helps a lot: {{reviewUrl}}",
          template:
            "Thanks for trusting us with the job. If you have a minute, a quick review helps a lot: {{reviewUrl}}",
        },
      },
    ],
    configFields: [
      {
        key: "reviewUrl",
        label: "Review link",
        type: "url",
        path: "steps.0.config.reviewUrl",
        placeholder: "https://g.page/r/…",
        required: true,
      },
    ],
  },
  {
    id: "storm-surge-hold",
    name: "Storm / surge hold",
    description:
      "When storm/surge mode is ON, on call end (or booking attempt) hold new books, store lead as callback queue, and SMS caller they’ll be contacted.",
    defaultEnabled: false,
    trigger: {
      type: "call_ended",
      config: { when: { stormMode: true } },
    },
    steps: [
      { action: "hold_booking", order: 0, config: { reason: "storm_mode" } },
      {
        action: "store_lead",
        order: 1,
        config: {
          category: "surge_callback",
          tag: "surge_callback",
          upsert: true,
          priority: "high",
        },
      },
      {
        action: "send_sms",
        order: 2,
        config: {
          to: "caller",
          message:
            "We have your request. Due to storm / surge volume we are holding new bookings and will call you back to schedule.",
          template:
            "We have your request. Due to storm / surge volume we are holding new bookings and will call you back to schedule.",
        },
      },
    ],
    configFields: [
      {
        key: "surgeMessage",
        label: "Caller SMS",
        type: "textarea",
        path: "steps.2.config.message",
      },
    ],
  },
  {
    id: "qa-flag-to-inbox",
    name: "QA flag to Inbox",
    description:
      "When Call QA detects low confidence, anger, compliance risk, or escalation phrases, create an Approvals/Inbox item for staff/owner review.",
    defaultEnabled: false,
    trigger: {
      type: "qa_flagged",
      config: { when: { qaRisk: true } },
    },
    steps: [
      {
        action: "create_approval",
        order: 0,
        config: {
          summary: "QA flagged call {{callId}} for review",
        },
      },
    ],
    configFields: [],
  },
  {
    id: "call-summary-email",
    name: "Call summary email",
    description:
      "When a call ends, email the owner a short AI summary (opt-in per tenant).",
    defaultEnabled: false,
    trigger: { type: "call_ended", config: {} },
    steps: [
      { action: "ai_summarize", order: 0, config: { maxTokens: 400 } },
      {
        action: "send_email",
        order: 1,
        config: {
          to: "owner",
          subject: "Call summary — {{caller}}",
          body: "{{step.0.summary}}",
          template: "{{step.0.summary}}",
        },
      },
    ],
    configFields: [
      {
        key: "ownerEmail",
        label: "Owner email override",
        type: "email",
        path: "steps.1.config.to",
        hint: "Leave as owner to use the night-desk digest address.",
        defaultValue: "owner",
      },
    ],
  },
  {
    id: "generic-outbound-webhook",
    name: "Generic outbound webhook",
    description:
      "When a call ends, POST JSON payload to a tenant-configured webhook (Zapier/Make/custom).",
    defaultEnabled: false,
    trigger: { type: "call_ended", config: {} },
    steps: [
      {
        action: "fire_webhook",
        order: 0,
        config: {
          url: "",
          includeTranscript: true,
          includeStepOutputs: true,
        },
      },
    ],
    configFields: [
      {
        key: "webhookUrl",
        label: "Webhook URL",
        type: "url",
        path: "steps.0.config.url",
        required: true,
        placeholder: "https://hooks.zapier.com/…",
      },
      {
        key: "webhookSecret",
        label: "HMAC secret",
        type: "text",
        path: "steps.0.config.secret",
        hint: "Optional. Sent as X-Veralux-Signature.",
      },
    ],
  },
  {
    id: "housecall-pro-job-write",
    name: "Housecall Pro job write",
    description:
      "After a successful book, create a Housecall Pro job/lead using the tenant’s connected API key or partner OAuth.",
    defaultEnabled: false,
    trigger: { type: "booking_succeeded", config: {} },
    steps: [
      {
        action: "write_fsm_job",
        order: 0,
        config: { provider: "housecall_pro" },
      },
    ],
    configFields: [],
  },
  {
    id: "vip-membership-priority-route",
    name: "VIP / membership priority route",
    description:
      "When AI extract matches a membership/VIP name, tag the lead priority and route to the configured priority transfer line / notify owner immediately.",
    defaultEnabled: false,
    trigger: {
      type: "keyword_detected",
      config: { keywords: [], when: { membershipMatch: true } },
    },
    steps: [
      {
        action: "store_lead",
        order: 0,
        config: {
          category: "vip",
          tag: "vip",
          priority: "high",
          upsert: true,
        },
      },
      {
        action: "send_sms",
        order: 1,
        config: {
          to: "owner",
          message:
            "VIP / membership caller {{caller}} is on the line or just hung up. Priority follow-up.",
          template:
            "VIP / membership caller {{caller}} is on the line or just hung up. Priority follow-up.",
        },
      },
    ],
    configFields: [
      {
        key: "membershipNames",
        label: "Membership / VIP names",
        type: "keywords",
        path: "triggerConfig.keywords",
        hint: "Leave blank to use shop-playbook membership names.",
      },
    ],
  },
];

export const DEFAULT_ON_TEMPLATE_IDS = WORKFLOW_TEMPLATES.filter((t) => t.defaultEnabled).map(
  (t) => t.id,
);

export function getWorkflowTemplate(id: string): WorkflowTemplate | undefined {
  return WORKFLOW_TEMPLATES.find((t) => t.id === id);
}

export function isWorkflowTemplateId(id: string): id is WorkflowTemplateId {
  return (WORKFLOW_TEMPLATE_IDS as readonly string[]).includes(id);
}

export function isDemoShopLegacyWorkflowName(name: string): boolean {
  const n = String(name || "").trim().toLowerCase();
  if (!n) return false;
  if (n === DEMO_SHOP_LEGACY_WORKFLOW_NAME.toLowerCase()) return true;
  return n.includes("demo shop") && (n.includes("store lead") || n.includes("book calendar"));
}

export type InstantiatedWorkflow = {
  name: string;
  enabled: boolean;
  triggerType: WorkflowTriggerType;
  triggerConfig: WorkflowTemplateTrigger["config"];
  steps: WorkflowTemplateStep[];
  templateId: WorkflowTemplateId;
  adminLocked: boolean;
};

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function setByPath(root: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split(".").filter(Boolean);
  if (!parts.length) return;
  let cursor: Record<string, unknown> | unknown[] = root;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const key = parts[i];
    const nextIsIndex = /^\d+$/.test(parts[i + 1] || "");
    const asIndex = /^\d+$/.test(key);
    if (Array.isArray(cursor)) {
      const idx = Number(key);
      if (cursor[idx] == null) cursor[idx] = nextIsIndex ? [] : {};
      cursor = cursor[idx] as Record<string, unknown> | unknown[];
    } else {
      if (cursor[key] == null) cursor[key] = asIndex || nextIsIndex ? [] : {};
      cursor = cursor[key] as Record<string, unknown> | unknown[];
    }
  }
  const last = parts[parts.length - 1];
  if (Array.isArray(cursor) && /^\d+$/.test(last)) {
    cursor[Number(last)] = value;
  } else if (!Array.isArray(cursor)) {
    cursor[last] = value;
  }
}

export function coerceTemplateFieldValue(
  field: WorkflowTemplateConfigField,
  raw: unknown,
): unknown {
  if (raw == null) return field.defaultValue;
  if (field.type === "boolean") {
    if (typeof raw === "boolean") return raw;
    const s = String(raw).trim().toLowerCase();
    return s === "1" || s === "true" || s === "yes" || s === "on";
  }
  if (field.type === "number") {
    const n = Number(raw);
    return Number.isFinite(n) ? n : field.defaultValue;
  }
  if (field.type === "keywords") {
    if (Array.isArray(raw)) {
      return raw.map((v) => String(v).trim()).filter(Boolean);
    }
    return String(raw)
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean);
  }
  return String(raw);
}

export function applyTemplateConfig(
  template: WorkflowTemplate,
  config: Record<string, unknown> = {},
): { triggerConfig: WorkflowTemplateTrigger["config"]; steps: WorkflowTemplateStep[] } {
  const triggerConfig = cloneJson(template.trigger.config);
  const steps = cloneJson(template.steps);
  const root: Record<string, unknown> = { triggerConfig, steps };
  for (const field of template.configFields) {
    if (!(field.key in config) && field.defaultValue === undefined) continue;
    const value = coerceTemplateFieldValue(
      field,
      field.key in config ? config[field.key] : field.defaultValue,
    );
    setByPath(root, field.path, value);
    if (field.path.endsWith(".config.message")) {
      setByPath(root, field.path.replace(/\.message$/, ".template"), value);
    }
  }
  return {
    triggerConfig: root.triggerConfig as WorkflowTemplateTrigger["config"],
    steps: root.steps as WorkflowTemplateStep[],
  };
}

export function instantiateWorkflowTemplate(
  id: string,
  options: {
    enabled?: boolean;
    config?: Record<string, unknown>;
    adminLocked?: boolean;
  } = {},
): InstantiatedWorkflow {
  const template = getWorkflowTemplate(id);
  if (!template) {
    throw new Error(`unknown_workflow_template:${id}`);
  }
  const applied = applyTemplateConfig(template, options.config || {});
  return {
    name: template.name,
    enabled: options.enabled ?? template.defaultEnabled,
    triggerType: template.trigger.type,
    triggerConfig: applied.triggerConfig,
    steps: applied.steps,
    templateId: template.id,
    adminLocked: options.adminLocked ?? true,
  };
}

export function listWorkflowTemplatesForGallery(): Array<
  WorkflowTemplate & { category: "default" | "gallery" }
> {
  return WORKFLOW_TEMPLATES.map((t) => ({
    ...t,
    category: t.defaultEnabled ? "default" : "gallery",
  }));
}
