import { createHash } from "crypto";
import { tenants } from "../tenants";
import {
  getShopPlaybookRow,
  claimDigestDelivery,
  listCompletionsForLocalDate,
  recordDigestDelivery,
} from "./db";
import { sendNightDeskEmail } from "./email";
import { sendNightDeskSms } from "./sms";

let timer: NodeJS.Timeout | null = null;

function clockInTz(tz: string): { hour: number; ymd: string } {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: tz || "America/Los_Angeles",
      hour: "numeric",
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(new Date());
    const get = (t: string) => parts.find((p) => p.type === t)?.value || "0";
    return { hour: Number(get("hour")), ymd: `${get("year")}-${get("month")}-${get("day")}` };
  } catch {
    const d = new Date();
    return { hour: d.getHours(), ymd: d.toISOString().slice(0, 10) };
  }
}

function previousDate(ymd: string): string {
  const date = new Date(`${ymd}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

function destinationHash(destination: string): string {
  return createHash("sha256").update(destination).digest("hex");
}

export async function buildMorningDigest(
  tenantId: string,
  localDate?: string,
) {
  const ctx = tenants.get(tenantId);
  const timezone =
    ctx?.businessHours &&
    typeof ctx.businessHours === "object" &&
    typeof (ctx.businessHours as { timezone?: unknown }).timezone === "string"
      ? String((ctx.businessHours as { timezone: string }).timezone)
      : "America/Los_Angeles";
  const today = clockInTz(timezone).ymd;
  const date = localDate || previousDate(today);
  const rows = await listCompletionsForLocalDate(tenantId, timezone, date);
  const byCompletion: Record<string, number> = {};
  let bookedCents = 0;
  let orphans = 0;
  let preventedPromises = 0;
  for (const row of rows) {
    byCompletion[row.completion] =
      (byCompletion[row.completion] || 0) + 1;
    bookedCents += Number(row.booked_cents || 0);
    if (row.orphan_promise) orphans += 1;
    if (String(row.reason || "").includes("empty_promise")) {
      preventedPromises += 1;
    }
  }
  const portalBase = String(
    process.env.OWNER_PORTAL_URL ||
      process.env.CONTROL_PLANE_PUBLIC_URL ||
      process.env.PUBLIC_CONTROL_PLANE_URL ||
      process.env.VERALUX_DEPLOYMENT_PUBLIC_URL ||
      "",
  ).replace(/\/+$/, "");
  const callsUrl = portalBase
    ? `${portalBase}/portal/calls`
    : "/portal/calls";
  const metrics = {
    total: rows.length,
    byCompletion,
    bookedCents,
    orphans,
    preventedPromises,
  };
  const text = [
    `VeraLux night desk — ${date}`,
    `${rows.length} completed calls · $${(bookedCents / 100).toFixed(
      2,
    )} booked`,
    `${byCompletion.booked || 0} booked · ${
      byCompletion.approval_held || 0
    } held · ${byCompletion.on_call_paged || 0} paged · ${
      byCompletion.tasked || 0
    } tasked · ${byCompletion.refused || 0} refused`,
    `Orphan promises: ${orphans}`,
    `Empty promises converted to tasks: ${preventedPromises}`,
    `Review calls: ${callsUrl}`,
  ].join("\n");
  return { tenantId, timezone, localDate: date, metrics, rows, text, callsUrl };
}

export async function sendMorningDigest(
  tenantId: string,
  options: { force?: boolean; localDate?: string } = {},
): Promise<{
  sent: boolean;
  text: string;
  localDate: string;
  deliveries: Array<{ channel: "sms" | "email"; sent: boolean }>;
}> {
  const digest = await buildMorningDigest(tenantId, options.localDate);
  const playbook = await getShopPlaybookRow(tenantId);
  const smsTo =
    playbook?.playbook.digest.smsE164 ||
    playbook?.playbook.onCallE164 ||
    "";
  const emails = playbook?.playbook.digest.emails || [];
  const deliveries: Array<{
    channel: "sms" | "email";
    sent: boolean;
  }> = [];
  if (smsTo) {
    const hash = destinationHash(smsTo);
    const claimed = await claimDigestDelivery({
      tenantId,
      localDate: digest.localDate,
      channel: "sms",
      destinationHash: hash,
      force: options.force,
    });
    if (claimed) {
      const sent = await sendNightDeskSms(
        smsTo,
        digest.text,
        tenantId,
      );
      await recordDigestDelivery({
        tenantId,
        localDate: digest.localDate,
        channel: "sms",
        destinationHash: hash,
        status: sent ? "sent" : "failed",
      });
      deliveries.push({ channel: "sms", sent });
    }
  }
  for (const email of emails) {
    const hash = destinationHash(email);
    const claimed = await claimDigestDelivery({
      tenantId,
      localDate: digest.localDate,
      channel: "email",
      destinationHash: hash,
      force: options.force,
    });
    if (!claimed) continue;
    const sent = await sendNightDeskEmail({
      to: email,
      subject: `VeraLux night desk — ${digest.localDate}`,
      text: digest.text,
    });
    await recordDigestDelivery({
      tenantId,
      localDate: digest.localDate,
      channel: "email",
      destinationHash: hash,
      status: sent ? "sent" : "failed",
    });
    deliveries.push({ channel: "email", sent });
  }
  return {
    sent: deliveries.some((delivery) => delivery.sent),
    text: digest.text,
    localDate: digest.localDate,
    deliveries,
  };
}

export async function tickMorningDigests(): Promise<void> {
  for (const meta of tenants.listMetas()) {
    const ctx = tenants.get(meta.id);
    const tz =
      ctx && ctx.businessHours && typeof ctx.businessHours === "object"
        ? String((ctx.businessHours as { timezone?: string }).timezone || "America/Los_Angeles")
        : "America/Los_Angeles";
    const { hour } = clockInTz(tz);
    if (hour !== 7) continue;
    try {
      await sendMorningDigest(meta.id);
    } catch (error) {
      console.error(
        `[digest] tenant ${meta.id} failed`,
        error instanceof Error ? error.message : error,
      );
    }
  }
}

export function startMorningDigestLoop(): void {
  if (timer) return;
  timer = setInterval(() => {
    void tickMorningDigests().catch((err) => console.error("[digest] tick failed", err));
  }, 60_000);
  timer.unref?.();
}

export function stopMorningDigestLoop(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
