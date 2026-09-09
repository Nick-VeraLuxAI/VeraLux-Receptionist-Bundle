/**
 * Watcher-owned call board: deterministic slots, intent, speak policy, and
 * shop-law planning. The LLM may fill FAQ/chit-chat; it does not own NEXT,
 * prices, or booked claims.
 */

import { z } from "zod";
import {
  DEFAULT_EMERGENCY_KEYWORDS,
  evaluateShopAction,
  extractQuoteCents,
  extractZip,
  inferShopIntent,
  normalizeShopPlaybook,
  utteranceLooksEmergency,
  type ShopEvaluation,
  type ShopPlaybook,
} from "./shopPlaybook";

export const INTAKE_PROFILE_KINDS = ["demo", "trades"] as const;
export type IntakeProfileKind = (typeof INTAKE_PROFILE_KINDS)[number];

export const INTAKE_WRITERS = ["gcal", "fsm"] as const;
export type IntakeWriter = (typeof INTAKE_WRITERS)[number];

export const DESK_INTENTS = [
  "faq",
  "book",
  "message",
  "transfer",
  "quote",
  "emergency",
  "status",
  "other",
] as const;
export type DeskIntent = (typeof DESK_INTENTS)[number];

export const intakeProfileSchema = z.object({
  kind: z.enum(INTAKE_PROFILE_KINDS),
  writer: z.enum(INTAKE_WRITERS),
  timezone: z.string().min(1).max(80).default("America/Los_Angeles"),
  timezoneOffsetHours: z.number().min(-12).max(14).default(-7),
});
export type IntakeProfile = z.infer<typeof intakeProfileSchema>;

export const DEFAULT_INTAKE_PROFILE: IntakeProfile = {
  kind: "trades",
  writer: "fsm",
  timezone: "America/Los_Angeles",
  timezoneOffsetHours: -7,
};

export const DEMO_INTAKE_PROFILE: IntakeProfile = {
  kind: "demo",
  writer: "gcal",
  timezone: "America/Los_Angeles",
  timezoneOffsetHours: -7,
};

export function defaultIntakeProfile(tenantId?: string): IntakeProfile {
  // Unpublished configs only. Published runtime config stamps `intakeProfile`
  // so call-path law is the profile, not `tenantId === "demo-shop"`.
  return tenantId === "demo-shop" ? { ...DEMO_INTAKE_PROFILE } : { ...DEFAULT_INTAKE_PROFILE };
}

export function normalizeIntakeProfile(
  raw?: Partial<IntakeProfile> | null,
  tenantId?: string,
): IntakeProfile {
  const fallback = defaultIntakeProfile(tenantId);
  const parsed = intakeProfileSchema.safeParse({
    kind: raw?.kind || fallback.kind,
    writer: raw?.writer || fallback.writer,
    timezone: raw?.timezone || fallback.timezone,
    timezoneOffsetHours:
      typeof raw?.timezoneOffsetHours === "number"
        ? raw.timezoneOffsetHours
        : fallback.timezoneOffsetHours,
  });
  return parsed.success ? parsed.data : fallback;
}

export type BoardTurn = { role?: string; content?: string };

export type TalkerBoard = {
  have: string[];
  missing: string[];
  next: string;
};

export type IntakeSlots = {
  name?: string;
  phone?: string;
  email?: string;
  start?: string;
  end?: string;
  startSource?: string;
  startSpeak?: string;
  address?: string;
  city?: string;
  zip?: string;
  jobType?: string;
  issue?: string;
  confirmed: boolean;
  confirmSignal?: string;
  hasName: boolean;
  hasContact: boolean;
  slotReady: boolean;
  writable: boolean;
  scheduleable: boolean;
  transcript: string;
};

export type ExistingCaller = {
  name?: string;
  openJobs?: Array<{ id?: string; title?: string }>;
  membership?: string;
  warranty?: string;
};

export type TransferProfileLike = {
  id?: string;
  name?: string;
  holder?: string;
  responsibilities?: string[];
  destination: string;
  timeoutSecs?: number;
};

const WEEKDAYS: Record<string, number> = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
};

const MONTHS: Record<string, number> = {
  january: 0,
  february: 1,
  march: 2,
  april: 3,
  may: 4,
  june: 5,
  july: 6,
  august: 7,
  september: 8,
  october: 9,
  november: 10,
  december: 11,
  jan: 0,
  feb: 1,
  mar: 2,
  apr: 3,
  jun: 5,
  jul: 6,
  aug: 7,
  sep: 8,
  sept: 8,
  oct: 9,
  nov: 10,
  dec: 11,
};

const NAME_STOP =
  /^(i|im|i'm|its|it's|this|that|yes|yeah|yep|yup|no|nope|ok|okay|sure|thanks|thank|please|hello|hi|hey|my|the|a|an|and|or|to|for|at|on|in|of|we|you|me|us|here|there|today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|am|pm|hoping|calling|trying|looking|interested|going|gonna|wanting|just|ooh|oh|um|uh|can|soon|well|demo|appointment|booking|call|phone|email|september|october|november|december|january|february|march|april|june|july|august)$/i;

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

export function apostropheNorm(s: string): string {
  return String(s || "").replace(/[\u2018\u2019\u201A\u201B\u2032\u2035\u02BC]/g, "'");
}

export function isBusinessHoursBleed(src: string, matchStart: number, matchEnd: number): boolean {
  const left = src.slice(Math.max(0, matchStart - 56), matchStart);
  const right = src.slice(matchEnd, Math.min(src.length, matchEnd + 56));
  const around = `${left} ${right}`.toLowerCase();
  if (/\b(open|hours|between|from)\b/.test(around) && /\b(to|through|thru|until|-)\b/.test(around)) {
    return true;
  }
  const matched = src.slice(matchStart, matchEnd);
  if (/\b(through|thru|to|until)\b/i.test(matched) && !/\bat\b/i.test(matched)) return true;
  if (
    /\b(to|through|thru|until)\s+\d{1,2}/i.test(right) &&
    !/\bat\b/i.test(src.slice(Math.max(0, matchStart - 8), matchStart + 4))
  ) {
    return true;
  }
  if (/\d{1,2}(?:[:.\s]?\d{2})?\s*(a\.?m\.?|p\.?m\.?)\s*(to|through|thru|until|-)\s*$/i.test(left)) {
    return true;
  }
  return false;
}

export function parseAmPmHour(
  hourRaw: string,
  minuteRaw: string | undefined,
  ampmRaw: string,
): { hour: number; minute: number } {
  let hour = parseInt(hourRaw, 10);
  const minute = parseInt(minuteRaw || "0", 10);
  const ampm = String(ampmRaw || "")
    .toLowerCase()
    .replace(/\./g, "");
  if (ampm.startsWith("p") && hour < 12) hour += 12;
  if (ampm.startsWith("a") && hour === 12) hour = 0;
  return { hour, minute };
}

function toIsoOffset(
  year: number,
  monthIndex: number,
  day: number,
  hour: number,
  minute: number,
  offsetHours: number,
): { start: string; end: string } {
  const sign = offsetHours <= 0 ? "-" : "+";
  const abs = Math.abs(offsetHours);
  const off = `${sign}${pad(abs)}:00`;
  const start = `${year}-${pad(monthIndex + 1)}-${pad(day)}T${pad(hour)}:${pad(minute)}:00${off}`;
  const endMinuteTotal = minute + 30;
  const endHour = hour + Math.floor(endMinuteTotal / 60);
  const endMin = endMinuteTotal % 60;
  const end = `${year}-${pad(monthIndex + 1)}-${pad(day)}T${pad(endHour)}:${pad(endMin)}:00${off}`;
  return { start, end };
}

export type ClockContext = {
  ptY: number;
  ptM: number;
  ptD: number;
  ptDow: number;
  ptMins: number;
  nowMs: number;
  offsetHours: number;
};

export function clockContextFromDate(now: Date, offsetHours = -7): ClockContext {
  const shifted = new Date(now.getTime() + offsetHours * 3600 * 1000);
  return {
    ptY: shifted.getUTCFullYear(),
    ptM: shifted.getUTCMonth(),
    ptD: shifted.getUTCDate(),
    ptDow: shifted.getUTCDay(),
    ptMins: shifted.getUTCHours() * 60 + shifted.getUTCMinutes(),
    nowMs: now.getTime(),
    offsetHours,
  };
}

export function resolveSpokenStart(
  src: string,
  ctx: ClockContext,
  labelPrefix = "user",
): { start: string; end: string; startSource: string } | null {
  if (!src || !String(src).trim()) return null;
  const { ptY, ptM, ptD, ptDow, ptMins, offsetHours, nowMs } = ctx;

  const namedToHm = (word: string) => {
    const w = String(word || "").toLowerCase();
    if (w === "noon") return { hour: 12, minute: 0 };
    if (w === "midnight") return { hour: 0, minute: 0 };
    return null;
  };
  const resolveWeekdayHm = (weekdayRaw: string, hour: number, minute: number, source: string) => {
    const targetDow = WEEKDAYS[String(weekdayRaw).toLowerCase()];
    if (targetDow == null) return null;
    let delta = (targetDow - ptDow + 7) % 7;
    if (delta === 0 && ptMins >= hour * 60 + minute) delta = 7;
    const target = new Date(Date.UTC(ptY, ptM, ptD + delta));
    const iso = toIsoOffset(
      target.getUTCFullYear(),
      target.getUTCMonth(),
      target.getUTCDate(),
      hour,
      minute,
      offsetHours,
    );
    return { ...iso, startSource: source };
  };

  const namedWd =
    /\b(?:this\s+(?:coming\s+)?)?(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b(?:[^\n]{0,40}?)(?:at\s+)?(noon|midnight)\b/i.exec(
      src,
    );
  if (namedWd) {
    const hm = namedToHm(namedWd[2]);
    if (hm) {
      const resolved = resolveWeekdayHm(
        namedWd[1],
        hm.hour,
        hm.minute,
        `${labelPrefix}_weekday_named_clock`,
      );
      if (resolved) return resolved;
    }
  }

  const namedRel =
    /\b(today|tomorrow|next\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday))\b(?:[^\n]{0,40}?)(?:at\s+)?(noon|midnight)\b/i.exec(
      src,
    );
  if (namedRel) {
    const hm = namedToHm(namedRel[3]);
    if (hm) {
      let delta = 0;
      const kind = namedRel[1].toLowerCase();
      if (kind === "tomorrow") delta = 1;
      else if (kind.startsWith("next ")) {
        const targetDow = WEEKDAYS[namedRel[2].toLowerCase()];
        delta = (targetDow - ptDow + 7) % 7;
        if (delta === 0) delta = 7;
      }
      const target = new Date(Date.UTC(ptY, ptM, ptD + delta));
      const iso = toIsoOffset(
        target.getUTCFullYear(),
        target.getUTCMonth(),
        target.getUTCDate(),
        hm.hour,
        hm.minute,
        offsetHours,
      );
      return { ...iso, startSource: `${labelPrefix}_relative_named_clock` };
    }
  }

  const atClock =
    /(?:\b(?:this\s+(?:coming\s+)?)?(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b[^\d]{0,40}?)?\bat\s+(\d{1,2})(?:[:.](\d{2})|([0-5]\d))?\s*(a\.?m\.?|p\.?m\.?)\b/i.exec(
      src,
    );
  if (atClock && atClock[5] && atClock[1]) {
    const minuteRaw = atClock[3] || atClock[4] || "0";
    const { hour, minute } = parseAmPmHour(atClock[2], minuteRaw, atClock[5]);
    const resolved = resolveWeekdayHm(atClock[1], hour, minute, `${labelPrefix}_at_weekday_clock`);
    if (resolved) return resolved;
  }

  const monthRe =
    /\b(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)\s+(\d{1,2})(?:st|nd|rd|th)?(?:\s*,?\s*(\d{4}))?\s*(?:at\s+)?(\d{1,2})(?:[:.](\d{2})|([0-5]\d))?\s*(a\.?m\.?|p\.?m\.?)/i;
  const mm = monthRe.exec(src);
  if (mm && mm[7]) {
    const month = MONTHS[mm[1].toLowerCase()];
    const day = parseInt(mm[2], 10);
    let year = mm[3] ? parseInt(mm[3], 10) : ptY;
    const minuteRaw = mm[5] || mm[6] || "0";
    const { hour, minute } = parseAmPmHour(mm[4], minuteRaw, mm[7]);
    if (!isBusinessHoursBleed(src, mm.index, mm.index + mm[0].length)) {
      const guess = Date.UTC(year, month, day, hour - offsetHours, minute);
      if (!mm[3] && guess < nowMs - 86400000) year += 1;
      const iso = toIsoOffset(year, month, day, hour, minute, offsetHours);
      return { ...iso, startSource: `${labelPrefix}_month_day_time` };
    }
  }

  const wdRe =
    /\b(?:this\s+(?:coming\s+)?)?(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b(?:[^\d]{0,48}?)(?:at\s+)?(\d{1,2})(?:[:.](\d{2})|([0-5]\d))?\s*(a\.?m\.?|p\.?m\.?)/i;
  const w = wdRe.exec(src);
  if (w && w[5] && !isBusinessHoursBleed(src, w.index, w.index + w[0].length)) {
    const minuteRaw = w[3] || w[4] || "0";
    const { hour, minute } = parseAmPmHour(w[2], minuteRaw, w[5]);
    const resolved = resolveWeekdayHm(w[1], hour, minute, `${labelPrefix}_weekday_time`);
    if (resolved) return resolved;
  }

  const relRe =
    /\b(today|tomorrow|next\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday))\b(?:[^\d]{0,48}?)(?:at\s+)?(\d{1,2})(?:[:.](\d{2})|([0-5]\d))?\s*(a\.?m\.?|p\.?m\.?)/i;
  const r = relRe.exec(src);
  if (r && r[3] && r[6] && !isBusinessHoursBleed(src, r.index, r.index + r[0].length)) {
    const minuteRaw = r[4] || r[5] || "0";
    const { hour, minute } = parseAmPmHour(r[3], minuteRaw, r[6]);
    let delta = 0;
    const kind = r[1].toLowerCase();
    if (kind === "tomorrow") delta = 1;
    else if (kind.startsWith("next ")) {
      const targetDow = WEEKDAYS[r[2].toLowerCase()];
      delta = (targetDow - ptDow + 7) % 7;
      if (delta === 0) delta = 7;
    }
    const target = new Date(Date.UTC(ptY, ptM, ptD + delta));
    const iso = toIsoOffset(
      target.getUTCFullYear(),
      target.getUTCMonth(),
      target.getUTCDate(),
      hour,
      minute,
      offsetHours,
    );
    return { ...iso, startSource: `${labelPrefix}_relative_time` };
  }
  return null;
}

function nameParticle(word: string): boolean {
  return /^(de|da|van|von|der|la|le|del|della|di|du|st|saint)$/i.test(String(word || ""));
}

export function extractCallerName(userText: string): string | undefined {
  const text = String(userText || "");
  const months =
    /^(january|february|march|april|may|june|july|august|september|october|november|december)$/i;
  const weekdays = /^(monday|tuesday|wednesday|thursday|friday|saturday|sunday)$/i;
  const isNameToken = (token: string) => /^[A-Za-z]{2,20}(?:-[A-Za-z]{2,20})?$/.test(token);
  const cueRe = /\b(?:my\s+name\s+is|name\s+is|name's|this\s+is|use|under|as)\s+/gi;
  let cue: RegExpExecArray | null;
  while ((cue = cueRe.exec(text))) {
    const rest = text.slice(cue.index + cue[0].length);
    const words = rest.split(/\s+/);
    const taken: string[] = [];
    for (let i = 0; i < words.length; i++) {
      const clean = String(words[i] || "").replace(/^[^A-Za-z]+|[^A-Za-z'-]+$/g, "");
      if (!clean) continue;
      if (/^\d/.test(clean)) break;
      if (/^(and|on|at|for|this|tomorrow|today|next)$/i.test(clean)) break;
      if (months.test(clean) || weekdays.test(clean)) break;
      if (nameParticle(clean)) {
        taken.push(clean);
        continue;
      }
      if (!isNameToken(clean) || NAME_STOP.test(clean)) break;
      taken.push(clean);
      if (taken.filter((t) => !nameParticle(t)).length >= 3) break;
    }
    while (taken.length && nameParticle(taken[taken.length - 1])) taken.pop();
    if (taken.length) return taken.join(" ");
  }
  const beforeDate =
    /\b((?:[A-Za-z]{2,20}(?:-[A-Za-z]{2,20})?[ \t]+){0,3}[A-Za-z]{2,20}(?:-[A-Za-z]{2,20})?)\s+(?:and|on)\s+(?:january|february|march|april|may|june|july|august|september|october|november|december|\d{1,2})\b/i.exec(
      text,
    );
  if (beforeDate) {
    const parts = beforeDate[1]
      .trim()
      .split(/[ \t]+/)
      .filter((p) => p && (nameParticle(p) || (isNameToken(p) && !NAME_STOP.test(p))));
    while (parts.length && nameParticle(parts[parts.length - 1])) parts.pop();
    if (parts.length) return parts.join(" ");
  }
  const im = /\b(?:i'?m|it'?s)\s+([A-Za-z]{2,20}(?:[ \t]+[A-Za-z]{2,20})?)\b/i.exec(text);
  if (im) {
    const kept = im[1]
      .trim()
      .split(/[ \t]+/)
      .filter((p) => p && (!NAME_STOP.test(p) || nameParticle(p)));
    if (kept.length && !kept.every((p) => nameParticle(p))) return kept.join(" ");
  }
  return undefined;
}

export function extractPhone(text: string): string | undefined {
  const raw = String(text || "");
  if (!raw) return undefined;
  const noClock = raw
    .replace(/\b\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)\b/gi, " ")
    .replace(/\b\d{3,4}\s*(?:a\.?m\.?|p\.?m\.?)\b/gi, " ")
    .replace(
      /\b(?:january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{1,2}(?:st|nd|rd|th)?\b/gi,
      " ",
    );
  const tokens = noClock.split(/\s+/).filter(Boolean);
  for (const tok of tokens) {
    const d = tok.replace(/\D/g, "");
    if (d.length === 10) return d;
    if (d.length === 11 && d.charAt(0) === "1") return d.slice(1);
  }
  let acc = "";
  for (const tok of tokens) {
    const d = tok.replace(/\D/g, "");
    if (d.length >= 3 && d.length <= 4 && /^\d+$/.test(d)) {
      acc += d;
      if (acc.length === 10) return acc;
      if (acc.length > 10) acc = d;
    } else {
      acc = "";
    }
  }
  return undefined;
}

export type DtmfIngestState = {
  buffer?: string | null;
  phone?: string | null;
  alreadyHasPhone?: boolean;
};

export type DtmfIngestResult = {
  buffer: string;
  phone: string | null;
  action: "clear" | "ignore" | "complete" | "digit";
};

/** First complete 10 keypad digits win. Never stitch spoken fragments with DTMF. */
export function ingestDtmfDigit(state: DtmfIngestState | undefined, rawDigit: string): DtmfIngestResult {
  const prevBuffer = String(state?.buffer || "");
  const prevPhone = state?.phone ? String(state.phone) : null;
  const alreadyHasPhone = !!state?.alreadyHasPhone || !!(prevPhone && prevPhone.length === 10);
  const ch = String(rawDigit || "").trim();
  if (ch === "*") {
    return { buffer: "", phone: null, action: "clear" };
  }
  if (alreadyHasPhone && prevPhone) {
    return { buffer: prevPhone, phone: prevPhone, action: "ignore" };
  }
  if (ch === "#") {
    if (prevBuffer.length === 10) {
      return { buffer: prevBuffer, phone: prevBuffer, action: "complete" };
    }
    return { buffer: prevBuffer, phone: null, action: "ignore" };
  }
  if (!/^[0-9]$/.test(ch)) {
    return { buffer: prevBuffer, phone: prevPhone, action: "ignore" };
  }
  let buffer = prevBuffer + ch;
  if (buffer.length > 10) buffer = buffer.slice(0, 10);
  if (buffer.length === 10) {
    return { buffer, phone: buffer, action: "complete" };
  }
  return { buffer, phone: null, action: "digit" };
}

export function extractEmail(text: string): string | undefined {
  const em = /([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})/i.exec(text || "");
  return em?.[1];
}

export function isIncompleteContact(raw: string): boolean {
  const digits = (String(raw || "").match(/\d/g) || []).length;
  if (digits >= 3 && digits <= 9 && !/@/.test(raw)) {
    const mostlyDigits =
      /^[\d\-().\s+]+$/.test(raw) ||
      /^(?:it'?s|this is|my (?:phone(?: number)?|number) is)\s+[\d\-().\s+]+$/i.test(raw);
    if (mostlyDigits) return true;
  }
  if (/^my phone( number)? is\b/i.test(raw) && digits < 10) return true;
  return false;
}

export function extractServiceAddress(userText: string): string | undefined {
  const addressMatch =
    /(?:address is|service address is|i(?:'m| am) at|come to)\s+(\d{1,6}\s+[^.\n]{3,120})/i.exec(
      userText || "",
    );
  return addressMatch?.[1]?.trim();
}

export function formatConfirmDateFromIso(iso: string | undefined | null): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(String(iso || "").trim());
  if (!m) return null;
  const year = parseInt(m[1], 10);
  const monthIndex = parseInt(m[2], 10) - 1;
  const day = parseInt(m[3], 10);
  const hour = parseInt(m[4], 10);
  const minute = parseInt(m[5], 10);
  const weekdays = [
    "Sunday",
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
  ];
  const months = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
  ];
  const dow = new Date(Date.UTC(year, monthIndex, day)).getUTCDay();
  const ordinal = (n: number) => {
    const mod100 = n % 100;
    if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
    switch (n % 10) {
      case 1:
        return `${n}st`;
      case 2:
        return `${n}nd`;
      case 3:
        return `${n}rd`;
      default:
        return `${n}th`;
    }
  };
  const ampm = hour >= 12 ? "PM" : "AM";
  let h12 = hour % 12;
  if (h12 === 0) h12 = 12;
  const timePart =
    minute === 0 ? `${h12} ${ampm}` : `${h12}:${String(minute).padStart(2, "0")} ${ampm}`;
  return `${weekdays[dow]}, ${months[monthIndex]} ${ordinal(day)} at ${timePart}`;
}

export function rewriteWeekdayOnlyConfirm(speakText: string, iso: string | undefined | null): string {
  const text = String(speakText || "");
  if (
    /\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{1,2}(?:st|nd|rd|th)?\b/i.test(
      text,
    )
  ) {
    return text;
  }
  const concrete = formatConfirmDateFromIso(iso);
  if (!concrete) return text;
  const wdTimeRe =
    /\b(?:this\s+(?:coming\s+)?)?(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b(?:\s*,?\s*(?:at\s+)?(?:noon|midnight|\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)|\d{1,2}:\d{2}))?/i;
  if (!wdTimeRe.test(text)) return text;
  let out = text.replace(wdTimeRe, concrete);
  if (out !== text && out.includes(concrete)) {
    const parts = out.split(concrete);
    const tail = parts.slice(1).join(concrete);
    const strippedTail = tail.replace(
      /^\s*(?:at\s+)?(?:noon|midnight|\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)?)/i,
      "",
    );
    out = parts[0] + concrete + strippedTail;
  }
  return out;
}

export function speakClaimsBooked(text: string): boolean {
  return /\b(i('ve| have) booked|i('ll| will) book|let me book|i('ll| will) (go ahead and )?schedule|schedule your demo|you'll receive a confirmation|your (demo|appointment|booking) is booked|booked (you|your)|you're all set|locked in|i('ve| have) got you down|got you down|penciled (you )?in)\b/i.test(
    String(text || ""),
  );
}

export function looksLikeHandoff(text: string): boolean {
  const t = String(text || "");
  if (/\b(transfer|connect) (you|the caller)\b/i.test(t)) return true;
  if (/\bsomeone will (reach out|call|contact|follow)\b/i.test(t)) return true;
  if (/\b(schedule|book|set up).{0,30}\b(later|offline|after (this|the) call|separately)\b/i.test(t)) {
    return true;
  }
  if (/\b(i('ll| will) have (someone|nicholas|nick|a human))\b/i.test(t)) return true;
  return false;
}

export function looksLikeFaq(text: string): boolean {
  const u = String(text || "").toLowerCase();
  return /\b(hours|open|close|parking|where are you|address|do you (do|offer|take)|what (do you|services))\b/.test(
    u,
  );
}

export function looksLikeTransferRequest(text: string): boolean {
  const u = String(text || "").toLowerCase();
  return /\b(transfer|connect me|put me through|speak to|talk to (a )?(person|human|someone|nick|manager))\b/.test(
    u,
  );
}

export function looksLikeMessageRequest(text: string): boolean {
  const u = String(text || "").toLowerCase();
  return /\b(take a message|leave a message|just (wanted to )?leave|call me back|have (someone|them) call)\b/.test(
    u,
  );
}

export function looksLikeStatusRequest(text: string): boolean {
  const u = String(text || "").toLowerCase();
  return /\b(where('s| is) my (tech|technician|plumber)|open job|already scheduled|status of|on (their|the) way|eta)\b/.test(
    u,
  );
}

export function classifyDeskIntent(
  utterance: string | undefined,
  playbook?: Partial<ShopPlaybook> | null,
): DeskIntent {
  const u = String(utterance || "");
  const pb = normalizeShopPlaybook(playbook);
  if (utteranceLooksEmergency(u, pb.emergencyKeywords.length ? pb.emergencyKeywords : DEFAULT_EMERGENCY_KEYWORDS)) {
    return "emergency";
  }
  if (looksLikeStatusRequest(u)) return "status";
  if (looksLikeTransferRequest(u)) return "transfer";
  if (looksLikeMessageRequest(u)) return "message";
  if (looksLikeFaq(u) && !/\b(book|schedule|appointment)\b/i.test(u)) return "faq";
  const shop = inferShopIntent(u);
  if (shop === "quote") return "quote";
  if (shop === "book") return "book";
  if (shop === "emergency") return "emergency";
  if (shop === "service_issue") return "status";
  return "other";
}

export function isResolvedOffsetStart(iso: string | undefined | null): boolean {
  const s = String(iso || "");
  return /[+-]\d{2}:\d{2}$/.test(s) || /America\/Los_Angeles/i.test(s);
}

export function extractIntakeSlots(input: {
  history: BoardTurn[];
  callerId?: string;
  dtmfPhone?: string | null;
  existingName?: string;
  profile?: Partial<IntakeProfile> | null;
  tenantId?: string;
  now?: Date;
}): IntakeSlots {
  const profile = normalizeIntakeProfile(input.profile, input.tenantId);
  const list = Array.isArray(input.history) ? input.history : [];
  const userText = apostropheNorm(
    list
      .filter((t) => t.role === "user")
      .map((t) => String(t.content || ""))
      .join("\n"),
  );
  const assistantText = apostropheNorm(
    list
      .filter((t) => t.role === "assistant")
      .map((t) => String(t.content || ""))
      .join("\n"),
  );
  const fullText = apostropheNorm(list.map((t) => String(t.content || "")).join("\n"));
  const transcript = list.map((t) => `${t.role}: ${t.content}`).join("\n");

  const confirmPatterns = [
    /\b(your\s+)?(demo|appointment|booking)\s+is\s+booked\b/i,
    /\b(demo|appointment)\s+is\s+(confirmed|set|locked\s+in)\b/i,
    /\byou('re| are)\s+(all\s+set|booked|confirmed)\b/i,
    /\b(locked\s+in|confirmed\s+for|booked\s+for)\b/i,
    /\bi('ve| have)\s+(booked|got\s+you\s+down|scheduled)\b/i,
    /\bi('ll| will)\s+book\b/i,
    /\bi('ll| will)\s+(go ahead and\s+)?schedule\b/i,
    /\blet me book\b/i,
    /\bscheduled?\s+(your|the)\s+(demo|appointment)\b/i,
  ];
  let confirmSignal: string | undefined;
  for (const re of confirmPatterns) {
    const m = re.exec(assistantText) || re.exec(fullText);
    if (m) {
      confirmSignal = m[0];
      break;
    }
  }

  const ctx = clockContextFromDate(input.now || new Date(), profile.timezoneOffsetHours);
  const resolved =
    resolveSpokenStart(userText, ctx, "user") ||
    resolveSpokenStart(fullText, ctx, "full") ||
    resolveSpokenStart(assistantText, ctx, "assistant");

  const name = input.existingName || extractCallerName(userText);
  const phone = input.dtmfPhone || extractPhone(userText) || extractPhone(fullText) || undefined;
  const email = extractEmail(userText) || extractEmail(fullText);
  const address = extractServiceAddress(userText);
  const zip = extractZip(userText);
  const addressParts = address ? address.split(",").map((p) => p.trim()).filter(Boolean) : [];
  const latestUser =
    [...list].reverse().find((t) => t.role === "user")?.content || userText.slice(-200);
  const jobType =
    profile.kind === "trades"
      ? String(latestUser || "")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 200) || undefined
      : undefined;

  const startIso = resolved?.start;
  const slotReady = !!(startIso && isResolvedOffsetStart(startIso));
  const hasName = !!name;
  const hasContact = !!(phone || email || (profile.kind === "trades" && input.callerId));
  const writable =
    profile.kind === "demo"
      ? !!(slotReady && hasName && hasContact)
      : !!(hasName && hasContact && (address || zip) && jobType);
  const scheduleable = !!(
    (profile.kind === "demo" ? slotReady : writable) &&
    (confirmSignal || (hasName && hasContact))
  );

  return {
    name,
    phone,
    email,
    start: startIso,
    end: resolved?.end,
    startSource: resolved?.startSource,
    startSpeak: startIso ? formatConfirmDateFromIso(startIso) || undefined : undefined,
    address,
    city: addressParts.length >= 3 ? addressParts[1] : undefined,
    zip,
    jobType,
    issue: String(latestUser).slice(0, 500),
    confirmed: !!confirmSignal,
    confirmSignal,
    hasName,
    hasContact,
    slotReady,
    writable,
    scheduleable,
    transcript,
  };
}

export function slotsToLead(
  slots: IntakeSlots,
  extra?: Record<string, unknown>,
): Record<string, unknown> {
  return {
    name: slots.name,
    customerName: slots.name,
    phone: slots.phone,
    email: slots.email,
    address: slots.address,
    serviceAddress: slots.address,
    zip: slots.zip,
    city: slots.city,
    jobType: slots.jobType,
    service: slots.jobType,
    issue: slots.issue,
    startIso: slots.start,
    scheduledAt: slots.start,
    ...extra,
  };
}

export function bookingMissingFields(
  profileInput: Partial<IntakeProfile> | null | undefined,
  lead: Record<string, unknown> | IntakeSlots | undefined,
  callerId?: string,
  tenantId?: string,
): string[] {
  const profile = normalizeIntakeProfile(profileInput, tenantId);
  const field = (...keys: string[]) => {
    if (!lead) return undefined;
    for (const key of keys) {
      const value = (lead as Record<string, unknown>)[key];
      if (typeof value === "string" && value.trim()) return value.trim();
      if (typeof value === "boolean" && key === "hasName" && value) return "1";
    }
    return undefined;
  };
  const missing: string[] = [];
  if (!field("name", "customerName") && !field("hasName")) missing.push("name");
  if (profile.kind === "demo") {
    if (!field("email") && !field("phone") && !callerId) missing.push("phone-or-email");
    if (!field("start", "startIso", "scheduledAt")) missing.push("day-and-time");
  } else {
    if (!field("phone") && !callerId) missing.push("phone");
    if (!field("address", "serviceAddress") && !field("zip")) missing.push("service address");
    if (!field("jobType", "service", "issue")) missing.push("service type");
  }
  return missing;
}

export function formatTalkerBoard(input: TalkerBoard): string {
  const have = input.have.length ? input.have.map((line) => `- ${line}`).join("\n") : "- (none yet)";
  const missing = input.missing.length
    ? input.missing.map((line) => `- ${line}`).join("\n")
    : "- (none)";
  return [
    "This is the live call board from the watcher. Obey it over conversation history and over any urge to collect extra fields.",
    "HAVE:",
    have,
    "MISSING:",
    missing,
    `NEXT: ${input.next}`,
    "Do not re-ask HAVE. Do not read HAVE back as a list. Ask at most NEXT. Phone or email is one contact slot — if either is HAVE, do not ask for the other.",
  ].join("\n");
}

export function buildTalkerBoard(input: {
  profile?: Partial<IntakeProfile> | null;
  tenantId?: string;
  intent?: DeskIntent;
  name?: string | null;
  start?: string | null;
  startSpeak?: string | null;
  phone?: string | null;
  email?: string | null;
  address?: string | null;
  zip?: string | null;
  jobType?: string | null;
  writable?: boolean;
  posted?: boolean;
  existingName?: string | null;
  openJobs?: string | null;
  membership?: string | null;
  afterHours?: boolean;
}): TalkerBoard {
  const profile = normalizeIntakeProfile(input.profile, input.tenantId);
  const have: string[] = [];
  const missing: string[] = [];
  if (input.existingName) have.push(`existing-customer: ${input.existingName}`);
  if (input.openJobs) have.push(`open-jobs: ${input.openJobs}`);
  if (input.membership) have.push(`membership: ${input.membership}`);
  if (input.afterHours) have.push("desk: night");
  else have.push("desk: day");

  if (profile.kind === "demo") {
    if (input.start) have.push(`time: ${input.startSpeak || input.start}`);
    else missing.push("day-and-time (with AM or PM)");
    if (input.name) have.push(`name: ${input.name}`);
    else missing.push("name");
    if (input.phone) have.push(`phone: ${input.phone}`);
    if (input.email) have.push(`email: ${input.email}`);
    if (!input.phone && !input.email) missing.push("phone-or-email (one is enough)");
  } else {
    if (input.name) have.push(`name: ${input.name}`);
    else missing.push("name");
    if (input.phone) have.push(`phone: ${input.phone}`);
    else missing.push("phone");
    if (input.address || input.zip) have.push(`location: ${input.address || input.zip}`);
    else missing.push("service address or zip");
    if (input.jobType) have.push(`job: ${input.jobType}`);
    else missing.push("service type");
  }

  let next: string;
  if (input.intent === "faq") {
    next = "Answer the factual question from shop context. Do not collect booking fields.";
  } else if (input.intent === "transfer") {
    next = "Confirm the desk to connect, then transfer. Do not collect extra booking fields.";
  } else if (input.intent === "message") {
    next = input.writable
      ? "Board is complete. Brief ack only — the system is writing a task."
      : "Take a message: name, callback, and the issue. Do not claim someone will call until the task is written.";
  } else if (input.intent === "status") {
    next = "Speak open-job / membership status from HAVE. Do not invent an ETA.";
  } else if (input.intent === "quote") {
    next = "Quote only a published list price. If none, hold for owner approval. Do not invent a dollar amount.";
  } else if (input.intent === "emergency") {
    next = "Emergency shop law is handling this turn. Stay on the line; do not book.";
  } else if (input.posted) {
    next =
      "Calendar write succeeded. Confirm they are booked in one short sentence. Do not re-collect. Do not list fields.";
  } else if (input.writable) {
    next =
      "Board is complete. Do not ask for email, phone, name, or time. Do not say booked or all set. Brief hold only — the system is writing and will speak the booked confirm when the write finishes.";
  } else if (profile.kind === "demo") {
    if (missing.includes("day-and-time (with AM or PM)") && missing.includes("name")) {
      next = "Ask name and a day/time with AM or PM in one short question.";
    } else if (missing[0] === "day-and-time (with AM or PM)") {
      next = "Ask what day and time (with AM or PM).";
    } else if (missing.includes("name")) {
      next = "Ask their name.";
    } else if (missing.some((item) => item.startsWith("phone-or-email"))) {
      next =
        "Ask for a phone number or an email — one, not both. They may say the ten digits or tap them on the keypad.";
    } else {
      next = `Ask only: ${missing[0] || "how you can help"}.`;
    }
  } else {
    next = `Ask only: ${missing[0] || "how you can help"}.`;
  }
  return { have, missing, next };
}

/** Demo Shop alias used by live mounts and self-checks. */
export function buildDemoShopTalkerBoard(input: {
  name?: string | null;
  start?: string | null;
  startSpeak?: string | null;
  phone?: string | null;
  email?: string | null;
  writable?: boolean;
  posted?: boolean;
}): TalkerBoard {
  return buildTalkerBoard({ ...input, profile: DEMO_INTAKE_PROFILE, intent: "book" });
}

export function collectSpeakTemplate(board: TalkerBoard, slots: IntakeSlots): string {
  if (/Calendar write succeeded/.test(board.next) && slots.startSpeak) {
    return `You're booked for ${slots.startSpeak}.`;
  }
  if (/Board is complete/.test(board.next)) {
    return "One moment while I write that down.";
  }
  if (/name and a day\/time/i.test(board.next)) {
    return "What's your name, and what day and time work — morning or afternoon?";
  }
  if (/what day and time/i.test(board.next)) {
    return "What day and time work for you, with AM or PM?";
  }
  if (/Ask their name/i.test(board.next)) {
    return "What's the name for the booking?";
  }
  if (/phone number or an email/i.test(board.next)) {
    return "What's the best phone number or email — one is enough, or you can tap ten digits on the keypad.";
  }
  if (/service address/i.test(board.next)) {
    return "What's the service address or zip?";
  }
  if (/service type/i.test(board.next)) {
    return "What kind of work do you need?";
  }
  if (/Ask only: phone/i.test(board.next)) {
    return "What's the best number to reach you?";
  }
  return board.next.replace(/^Ask (only: )?/, "").replace(/\.$/, "?");
}

export function applySpeakPolicy(input: {
  replyText: string;
  posted?: boolean;
  writable?: boolean;
  startIso?: string | null;
  allowHandoff?: boolean;
  board?: TalkerBoard;
}): string {
  let text = String(input.replyText || "").trim();
  if (!text) return text;
  if (!input.posted && speakClaimsBooked(text)) {
    text = input.writable
      ? "One moment while I write that down."
      : input.board
        ? collectSpeakTemplate(input.board, {
            confirmed: false,
            hasName: false,
            hasContact: false,
            slotReady: false,
            writable: false,
            scheduleable: false,
            transcript: "",
            startSpeak: formatConfirmDateFromIso(input.startIso) || undefined,
          })
        : "I still need a couple of details before I can book that.";
  }
  if (!input.allowHandoff && looksLikeHandoff(text)) {
    text = input.board ? collectSpeakTemplate(input.board, {
      confirmed: false,
      hasName: false,
      hasContact: false,
      slotReady: false,
      writable: !!input.writable,
      scheduleable: false,
      transcript: "",
    }) : "I can take care of that on this call. What day and time work for you?";
  }
  if (input.startIso) text = rewriteWeekdayOnlyConfirm(text, input.startIso);
  return text;
}

export function matchTransferProfile(
  utterance: string,
  profiles: TransferProfileLike[] | undefined,
): TransferProfileLike | undefined {
  if (!profiles?.length) return undefined;
  const u = String(utterance || "").toLowerCase();
  for (const profile of profiles) {
    const needles = [profile.id, profile.name, profile.holder, ...(profile.responsibilities || [])]
      .filter(Boolean)
      .map((s) => String(s).toLowerCase());
    if (needles.some((n) => n.length >= 3 && u.includes(n))) return profile;
  }
  if (looksLikeTransferRequest(utterance) && profiles.length === 1) return profiles[0];
  return undefined;
}

export function configuredPriceCentsFromItems(
  items: Array<{ price?: string | number }> | undefined,
): Set<number> {
  const allowed = new Set<number>();
  for (const item of items || []) {
    const match = /[\d,]+(?:\.\d{1,2})?/.exec(String(item.price || ""));
    if (!match) continue;
    const cents = Math.round(Number(match[0].replace(/,/g, "")) * 100);
    if (Number.isFinite(cents) && cents >= 0) allowed.add(cents);
  }
  return allowed;
}

export function matchPublishedPrice(
  utterance: string,
  items?: Array<{ name?: string; price?: string | number }>,
): { name: string; cents: number } | undefined {
  const u = String(utterance || "").toLowerCase();
  if (!u.trim() || !items?.length) return undefined;
  for (const item of items) {
    const name = String(item.name || "").trim();
    if (name.length < 3) continue;
    if (!u.includes(name.toLowerCase())) continue;
    const match = /[\d,]+(?:\.\d{1,2})?/.exec(String(item.price || ""));
    if (!match) continue;
    const cents = Math.round(Number(match[0].replace(/,/g, "")) * 100);
    if (Number.isFinite(cents) && cents >= 0) return { name, cents };
  }
  return undefined;
}

export function firstUnlistedQuoteCents(text: string, allowed: Set<number>): number | undefined {
  const amounts = [...String(text || "").matchAll(/\$\s*([\d,]+(?:\.\d{1,2})?)/g)]
    .map((match) => Math.round(Number(match[1].replace(/,/g, "")) * 100))
    .filter((value) => Number.isFinite(value) && value >= 0);
  const spoken = extractQuoteCents(text);
  if (typeof spoken === "number") amounts.push(spoken);
  return amounts.find((amount) => !allowed.has(amount));
}

export type ReceptionistTurnPlan = {
  intent: DeskIntent;
  slots: IntakeSlots;
  board: TalkerBoard;
  shop: ShopEvaluation;
  skipLlm: boolean;
  speak?: string;
  transferTo?: string;
  timeoutSecs?: number;
  writeBook: boolean;
  writeTask: boolean;
  afterHours: boolean;
};

export function planReceptionistTurn(input: {
  utterance: string;
  history: BoardTurn[];
  callerId?: string;
  dtmfPhone?: string | null;
  existing?: ExistingCaller;
  profile?: Partial<IntakeProfile> | null;
  tenantId?: string;
  playbook?: Partial<ShopPlaybook> | null;
  afterHours?: boolean;
  transfersAllowed?: boolean;
  transferProfiles?: TransferProfileLike[];
  posted?: boolean;
  pricingItems?: Array<{ name?: string; price?: string | number }>;
  now?: Date;
  quickReply?: string;
}): ReceptionistTurnPlan {
  const profile = normalizeIntakeProfile(input.profile, input.tenantId);
  const playbook = normalizeShopPlaybook(input.playbook);
  const intent = classifyDeskIntent(input.utterance, playbook);
  const slots = extractIntakeSlots({
    history: input.history,
    callerId: input.callerId,
    dtmfPhone: input.dtmfPhone,
    existingName: input.existing?.name,
    profile,
    tenantId: input.tenantId,
    now: input.now,
  });
  if (input.posted) {
    slots.writable = true;
  }
  const shop = evaluateShopAction(playbook, {
    intent:
      intent === "emergency"
        ? "emergency"
        : intent === "quote"
          ? "quote"
          : intent === "status"
            ? "service_issue"
            : intent === "book"
              ? "book"
              : "other",
    utterance: input.utterance,
    zip: slots.zip || extractZip(input.utterance),
    city: slots.city,
    quoteCents: extractQuoteCents(input.utterance),
    afterHours: input.afterHours,
    existingOpenJobs: input.existing?.openJobs?.length,
    membership: input.existing?.membership,
  });
  const board = buildTalkerBoard({
    profile,
    tenantId: input.tenantId,
    intent,
    name: slots.name,
    start: slots.start,
    startSpeak: slots.startSpeak,
    phone: slots.phone,
    email: slots.email,
    address: slots.address,
    zip: slots.zip,
    jobType: slots.jobType,
    writable: slots.writable,
    posted: input.posted,
    existingName: input.existing?.name,
    openJobs: input.existing?.openJobs?.map((j) => j.title || j.id || "").filter(Boolean).join(", "),
    membership: input.existing?.membership,
    afterHours: input.afterHours,
  });

  const plan: ReceptionistTurnPlan = {
    intent,
    slots,
    board,
    shop,
    skipLlm: false,
    writeBook: false,
    writeTask: false,
    afterHours: !!input.afterHours,
  };

  if (shop.decision === "refuse" || shop.decision === "hold" || shop.decision === "escalate") {
    plan.skipLlm = true;
    plan.speak = shop.speak;
    if (shop.decision === "escalate") {
      plan.transferTo = playbook.onCallE164 || playbook.humanOverflowE164;
      plan.timeoutSecs = playbook.onCallTimeoutSecs;
    }
    return plan;
  }

  if (intent === "faq") {
    if (input.quickReply) {
      plan.skipLlm = true;
      plan.speak = input.quickReply;
    }
    return plan;
  }

  if (intent === "transfer") {
    if (input.transfersAllowed) {
      const hit = matchTransferProfile(input.utterance, input.transferProfiles);
      if (hit) {
        plan.skipLlm = true;
        plan.speak = `I'll connect you with ${hit.holder || hit.name} now.`;
        plan.transferTo = hit.destination;
        plan.timeoutSecs = hit.timeoutSecs || playbook.onCallTimeoutSecs;
        return plan;
      }
    }
    plan.intent = "message";
    plan.skipLlm = !slots.hasName || !(slots.phone || input.callerId);
    plan.speak = plan.skipLlm
      ? "I can't transfer right now. I can take a message — what's your name and the best number?"
      : undefined;
    plan.writeTask = !plan.skipLlm;
    if (plan.writeTask) {
      plan.skipLlm = true;
      plan.speak = "I've written a task for the shop so this does not get lost.";
    }
    return plan;
  }

  if (intent === "message") {
    const haveCallback = !!(slots.phone || input.callerId);
    if (slots.hasName && haveCallback && slots.issue) {
      plan.skipLlm = true;
      plan.writeTask = true;
      plan.speak = "I've written a task for the shop so this does not get lost.";
      return plan;
    }
    plan.skipLlm = true;
    plan.speak = collectSpeakTemplate(
      { ...board, next: "Take a message: name, callback, and the issue." },
      slots,
    );
    if (!slots.hasName) plan.speak = "I can take a message. What's your name?";
    else if (!haveCallback) plan.speak = "What's the best number to call you back?";
    else plan.speak = "What should I pass along?";
    return plan;
  }

  if (intent === "status") {
    plan.skipLlm = true;
    if (input.existing?.openJobs?.length) {
      const titles = input.existing.openJobs.map((j) => j.title || j.id).filter(Boolean).join(", ");
      plan.speak = input.existing.name
        ? `${input.existing.name}, I see open work: ${titles}. I can page the shop if you need an update.`
        : `I see open work: ${titles}.`;
    } else if (input.existing?.name) {
      plan.speak = `Hi ${input.existing.name.split(" ")[0]}. I don't see an open job on file — how can I help?`;
    } else {
      plan.speak = "I don't see an open job on this number. How can I help?";
    }
    return plan;
  }

  if (intent === "quote") {
    const allowed = configuredPriceCentsFromItems(input.pricingItems);
    const quoted = extractQuoteCents(input.utterance);
    const listed = matchPublishedPrice(input.utterance, input.pricingItems);
    if (typeof quoted === "number" && allowed.size && !allowed.has(quoted)) {
      plan.skipLlm = true;
      plan.speak =
        "That price is not on the published shop list. I have held it for owner approval instead of quoting it.";
      return plan;
    }
    if (typeof quoted === "number" && allowed.has(quoted)) {
      plan.skipLlm = true;
      plan.speak = `That published price is $${(quoted / 100).toFixed(2)}.`;
      return plan;
    }
    if (listed) {
      plan.skipLlm = true;
      plan.speak = `The published price for ${listed.name} is $${(listed.cents / 100).toFixed(2)}.`;
      return plan;
    }
    plan.skipLlm = true;
    plan.speak =
      "I don't have a published price for that, so I will hold it for the owner instead of guessing.";
    return plan;
  }

  if (input.posted && slots.startSpeak) {
    plan.skipLlm = true;
    plan.speak = `You're booked for ${slots.startSpeak}.`;
    return plan;
  }

  if (slots.writable && (intent === "book" || intent === "other" || profile.kind === "demo")) {
    plan.skipLlm = true;
    plan.writeBook = true;
    plan.speak = "One moment while I write that down.";
    return plan;
  }

  const collectingDemo =
    profile.kind === "demo" &&
    (intent === "book" ||
      !!(slots.name || slots.start || slots.phone || slots.email));
  if (intent === "book" || collectingDemo) {
    plan.skipLlm = true;
    plan.speak = collectSpeakTemplate(board, slots);
    return plan;
  }

  if (input.quickReply) {
    plan.skipLlm = true;
    plan.speak = input.quickReply;
  }
  return plan;
}

export function greetingWithCallerName(baseGreeting: string, existingName?: string): string {
  const greeting = String(baseGreeting || "").trim() || "Hi! Thanks for calling. How can I help you today?";
  const first = String(existingName || "").trim().split(/\s+/)[0];
  if (!first || first.length < 2) return greeting;
  if (new RegExp(`\\b${first.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(greeting)) {
    return greeting;
  }
  return `Hi ${first}! ${greeting.replace(/^(hi|hello|hey)[!.]?\s+/i, "")}`;
}
