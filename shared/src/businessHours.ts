import { z } from "zod";

/** One-letter keys aligned with `Intl` weekday ordering (Monday = 0 in our weekly map). */
export const BUSINESS_DAY_KEYS = [
  "mon",
  "tue",
  "wed",
  "thu",
  "fri",
  "sat",
  "sun",
] as const;

export type BusinessDayKey = (typeof BUSINESS_DAY_KEYS)[number];

const dayHoursSchema = z.union([
  z.object({ closed: z.literal(true) }),
  z.object({
    open: z.string().min(1).max(8),
    close: z.string().min(1).max(8),
  }),
]);

export const businessHoursSchema = z.object({
  timezone: z.string().min(1).max(120),
  weekly: z.object({
    mon: dayHoursSchema.optional(),
    tue: dayHoursSchema.optional(),
    wed: dayHoursSchema.optional(),
    thu: dayHoursSchema.optional(),
    fri: dayHoursSchema.optional(),
    sat: dayHoursSchema.optional(),
    sun: dayHoursSchema.optional(),
  }),
  afterHoursMessage: z.string().max(4000).optional(),
});

export type BusinessHoursConfig = z.infer<typeof businessHoursSchema>;

const WEEKDAY_TO_KEY: Record<string, BusinessDayKey> = {
  monday: "mon",
  tuesday: "tue",
  wednesday: "wed",
  thursday: "thu",
  friday: "fri",
  saturday: "sat",
  sunday: "sun",
};

function timeToMinutes(t: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(t.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (!Number.isFinite(h) || !Number.isFinite(min) || h > 23 || min > 59) return null;
  return h * 60 + min;
}

function currentDayKeyInZone(now: Date, timeZone: string): BusinessDayKey | null {
  try {
    const wd = new Intl.DateTimeFormat("en-US", {
      timeZone,
      weekday: "long",
    })
      .format(now)
      .toLowerCase();
    return WEEKDAY_TO_KEY[wd] ?? null;
  } catch {
    return null;
  }
}

function currentHmInZone(now: Date, timeZone: string): string | null {
  try {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).formatToParts(now);
    const h = parts.find((p) => p.type === "hour")?.value;
    const m = parts.find((p) => p.type === "minute")?.value;
    if (h == null || m == null) return null;
    return `${h.padStart(2, "0")}:${m.padStart(2, "0")}`;
  } catch {
    return null;
  }
}

function dayLabel(k: BusinessDayKey): string {
  const labels: Record<BusinessDayKey, string> = {
    mon: "Mon",
    tue: "Tue",
    wed: "Wed",
    thu: "Thu",
    fri: "Fri",
    sat: "Sat",
    sun: "Sun",
  };
  return labels[k];
}

function describeDay(day?: z.infer<typeof dayHoursSchema>): string {
  if (!day) return "closed";
  if ("closed" in day && day.closed) return "closed";
  if ("open" in day && "close" in day) return `${day.open}–${day.close}`;
  return "closed";
}

/**
 * Evaluates weekly hours for a tenant timezone. Same-day windows only (no overnight spans).
 */
export function evaluateBusinessHours(
  raw: unknown,
  now = new Date(),
): { isOpen: boolean; summary: string; afterHoursMessage?: string; timezone?: string } {
  const parsed = businessHoursSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      isOpen: false,
      summary: "Business hours not configured or invalid.",
    };
  }
  const cfg = parsed.data;
  const lines: string[] = [];
  for (const k of BUSINESS_DAY_KEYS) {
    lines.push(`${dayLabel(k)}: ${describeDay(cfg.weekly[k])}`);
  }
  const summary = [`Timezone: ${cfg.timezone}`, ...lines].join("\n");

  const dayKey = currentDayKeyInZone(now, cfg.timezone);
  const hm = currentHmInZone(now, cfg.timezone);
  if (!dayKey || !hm) {
    return {
      isOpen: false,
      summary,
      afterHoursMessage: cfg.afterHoursMessage,
      timezone: cfg.timezone,
    };
  }

  const day = cfg.weekly[dayKey];
  if (!day || ("closed" in day && day.closed)) {
    return {
      isOpen: false,
      summary,
      afterHoursMessage: cfg.afterHoursMessage,
      timezone: cfg.timezone,
    };
  }

  if (!("open" in day) || !("close" in day)) {
    return {
      isOpen: false,
      summary,
      afterHoursMessage: cfg.afterHoursMessage,
      timezone: cfg.timezone,
    };
  }

  const o = timeToMinutes(day.open);
  const c = timeToMinutes(day.close);
  const n = timeToMinutes(hm);
  if (o == null || c == null || n == null) {
    return {
      isOpen: false,
      summary,
      afterHoursMessage: cfg.afterHoursMessage,
      timezone: cfg.timezone,
    };
  }

  const isOpen = n >= o && n <= c;
  return {
    isOpen,
    summary,
    afterHoursMessage: cfg.afterHoursMessage,
    timezone: cfg.timezone,
  };
}

/** True when at least one weekday entry exists in the weekly map. */
export function hasTenantBusinessSchedule(cfg: BusinessHoursConfig): boolean {
  return BUSINESS_DAY_KEYS.some((k) => cfg.weekly[k] !== undefined);
}

function formatHmToVoice(hm: string): string {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hm.trim());
  if (!m) return hm.trim();
  let h = Number(m[1]);
  const min = Number(m[2]);
  if (!Number.isFinite(h) || !Number.isFinite(min)) return hm.trim();
  const suffix = h >= 12 ? "PM" : "AM";
  h = h % 12;
  if (h === 0) h = 12;
  const minPart = min === 0 ? "" : `:${String(min).padStart(2, "0")}`;
  return `${h}${minPart} ${suffix}`;
}

function dayLongLabel(k: BusinessDayKey): string {
  const labels: Record<BusinessDayKey, string> = {
    mon: "Monday",
    tue: "Tuesday",
    wed: "Wednesday",
    thu: "Thursday",
    fri: "Friday",
    sat: "Saturday",
    sun: "Sunday",
  };
  return labels[k];
}

function describeDayVoice(day?: z.infer<typeof dayHoursSchema>): string {
  if (!day) return "closed";
  if ("closed" in day && day.closed) return "closed";
  if ("open" in day && "close" in day) {
    return `${formatHmToVoice(day.open)} to ${formatHmToVoice(day.close)}`;
  }
  return "closed";
}

function wantsHoursIntent(t: string): boolean {
  return (
    t.includes("hour") ||
    t.includes("open") ||
    t.includes("close") ||
    t.includes("closing") ||
    t.includes("shut") ||
    t.includes("when are you") ||
    t.includes("what time") ||
    t.includes("schedule") ||
    t.includes("operating") ||
    /(^|\s)are you open(\?|\s|$)/.test(t) ||
    /(^|\s)are you closed(\?|\s|$)/.test(t)
  );
}

function wantsCloseIntent(t: string): boolean {
  return (
    t.includes("close") ||
    t.includes("closing") ||
    t.includes("shut") ||
    (t.includes("what time") && t.includes("close"))
  );
}

function wantsOpenIntent(t: string): boolean {
  if (wantsCloseIntent(t)) return false;
  return (
    t.includes("when do you open") ||
    t.includes("when are you open") ||
    (t.includes("what time") && t.includes("open")) ||
    (t.includes("opening") && (t.includes("when") || t.includes("what time")))
  );
}

function wantsStatusIntent(t: string): boolean {
  return /(^|\s)are you open(\?|\s|$)/.test(t) || /(^|\s)are you closed(\?|\s|$)/.test(t);
}

function clipAfterHours(msg: string, max = 200): string {
  const s = msg.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "").trim();
  if (!s) return "";
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

function monFriUniformVoice(cfg: BusinessHoursConfig): string | null {
  const mon = cfg.weekly.mon;
  const tue = cfg.weekly.tue;
  const wed = cfg.weekly.wed;
  const thu = cfg.weekly.thu;
  const fri = cfg.weekly.fri;
  const days = [mon, tue, wed, thu, fri];
  if (days.some((d) => d === undefined)) return null;
  const voice = describeDayVoice(mon);
  if (voice === "closed") return null;
  for (const d of [tue, wed, thu, fri]) {
    if (describeDayVoice(d) !== voice) return null;
  }
  const sat = cfg.weekly.sat;
  const sun = cfg.weekly.sun;
  const satC = describeDayVoice(sat);
  const sunC = describeDayVoice(sun);
  const weekendClosed =
    (sat === undefined || satC === "closed") && (sun === undefined || sunC === "closed");
  if (!weekendClosed) return null;
  return `We're open Monday through Friday, ${voice}. We're closed Saturday and Sunday.`;
}

function weeklySummaryVoice(cfg: BusinessHoursConfig): string {
  const compact = monFriUniformVoice(cfg);
  if (compact) return compact;
  const parts: string[] = [];
  for (const k of BUSINESS_DAY_KEYS) {
    const line = `${dayLongLabel(k)}: ${describeDayVoice(cfg.weekly[k])}`;
    parts.push(line);
  }
  const joined = parts.join(" ");
  return joined.length > 360 ? `${joined.slice(0, 357)}…` : joined;
}

/**
 * Deterministic, voice-friendly answer from structured tenant business hours.
 * Returns null when config is missing/invalid, no schedule is defined, or the
 * utterance is not hours-related (caller may be asking about something else).
 */
export function voiceReplyFromBusinessHours(
  transcript: string,
  raw: unknown,
  now = new Date(),
): string | null {
  const t = transcript.trim().toLowerCase();
  if (!t) return null;
  if (!wantsHoursIntent(t)) return null;

  const parsed = businessHoursSchema.safeParse(raw);
  if (!parsed.success || !hasTenantBusinessSchedule(parsed.data)) return null;

  const cfg = parsed.data;
  const ev = evaluateBusinessHours(cfg, now);
  const dayKey = currentDayKeyInZone(now, cfg.timezone);
  const hm = currentHmInZone(now, cfg.timezone);
  const day = dayKey ? cfg.weekly[dayKey] : undefined;
  const ah = cfg.afterHoursMessage?.trim() ? clipAfterHours(cfg.afterHoursMessage) : "";

  if (wantsStatusIntent(t)) {
    if (ev.isOpen) {
      return "Yes — we're open right now.";
    }
    const base = "We're closed right now.";
    return ah ? `${base} ${ah}` : base;
  }

  const todayClosed =
    !dayKey ||
    !day ||
    ("closed" in day && day.closed) ||
    !("open" in day && "close" in day);

  if (wantsCloseIntent(t)) {
    if (todayClosed) {
      const base = "We're closed today.";
      return ah ? `${base} ${ah}` : base;
    }
    const d = day as { open: string; close: string };
    const closeV = formatHmToVoice(d.close);
    return `We close at ${closeV} today.`;
  }

  if (wantsOpenIntent(t)) {
    if (todayClosed) {
      const base = "We're closed today.";
      return ah ? `${base} ${ah}` : base;
    }
    const d = day as { open: string; close: string };
    const openV = formatHmToVoice(d.open);
    return `We open at ${openV} today.`;
  }

  // General hours / schedule / "when are you" without open/close specificity
  const weekly = weeklySummaryVoice(cfg);
  if (ah && !ev.isOpen) {
    return `${weekly} ${ah}`;
  }
  return weekly;
}
