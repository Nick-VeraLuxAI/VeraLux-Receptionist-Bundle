/** Versioned shop law the model cannot override. */

import { z } from "zod";

export const CALL_COMPLETIONS = [
  "booked",
  "approval_held",
  "on_call_paged",
  "tasked",
  "refused",
] as const;
export type CallCompletion = (typeof CALL_COMPLETIONS)[number];

export const SHOP_DECISIONS = ["allow", "refuse", "hold", "escalate"] as const;
export type ShopDecision = (typeof SHOP_DECISIONS)[number];

export const SHOP_VERTICALS = ["general", "plumbing", "hvac", "garage", "restoration"] as const;
export type ShopVertical = (typeof SHOP_VERTICALS)[number];

export const DEFAULT_EMERGENCY_KEYWORDS = [
  "gas leak",
  "smell gas",
  "flooding",
  "no heat",
  "carbon monoxide",
  "sewage backup",
  "sparking",
  "electrical fire",
  "burst pipe",
  "water coming through",
];

const optionalE164 = z
  .string()
  .regex(/^\+[1-9]\d{7,14}$/)
  .optional();

export const shopPlaybookSchema = z.object({
  version: z.number().int().positive(),
  publishedAt: z.string().datetime().optional(),
  vertical: z.enum(SHOP_VERTICALS),
  serviceArea: z.object({
    zips: z.array(z.string().regex(/^\d{5}$/)).max(500),
    cities: z.array(z.string().min(1).max(120)).max(250),
    radiusMiles: z.number().positive().max(500).optional(),
    hubZip: z.string().regex(/^\d{5}$/).optional(),
  }),
  afterHoursFeeCents: z.number().int().nonnegative(),
  refuseServices: z.array(z.string().min(1).max(200)).max(250),
  quoteHoldCents: z.number().int().nonnegative(),
  emergencyKeywords: z.array(z.string().min(1).max(200)).min(1).max(250),
  membershipNames: z.array(z.string().min(1).max(200)).max(100),
  onCallE164: optionalE164,
  onCallTimeoutSecs: z.number().int().min(60).max(90),
  humanOverflowE164: optionalE164,
  digest: z.object({
    smsE164: optionalE164,
    emails: z.array(z.string().email()).max(20),
  }),
  stormMode: z.object({
    enabled: z.boolean(),
    note: z.string().max(1000).optional(),
    parallelAnswerCap: z.number().int().positive().max(100).optional(),
    expiresAt: z.string().datetime().optional(),
  }),
});

export type ShopPlaybook = z.infer<typeof shopPlaybookSchema>;

export const DEFAULT_SHOP_PLAYBOOK: ShopPlaybook = {
  version: 1,
  vertical: "general",
  serviceArea: { zips: [], cities: [] },
  afterHoursFeeCents: 0,
  refuseServices: [],
  quoteHoldCents: 250000,
  emergencyKeywords: [...DEFAULT_EMERGENCY_KEYWORDS],
  membershipNames: [],
  onCallTimeoutSecs: 75,
  digest: { emails: [] },
  stormMode: { enabled: false, parallelAnswerCap: 2 },
};

export type ShopActionInput = {
  intent: "book" | "quote" | "emergency" | "service_issue" | "other";
  zip?: string;
  city?: string;
  distanceMiles?: number;
  quoteCents?: number;
  afterHours?: boolean;
  membership?: string;
  utterance?: string;
  existingOpenJobs?: number;
};

export type ShopEvaluation = {
  decision: ShopDecision;
  reason: string;
  speak: string;
  completion?: CallCompletion;
  appliedAfterHoursFeeCents?: number;
};

const VERTICAL_REFUSE: Record<ShopVertical, string[]> = {
  general: [],
  plumbing: ["new construction only", "well drilling"],
  hvac: ["window ac install"],
  garage: ["residential plumbing"],
  restoration: ["routine cleaning"],
};

const VERTICAL_EMERGENCY: Record<ShopVertical, string[]> = {
  general: [],
  plumbing: ["burst pipe", "no water", "sewage"],
  hvac: ["no heat", "no cooling during heat advisory", "furnace fire"],
  garage: ["door off track", "crushed"],
  restoration: ["storm damage", "fire", "mold"],
};

export function applyVerticalOverlay(playbook: ShopPlaybook): ShopPlaybook {
  const extraRefuse = VERTICAL_REFUSE[playbook.vertical] || [];
  const extraEm = VERTICAL_EMERGENCY[playbook.vertical] || [];
  return {
    ...playbook,
    refuseServices: uniqueStrings([...playbook.refuseServices, ...extraRefuse]),
    emergencyKeywords: uniqueStrings([...playbook.emergencyKeywords, ...extraEm]),
  };
}

export function normalizeShopPlaybook(raw?: Partial<ShopPlaybook> | null): ShopPlaybook {
  const d = DEFAULT_SHOP_PLAYBOOK;
  const area = raw?.serviceArea || d.serviceArea;
  const digest = raw?.digest || d.digest;
  const storm = raw?.stormMode || d.stormMode;
  const vertical = SHOP_VERTICALS.includes(raw?.vertical as ShopVertical) ? (raw!.vertical as ShopVertical) : "general";
  return {
    version: Math.max(1, Number(raw?.version) || 1),
    publishedAt: raw?.publishedAt,
    vertical,
    serviceArea: {
      zips: (area.zips || []).map((z) => String(z).replace(/\D/g, "").slice(0, 5)).filter((z) => z.length === 5),
      cities: (area.cities || []).map((c) => String(c).trim().toLowerCase()).filter(Boolean),
      radiusMiles:
        Number.isFinite(Number(area.radiusMiles)) && Number(area.radiusMiles) > 0
          ? Math.min(500, Number(area.radiusMiles))
          : undefined,
      hubZip:
        typeof area.hubZip === "string" && /^\d{5}$/.test(area.hubZip.trim())
          ? area.hubZip.trim()
          : undefined,
    },
    afterHoursFeeCents: Math.max(0, Math.round(Number(raw?.afterHoursFeeCents) || 0)),
    refuseServices: (raw?.refuseServices || []).map((s) => String(s).trim().toLowerCase()).filter(Boolean),
    quoteHoldCents: Math.max(0, Math.round(Number(raw?.quoteHoldCents) || d.quoteHoldCents)),
    emergencyKeywords: (raw?.emergencyKeywords?.length ? raw.emergencyKeywords : d.emergencyKeywords).map((s) =>
      String(s).trim().toLowerCase(),
    ),
    membershipNames: (raw?.membershipNames || []).map((s) => String(s).trim()).filter(Boolean),
    onCallE164: normalizeOptionalE164(raw?.onCallE164),
    onCallTimeoutSecs: Math.min(
      90,
      Math.max(60, Math.round(Number(raw?.onCallTimeoutSecs) || d.onCallTimeoutSecs)),
    ),
    humanOverflowE164: normalizeOptionalE164(raw?.humanOverflowE164),
    digest: {
      smsE164: normalizeOptionalE164(digest.smsE164),
      emails: uniqueStringsPreserveCase(
        (digest.emails || []).map((email) => String(email).trim().toLowerCase()),
      ).filter((email) => z.string().email().safeParse(email).success),
    },
    stormMode: {
      enabled: Boolean(storm.enabled),
      note: storm.note ? String(storm.note).trim().slice(0, 1000) : undefined,
      parallelAnswerCap:
        Number.isFinite(Number(storm.parallelAnswerCap)) &&
        Number(storm.parallelAnswerCap) > 0
          ? Math.min(100, Math.round(Number(storm.parallelAnswerCap)))
          : d.stormMode.parallelAnswerCap,
      expiresAt:
        typeof storm.expiresAt === "string" &&
        z.string().datetime().safeParse(storm.expiresAt).success
          ? storm.expiresAt
          : undefined,
    },
  };
}

/** Backward-compatible Redis/API input; output is always the complete contract. */
export const shopPlaybookRuntimeSchema = shopPlaybookSchema
  .deepPartial()
  .transform((value) => normalizeShopPlaybook(value as Partial<ShopPlaybook>));

export function stormModeActive(
  playbook: ShopPlaybook,
  now = new Date(),
): boolean {
  if (!playbook.stormMode.enabled) return false;
  if (!playbook.stormMode.expiresAt) return true;
  return new Date(playbook.stormMode.expiresAt).getTime() > now.getTime();
}

export function utteranceLooksOverflow(utterance: string | undefined): boolean {
  const u = (utterance || "").toLowerCase();
  return /\b(complaint|manager|attorney|lawyer|property manager|commercial(?: account| building| property)?|speak to a (person|human))\b/.test(u);
}

export function inferShopIntent(utterance: string | undefined): ShopActionInput["intent"] {
  const u = (utterance || "").toLowerCase();
  if (utteranceLooksEmergency(u, DEFAULT_EMERGENCY_KEYWORDS) || /\bemergenc/.test(u)) return "emergency";
  if (utteranceLooksOverflow(u)) return "other";
  if (/\b(open job|already scheduled|membership|warranty)\b/.test(u)) return "service_issue";
  if (/\b(quote|how much|price|estimate)\b/.test(u)) return "quote";
  if (/\b(book|schedule|appointment|come out)\b/.test(u)) return "book";
  return "other";
}

export function extractZip(utterance: string | undefined): string | undefined {
  const m = /\b(\d{5})\b/.exec(utterance || "");
  return m?.[1];
}

export function extractQuoteCents(utterance: string | undefined): number | undefined {
  const text = String(utterance || "");
  const symbol = /\$\s*([\d,]+(?:\.\d{1,2})?)/.exec(text);
  if (symbol) {
    return Math.round(Number(symbol[1].replace(/,/g, "")) * 100);
  }
  const numeric =
    /\b([\d,]+(?:\.\d{1,2})?)\s*(dollars?|bucks?)\b/i.exec(text);
  if (numeric) {
    return Math.round(Number(numeric[1].replace(/,/g, "")) * 100);
  }
  const numericGrand = /\b([\d,]+(?:\.\d+)?)\s+grand\b/i.exec(text);
  if (numericGrand) {
    return Math.round(
      Number(numericGrand[1].replace(/,/g, "")) * 1000 * 100,
    );
  }
  const currencyWord = /\b(dollars?|bucks?|grand)\b/i.exec(text);
  if (!currencyWord || currencyWord.index == null) return undefined;
  const words = text
    .slice(0, currencyWord.index)
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter(Boolean);
  const numberWords = new Set([
    ...Object.keys(SMALL_NUMBER_WORDS),
    ...Object.keys(TENS_NUMBER_WORDS),
    "hundred",
    "thousand",
    "million",
    "and",
  ]);
  const suffix: string[] = [];
  for (let index = words.length - 1; index >= 0; index -= 1) {
    if (!numberWords.has(words[index])) break;
    suffix.unshift(words[index]);
  }
  const amount = parseNumberWords(suffix);
  if (amount == null) return undefined;
  const multiplier = currencyWord[1].toLowerCase() === "grand" ? 1000 : 1;
  return Math.round(amount * multiplier * 100);
}

const SMALL_NUMBER_WORDS: Record<string, number> = {
  zero: 0,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
};

const TENS_NUMBER_WORDS: Record<string, number> = {
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
  sixty: 60,
  seventy: 70,
  eighty: 80,
  ninety: 90,
};

function parseNumberWords(words: string[]): number | null {
  if (!words.length) return null;
  let total = 0;
  let current = 0;
  let sawNumber = false;
  for (const word of words) {
    if (word === "and") continue;
    if (word in SMALL_NUMBER_WORDS) {
      current += SMALL_NUMBER_WORDS[word];
      sawNumber = true;
      continue;
    }
    if (word in TENS_NUMBER_WORDS) {
      current += TENS_NUMBER_WORDS[word];
      sawNumber = true;
      continue;
    }
    if (word === "hundred") {
      current = Math.max(1, current) * 100;
      sawNumber = true;
      continue;
    }
    if (word === "thousand" || word === "million") {
      const scale = word === "thousand" ? 1000 : 1_000_000;
      total += Math.max(1, current) * scale;
      current = 0;
      sawNumber = true;
      continue;
    }
    return null;
  }
  return sawNumber ? total + current : null;
}

export function utteranceLooksEmergency(utterance: string | undefined, keywords: string[]): boolean {
  const u = (utterance || "").toLowerCase();
  if (!u) return false;
  return keywords.some((k) => k && u.includes(k));
}

export function evaluateShopAction(playbookInput: Partial<ShopPlaybook> | null | undefined, input: ShopActionInput): ShopEvaluation {
  const playbook = applyVerticalOverlay(normalizeShopPlaybook(playbookInput));
  const utterance = (input.utterance || "").toLowerCase();
  const emergency =
    input.intent === "emergency" || utteranceLooksEmergency(utterance, playbook.emergencyKeywords);

  if (emergency || (input.existingOpenJobs && input.existingOpenJobs > 0 && input.intent === "service_issue")) {
    return {
      decision: "escalate",
      reason: emergency ? "emergency_keyword" : "open_job_service_issue",
      speak: playbook.onCallE164
        ? "I am paging the on-call technician now. Stay on the line."
        : "I am creating an urgent task for the shop right now.",
      completion: playbook.onCallE164 ? "on_call_paged" : "tasked",
    };
  }

  if (playbook.humanOverflowE164 && utteranceLooksOverflow(utterance)) {
    return {
      decision: "escalate",
      reason: "human_overflow",
      speak: "I am connecting you to the shop now.",
      completion: "on_call_paged",
    };
  }

  if (stormModeActive(playbook) && input.intent === "book") {
    return {
      decision: "hold",
      reason: "storm_mode",
      speak: playbook.stormMode.note || "We are in surge mode. I will hold this for the owner to confirm.",
      completion: "approval_held",
    };
  }

  const zip = (input.zip || "").replace(/\D/g, "").slice(0, 5);
  const city = (input.city || "").trim().toLowerCase();
  const hasZipRules = playbook.serviceArea.zips.length > 0;
  const hasCityRules = playbook.serviceArea.cities.length > 0;
  const hasRadiusRule =
    typeof playbook.serviceArea.radiusMiles === "number" &&
    playbook.serviceArea.radiusMiles > 0;
  if (hasZipRules || hasCityRules || hasRadiusRule) {
    const suppliedChecks: boolean[] = [];
    if (zip && hasZipRules) suppliedChecks.push(playbook.serviceArea.zips.includes(zip));
    if (city && hasCityRules) suppliedChecks.push(playbook.serviceArea.cities.includes(city));
    if (typeof input.distanceMiles === "number" && hasRadiusRule) {
      suppliedChecks.push(input.distanceMiles <= playbook.serviceArea.radiusMiles!);
    }
    if (
      hasRadiusRule &&
      typeof input.distanceMiles !== "number" &&
      suppliedChecks.length === 0 &&
      input.intent === "book"
    ) {
      return {
        decision: "hold",
        reason: "distance_unverified",
        speak:
          "I cannot verify that address is inside our service radius, so I will hold it for owner approval.",
        completion: "approval_held",
      };
    }
    if (
      suppliedChecks.length === 0 &&
      Boolean(zip || city || typeof input.distanceMiles === "number") &&
      input.intent === "book"
    ) {
      return {
        decision: "hold",
        reason: "service_area_unverified",
        speak:
          "I cannot verify that location against the published service area, so I will hold it for owner approval.",
        completion: "approval_held",
      };
    }
    if (suppliedChecks.length > 0 && !suppliedChecks.some(Boolean)) {
      return {
        decision: "refuse",
        reason: "out_of_area",
        speak: "We do not service that area. I will not book this.",
        completion: "refused",
      };
    }
  }

  const refused = playbook.refuseServices.find((s) => s && utterance.includes(s));
  if (refused) {
    return {
      decision: "refuse",
      reason: `we_dont_do:${refused}`,
      speak: `We do not take ${refused} work, so I will not book it.`,
      completion: "refused",
    };
  }

  if (typeof input.quoteCents === "number" && playbook.quoteHoldCents > 0 && input.quoteCents >= playbook.quoteHoldCents) {
    return {
      decision: "hold",
      reason: "quote_hold",
      speak: "That is a large quote. I will hold it for owner approval instead of booking.",
      completion: "approval_held",
    };
  }

  if (input.intent === "book") {
    return {
      decision: "allow",
      reason: "bookable",
      speak: "I can book that under shop rules.",
      completion: "booked",
      appliedAfterHoursFeeCents: input.afterHours
        ? playbook.afterHoursFeeCents
        : 0,
    };
  }

  return {
    decision: "allow",
    reason: "ok",
    speak: "",
    appliedAfterHoursFeeCents: input.afterHours
      ? playbook.afterHoursFeeCents
      : 0,
  };
}

export type ForwardingLike = { id?: string; name: string; number?: string; role?: string };

export function forwardingProfilesToTransferProfiles(
  profiles: ForwardingLike[],
  opts?: { onCallTimeoutSecs?: number },
): Array<{
  id: string;
  name: string;
  holder?: string;
  responsibilities: string[];
  destination: string;
  timeoutSecs: number;
}> {
  const timeout = Math.min(600, Math.max(5, opts?.onCallTimeoutSecs || 75));
  const out: Array<{
    id: string;
    name: string;
    holder?: string;
    responsibilities: string[];
    destination: string;
    timeoutSecs: number;
  }> = [];
  for (const p of profiles || []) {
    const dest = String(p.number || "").trim();
    if (!dest) continue;
    const role = String(p.role || p.name || "staff").toLowerCase();
    const emergency = /emerg|on[- ]?call|after[- ]?hours|dispatch/.test(role);
    const id = slugId(p.id || p.name || dest);
    out.push({
      id: emergency ? (id === "oncall" ? "oncall" : id) : id,
      name: p.name || (emergency ? "On-call" : "Transfer"),
      holder: p.name,
      responsibilities: emergency
        ? ["emergency", "on-call", "after hours", "urgent", role]
        : [role || "general", "transfer"],
      destination: dest,
      timeoutSecs: emergency ? timeout : 45,
    });
  }
  if (!out.some((x) => x.id === "oncall")) {
    const firstEmer = out.find(
      (x) => x.responsibilities.includes("on-call") || x.responsibilities.includes("emergency"),
    );
    if (firstEmer) firstEmer.id = "oncall";
  }
  return out;
}

export function ensureOnCallTransferProfile(
  profiles: ReturnType<typeof forwardingProfilesToTransferProfiles>,
  playbook: ShopPlaybook,
): ReturnType<typeof forwardingProfilesToTransferProfiles> {
  const dest = playbook.onCallE164?.trim();
  if (!dest) return profiles;
  const next = profiles.map((p) =>
    p.id === "oncall" || p.responsibilities.includes("on-call")
      ? { ...p, destination: dest, timeoutSecs: playbook.onCallTimeoutSecs }
      : p,
  );
  if (next.some((p) => p.id === "oncall" || p.responsibilities.includes("on-call"))) return next;
  return [
    {
      id: "oncall",
      name: "On-call",
      responsibilities: ["emergency", "on-call", "after hours", "urgent"],
      destination: dest,
      timeoutSecs: playbook.onCallTimeoutSecs,
    },
    ...next,
  ];
}

export function mergeTransferProfiles(
  fromForwarding: ReturnType<typeof forwardingProfilesToTransferProfiles>,
  existing?: Array<{ id: string; responsibilities?: string[] }>,
): ReturnType<typeof forwardingProfilesToTransferProfiles> {
  const ids = new Set(fromForwarding.map((p) => p.id));
  const keep = (existing || []).filter((profile) => {
    if (ids.has(profile.id)) return false;
    const onCallLike =
      profile.id === "oncall" ||
      profile.responsibilities?.includes("on-call") ||
      profile.responsibilities?.includes("after hours");
    if (onCallLike) return false;
    return true;
  });
  return [...fromForwarding, ...(keep as ReturnType<typeof forwardingProfilesToTransferProfiles>)];
}

export function pricingToAssistantContext(pricing?: { items?: Array<{ name: string; price: string; description?: string }>; notes?: string }): Record<string, string> {
  if (!pricing) return {};
  const lines = (pricing.items || []).map((i) => `${i.name}: ${i.price}${i.description ? ` — ${i.description}` : ""}`);
  const body = [lines.join("\n"), pricing.notes || ""].filter(Boolean).join("\n");
  if (!body.trim()) return {};
  return { pricing: body, "Shop prices": body };
}

export function inferCompletionFromText(text: string): CallCompletion | null {
  const t = (text || "").toLowerCase();
  if (!t.trim()) return null;
  if (
    /\bi('ve| have) booked\b|\bbooked (you|it|for)\b|\byou('re| are) booked\b|\bconfirmed for\b|\byou('re| are) scheduled\b|\bappointment (is|has been) (set|scheduled|confirmed)\b|\ball set for\b/.test(
      t,
    )
  ) {
    return "booked";
  }
  if (/\bhold(ing)? (this|it) for (the )?owner\b|\bapproval\b/.test(t)) return "approval_held";
  if (/\bpaging\b|\bon-call\b|\bon call technician\b/.test(t)) return "on_call_paged";
  if (/\bdo not service\b|\bwe don't (take|do|service)\b|\bout of (the )?area\b/.test(t)) return "refused";
  if (/\b(created|wrote|written|opened|logged) (an? )?(urgent )?task\b/.test(t)) return "tasked";
  if (/\bsomeone will (call|follow)\b|\bi'll have (someone|the owner)\b/.test(t)) return null;
  return null;
}

export function emptyPromise(text: string): boolean {
  return /\b(someone|the owner|a technician|a team member) will (call|follow|get back|reach out)\b|\bi('ll| will) have (someone|nicholas|nick|the owner|a technician) (call|follow|reach out|get back)\b/i.test(
    text || "",
  );
}

function slugId(raw: string): string {
  const s = String(raw)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
  return s || "line";
}

function uniqueStrings(xs: string[]): string[] {
  return [...new Set(xs.map((s) => s.trim().toLowerCase()).filter(Boolean))];
}

function uniqueStringsPreserveCase(xs: string[]): string[] {
  return [...new Set(xs.map((s) => s.trim()).filter(Boolean))];
}

function normalizeOptionalE164(value: string | undefined): string | undefined {
  const normalized = String(value || "").trim();
  return /^\+[1-9]\d{7,14}$/.test(normalized) ? normalized : undefined;
}

export const CUTOVER_ITEM_IDS = [
  "did_inbound",
  "hours_published",
  "playbook_published",
  "oncall_sms",
  "refuse_out_of_area",
  "book_or_hold",
  "test_call",
  "faq_hours",
  "transfer_or_message",
  "existing_cid",
  "quote_or_hold",
] as const;
export type CutoverItemId = (typeof CUTOVER_ITEM_IDS)[number];
