#!/usr/bin/env node
/**
 * Idempotent: create/update Postgres tenant `veralux` + tenant_configs for VeraLux company dogfood.
 * Run with DATABASE_URL set (see control-plane `.env`).
 *
 *   cd control-plane && node scripts/seed-veralux-internal-tenant.cjs
 *
 * Does not set OpenAI or webhook secrets. Restart control-plane after run so tenants/config reload.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { Client } = require("pg");

require("dotenv").config({
  path: path.join(__dirname, "..", ".env"),
});

const TENANT_ID = "veralux";
const BUSINESS_NAME = "VeraLux AI";

function mergeDeep(a, b) {
  if (b == null) return a;
  if (a == null || typeof a !== "object" || Array.isArray(a)) return b;
  if (typeof b !== "object" || Array.isArray(b)) return b;
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) {
    if (
      v &&
      typeof v === "object" &&
      !Array.isArray(v) &&
      out[k] &&
      typeof out[k] === "object" &&
      !Array.isArray(out[k])
    ) {
      out[k] = mergeDeep(out[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

function loadFallbackFromSeedJson() {
  const p = path.join(__dirname, "..", "..", "scripts", "seed-default-runtime-config.json");
  const raw = fs.readFileSync(p, "utf8");
  const j = JSON.parse(raw);
  return {
    config: { provider: "openai", openaiModel: "gpt-4o-mini" },
    prompts: j.llmContext?.prompts || {
      systemPreamble: "",
      schemaHint: "",
      policyPrompt: "",
      voicePrompt: "",
    },
    stt: j.stt || {
      mode: "whisper_http",
      whisperUrl: "http://127.0.0.1:9000/transcribe",
      chunkMs: 100,
      language: "en",
    },
    tts: j.tts || {
      mode: "chatterbox_http",
      chatterboxUrl: "http://127.0.0.1:7005",
      chatterboxVariant: "turbo",
    },
    forwarding_profiles:
      j.llmContext?.forwardingProfiles ||
      j.llmContext?.forwarding_profiles ||
      [],
    pricing: j.llmContext?.pricing || { items: [], notes: "" },
  };
}

const PROMPTS_PATCH = {
  systemPreamble: `You are the AI phone receptionist for ${BUSINESS_NAME}. Answer calls professionally, explain VeraLux AI services, qualify leads, collect contact details, and route urgent matters. Keep replies short for real-time voice.`,
  schemaHint: "",
  policyPrompt:
    "Do not share secrets or customer confidential data. If unsure, take a message. Collect name, phone, email, company, and reason for call when the caller wants follow-up.",
  voicePrompt:
    "Sound premium, clear, and professional—warm but efficient. Short sentences for phone conversation.",
  greetingText: `Thanks for calling ${BUSINESS_NAME}. How can I help you today?`,
};

const BUSINESS_HOURS_PLACEHOLDER = {
  timezone: "America/Los_Angeles",
  weekly: {
    mon: { open: "09:00", close: "17:00" },
    tue: { open: "09:00", close: "17:00" },
    wed: { open: "09:00", close: "17:00" },
    thu: { open: "09:00", close: "17:00" },
    fri: { open: "09:00", close: "17:00" },
    sat: { closed: true },
    sun: { closed: true },
  },
  afterHoursMessage:
    "Thanks for calling VeraLux AI. We’re outside configured business hours. Please leave your name, phone, email, company, and reason for calling—we’ll follow up.",
};

const FORWARDING_PLACEHOLDER = [
  {
    id: "veralux-handoff-placeholder",
    name: "Operator / on-call (configure)",
    number: "",
    role: "Replace with a real E.164 or forwarding target in operator admin when ready.",
  },
];

const OPERATOR_STATE_PLACEHOLDER = {
  handoffNote:
    "Placeholder: set PSTN/SIP/Telnyx forwarding targets and real business hours when operators finalize routing.",
};

async function main() {
  const connectionString =
    process.env.DATABASE_URL || "postgres://veralux:veralux@localhost:5432/veralux";
  const client = new Client({ connectionString });
  await client.connect();

  try {
    const now = Date.now();
    await client.query(
      `
      insert into tenants (id, name, created_at, updated_at)
      values ($1, $2, to_timestamp($3/1000.0), to_timestamp($4/1000.0))
      on conflict (id) do update set name = excluded.name, updated_at = excluded.updated_at
    `,
      [TENANT_ID, BUSINESS_NAME, now, now],
    );

    const cfgRes = await client.query(
      `select tenant_id, config, prompts, stt, tts, forwarding_profiles, pricing, business_hours, operator_state
       from tenant_configs where tenant_id = any($1::text[])`,
      [[TENANT_ID, "default"]],
    );
    const byId = new Map(cfgRes.rows.map((r) => [r.tenant_id, r]));
    const existingV = byId.get(TENANT_ID);
    const defaultRow = byId.get("default");
    const fb = loadFallbackFromSeedJson();

    const base = existingV
      ? {
          config: existingV.config || fb.config,
          prompts: existingV.prompts || fb.prompts,
          stt: existingV.stt || fb.stt,
          tts: existingV.tts || fb.tts,
          forwarding_profiles: existingV.forwarding_profiles || fb.forwarding_profiles,
          pricing: existingV.pricing || fb.pricing,
          business_hours: existingV.business_hours || {},
          operator_state: existingV.operator_state || {},
        }
      : defaultRow
        ? {
            config: defaultRow.config || fb.config,
            prompts: defaultRow.prompts || fb.prompts,
            stt: defaultRow.stt || fb.stt,
            tts: defaultRow.tts || fb.tts,
            forwarding_profiles: defaultRow.forwarding_profiles || fb.forwarding_profiles,
            pricing: defaultRow.pricing || fb.pricing,
            business_hours: defaultRow.business_hours || {},
            operator_state: defaultRow.operator_state || {},
          }
        : fb;

    const fpBase = Array.isArray(base.forwarding_profiles) ? base.forwarding_profiles : [];
    const forwarding_profiles =
      fpBase.length > 0 ? fpBase : FORWARDING_PLACEHOLDER;

    const merged = {
      config: base.config,
      prompts: mergeDeep(
        typeof base.prompts === "object" && base.prompts ? base.prompts : {},
        PROMPTS_PATCH,
      ),
      stt: base.stt,
      tts: base.tts,
      forwarding_profiles,
      pricing: base.pricing,
      business_hours: mergeDeep(
        typeof base.business_hours === "object" && base.business_hours ? base.business_hours : {},
        BUSINESS_HOURS_PLACEHOLDER,
      ),
      operator_state: mergeDeep(
        typeof base.operator_state === "object" && base.operator_state ? base.operator_state : {},
        OPERATOR_STATE_PLACEHOLDER,
      ),
    };

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
        TENANT_ID,
        merged.config,
        merged.prompts,
        merged.stt,
        merged.tts,
        merged.forwarding_profiles,
        merged.pricing,
        JSON.stringify(merged.business_hours),
        JSON.stringify(merged.operator_state),
      ],
    );

    console.log(`[seed-veralux-receptionist] Upserted tenant + tenant_configs id=${TENANT_ID}`);
    console.log(
      "[seed-veralux-receptionist] Configure DIDs and secrets in operator admin; restart control-plane to publish.",
    );
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
