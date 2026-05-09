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
