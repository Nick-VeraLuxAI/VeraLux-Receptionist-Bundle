import {
  isCallOutcome,
  isStage,
  normalizeActions,
  type CallOutcome,
  type Lead,
  type ReceptionistAction,
  type Stage,
} from "./runTypes";
import { extractFirstJsonObject, stripMarkdownJsonFence } from "./utils/jsonObjectExtract";

const MAX_REPLY_CHARS = 8000;
const MAX_LEAD_FIELD_CHARS = 4000;

const ALLOWED_LEAD_KEYS = [
  "name",
  "email",
  "phone",
  "company",
  "address",
  "preferredDate",
  "preferredTimeWindow",
  "serviceType",
  "notes",
] as const;

type AllowedLeadKey = (typeof ALLOWED_LEAD_KEYS)[number];

function sanitizeLeadUpdates(raw: unknown): Partial<Lead> | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }
  const o = raw as Record<string, unknown>;
  const cleaned: Partial<Lead> = {};
  for (const key of ALLOWED_LEAD_KEYS) {
    const v = o[key as string];
    if (typeof v !== "string") {
      continue;
    }
    const t = v.trim();
    if (!t.length) {
      continue;
    }
    (cleaned as Record<AllowedLeadKey, string>)[key] =
      t.length > MAX_LEAD_FIELD_CHARS ? t.slice(0, MAX_LEAD_FIELD_CHARS) : t;
  }
  return Object.keys(cleaned).length > 0 ? cleaned : undefined;
}

export type ParsedReceptionistLlm = {
  replyText?: string;
  actions?: ReceptionistAction[];
  stage?: Stage;
  leadUpdates?: Partial<Lead>;
  outcome?: CallOutcome;
};

/**
 * Parse receptionist LLM output: markdown fences, balanced JSON, Zod validation for lead updates.
 */
export function parseReceptionistLlmOutput(rawText: string): ParsedReceptionistLlm {
  const unfenced = stripMarkdownJsonFence(rawText);
  const segment = extractFirstJsonObject(unfenced) ?? extractFirstJsonObject(rawText);
  if (!segment) {
    return {};
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(segment);
  } catch {
    return {};
  }

  if (!parsed || typeof parsed !== "object") {
    return {};
  }

  const o = parsed as Record<string, unknown>;
  const result: ParsedReceptionistLlm = {};

  if (typeof o.replyText === "string") {
    const t = o.replyText.trim();
    if (t.length > 0) {
      result.replyText = t.length > MAX_REPLY_CHARS ? t.slice(0, MAX_REPLY_CHARS) : t;
    }
  }

  result.actions = normalizeActions(o.actions);

  if (typeof o.stage === "string" && isStage(o.stage)) {
    result.stage = o.stage;
  }

  const leadUpdates = sanitizeLeadUpdates(o.leadUpdates);
  if (leadUpdates) {
    result.leadUpdates = leadUpdates;
  }

  if (typeof o.outcome === "string" && isCallOutcome(o.outcome)) {
    result.outcome = o.outcome;
  }

  return result;
}
