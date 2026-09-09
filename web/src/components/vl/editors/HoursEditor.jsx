import React from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Clock, Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Field, InlineNote } from "@/components/vl/Cards";
import { Pill } from "@/components/vl/Pills";
import { QueryBoundary, CardSkeleton } from "@/components/vl/States";
import { errorMessage } from "@/lib/api";

const DAYS = [
  ["mon", "Monday"],
  ["tue", "Tuesday"],
  ["wed", "Wednesday"],
  ["thu", "Thursday"],
  ["fri", "Friday"],
  ["sat", "Saturday"],
  ["sun", "Sunday"],
];
const TIMEZONES = [
  "America/New_York", "America/Chicago", "America/Denver", "America/Phoenix", "America/Los_Angeles", "America/Anchorage", "Pacific/Honolulu",
  "America/Toronto", "America/Vancouver", "America/Mexico_City", "Europe/London", "Europe/Dublin", "Europe/Paris", "Europe/Berlin", "Europe/Madrid",
  "Europe/Rome", "Europe/Amsterdam", "Asia/Dubai", "Asia/Kolkata", "Asia/Singapore", "Asia/Tokyo", "Australia/Sydney", "UTC",
];

export const hoursPath = (mode, tenantId) => (mode === "portal" ? "/api/owner/business-hours" : `/api/admin/tenants/${tenantId}/business-hours`);

export const HoursEditor = ({ api, mode, tenantId, onSaved, readOnly = false, afterHoursLocked = false }) => {
  const q = useQuery({ queryKey: [mode, "hours", tenantId], queryFn: () => api.get(hoursPath(mode, tenantId)), enabled: !!tenantId });
  return (
    <QueryBoundary query={q} skeleton={<CardSkeleton lines={7} />}>
      {(data) => <HoursForm key={data.updatedAt || "init"} data={data} api={api} mode={mode} tenantId={tenantId} onSaved={onSaved} refetch={q.refetch} readOnly={readOnly} afterHoursLocked={afterHoursLocked} />}
    </QueryBoundary>
  );
};

function hoursState(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  const timezone = typeof src.timezone === "string" && src.timezone.trim() ? src.timezone.trim() : "America/Chicago";
  const weekly = src.weekly && typeof src.weekly === "object" ? src.weekly : {};
  return {
    timezone,
    weekly,
    afterHoursMessage: typeof src.afterHoursMessage === "string" ? src.afterHoursMessage : "",
  };
}

const HoursForm = ({ data, api, mode, tenantId, onSaved, refetch, readOnly = false, afterHoursLocked = false }) => {
  const [hours, setHours] = React.useState(() => hoursState(data.businessHours));
  const [saving, setSaving] = React.useState(false);
  const tzList = TIMEZONES.includes(hours.timezone) ? TIMEZONES : [hours.timezone, ...TIMEZONES].filter(Boolean);

  const setDay = (d, patch) => setHours((h) => ({ ...h, weekly: { ...h.weekly, [d]: patch } }));
  const save = async () => {
    setSaving(true);
    try {
      const res = await api.patch(hoursPath(mode, tenantId), { timezone: hours.timezone, weekly: hours.weekly, afterHoursMessage: hours.afterHoursMessage || "" });
      toast.success("Business hours saved", { description: res.published ? "Your receptionist is using the new hours." : "Saved. Publish to make them live." });
      onSaved && onSaved(res);
      refetch();
    } catch (e) {
      toast.error("Couldn't save hours", { description: errorMessage(e) });
    } finally {
      setSaving(false);
    }
  };

  const s = data.summary && typeof data.summary === "object" ? data.summary : {};
  const nextOpen = s.nextOpen && typeof s.nextOpen === "object" ? s.nextOpen : null;
  return (
    <div className="space-y-5" data-testid="hours-editor">
      <div className="flex flex-wrap items-center gap-3">
        <Pill tone={data.openNow ? "success" : "neutral"} icon={Clock} testId="open-now-pill">
          {data.openNow ? "Open now" : "Closed now"}
        </Pill>
        <span className="vl-meta">
          {data.openNow && s.closesAt ? `Closes at ${s.closesAt}` : nextOpen ? `Opens ${nextOpen.isToday ? "today" : nextOpen.day || "next"} at ${nextOpen.time || ""}` : s.text || ""}
          {s.localTime ? ` · Local time ${s.localTime} (${s.timezone})` : ""}
        </span>
      </div>

      <div className="grid gap-4 lg:grid-cols-[1fr_300px]">
        <div className="vl-card-soft divide-y divide-vl-border">
          {DAYS.map(([key, label]) => {
            const spec = hours.weekly?.[key] || { closed: true };
            const closed = !!spec.closed;
            return (
              <div key={key} className="flex flex-wrap items-center gap-3 px-4 py-3 vl-row" data-testid={`hours-row-${key}`}>
                <div className="w-[96px] text-[14px] font-medium">{label}</div>
                <div className="flex items-center gap-2">
                  <Switch id={`open-${key}`} checked={!closed} disabled={readOnly} onCheckedChange={(v) => setDay(key, v ? { open: spec.open || "09:00", close: spec.close || "17:00" } : { closed: true })} data-testid={`hours-toggle-${key}`} aria-label={`${label} open`} />
                  <label htmlFor={`open-${key}`} className="text-[13px] text-vl-secondary w-[52px]">
                    {closed ? "Closed" : "Open"}
                  </label>
                </div>
                {!closed ? (
                  <div className="flex items-center gap-2 ml-auto">
                    <Input type="time" value={spec.open || ""} disabled={readOnly} onChange={(e) => setDay(key, { ...spec, open: e.target.value })} className="h-9 w-[118px]" aria-label={`${label} opens at`} data-testid={`hours-open-${key}`} />
                    <span className="text-vl-muted text-[13px]">to</span>
                    <Input type="time" value={spec.close || ""} disabled={readOnly} onChange={(e) => setDay(key, { ...spec, close: e.target.value })} className="h-9 w-[118px]" aria-label={`${label} closes at`} data-testid={`hours-close-${key}`} />
                  </div>
                ) : (
                  <div className="ml-auto vl-meta">Receptionist plays the after-hours message</div>
                )}
              </div>
            );
          })}
        </div>
        <div className="space-y-4">
          <Field label="Timezone" htmlFor="tz">
            <Select value={hours.timezone} disabled={readOnly} onValueChange={(v) => setHours((h) => ({ ...h, timezone: v }))}>
              <SelectTrigger id="tz" data-testid="hours-timezone" disabled={readOnly}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {tzList.map((tz) => (
                  <SelectItem key={tz} value={tz}>
                    {tz.replace(/_/g, " ")}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label="After-hours message" htmlFor="ahm" hint={afterHoursLocked ? "After-hours mode is not included on this plan." : "What callers hear when you're closed."}>
            <Textarea id="ahm" rows={5} value={hours.afterHoursMessage || ""} disabled={readOnly || afterHoursLocked} onChange={(e) => setHours((h) => ({ ...h, afterHoursMessage: e.target.value }))} data-testid="hours-after-hours-message" />
          </Field>
        </div>
      </div>

      <div className="flex items-center justify-between gap-3">
        <InlineNote className="flex-1">Hours drive the "open now" state your receptionist uses when answering.</InlineNote>
        <Button onClick={save} disabled={saving || readOnly} data-testid="hours-save-button">
          <Save className="h-4 w-4" /> {saving ? "Saving…" : readOnly ? "Read-only" : "Save hours"}
        </Button>
      </div>
    </div>
  );
};
