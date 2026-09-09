import { normalizeShopPlaybook } from "@veralux/shared";
import { getShopPlaybookRow, listOncallRotation } from "./db";
import { tenants } from "../tenants";

function localClock(
  now: Date,
  timezone: string,
): { weekday: number; hhmm: string } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const get = (type: string) =>
    parts.find((part) => part.type === type)?.value || "";
  const days: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };
  return {
    weekday: days[get("weekday")] ?? now.getUTCDay(),
    hhmm: `${get("hour") || "00"}:${get("minute") || "00"}`,
  };
}

export function rotationSlotMatches(
  row: Record<string, unknown>,
  weekday: number,
  hhmm: string,
): boolean {
  const rowDay = row.weekday == null ? null : Number(row.weekday);
  const start = String(row.start_hhmm || "00:00");
  const end = String(row.end_hhmm || "24:00");
  const overnight = start > end;
  if (rowDay == null) {
    return overnight ? hhmm >= start || hhmm < end : hhmm >= start && hhmm < end;
  }
  if (!overnight) {
    return rowDay === weekday && hhmm >= start && hhmm < end;
  }
  const previousDay = (weekday + 6) % 7;
  return (
    (rowDay === weekday && hhmm >= start) ||
    (rowDay === previousDay && hhmm < end)
  );
}

export async function resolveOnCallE164(tenantId: string, now = new Date()): Promise<{
  e164?: string;
  timeoutSecs: number;
  quietHours: boolean;
  source: "rotation" | "static" | "none";
}> {
  const row = await getShopPlaybookRow(tenantId);
  const playbook = normalizeShopPlaybook(row?.playbook);
  const rotation = await listOncallRotation(tenantId);
  const ctx = tenants.get(tenantId);
  const timezone =
    ctx?.businessHours &&
    typeof ctx.businessHours === "object" &&
    typeof (ctx.businessHours as { timezone?: unknown }).timezone === "string"
      ? String((ctx.businessHours as { timezone: string }).timezone)
      : "America/Los_Angeles";
  const { weekday, hhmm } = localClock(now, timezone);
  const slot = rotation.find((candidate) =>
    rotationSlotMatches(candidate, weekday, hhmm),
  );
  if (slot?.e164) {
    return {
      e164: slot.e164,
      timeoutSecs: playbook.onCallTimeoutSecs,
      quietHours: Boolean(slot.quiet_hours),
      source: "rotation",
    };
  }
  if (playbook.onCallE164) {
    return { e164: playbook.onCallE164, timeoutSecs: playbook.onCallTimeoutSecs, quietHours: false, source: "static" };
  }
  return { timeoutSecs: playbook.onCallTimeoutSecs, quietHours: false, source: "none" };
}
