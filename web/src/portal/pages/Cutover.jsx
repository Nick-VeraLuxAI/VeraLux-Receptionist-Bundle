import React from "react";
import { useQuery } from "@tanstack/react-query";
import { CheckCircle2, Circle } from "lucide-react";
import { PageHeader, Card, CardHeader, InlineNote } from "@/components/vl/Cards";
import { QueryBoundary, CardSkeleton } from "@/components/vl/States";
import { usePortal } from "../PortalApp";

const LABELS = {
  did_inbound: "Your number rings the night desk",
  hours_published: "Hours are live",
  playbook_published: "Shop rules are live",
  oncall_sms: "On-call text received",
  refuse_out_of_area: "Out-of-area refuse proven",
  book_or_hold: "Book or hold proven",
  test_call: "Test call completed",
  faq_hours: "Hours and FAQ answers",
  transfer_or_message: "Transfer or take a message",
  existing_cid: "Known-caller greeting",
  quote_or_hold: "Published price or hold",
};

export default function Cutover() {
  const { api, tenantId } = usePortal();
  const q = useQuery({ queryKey: ["portal", "cutover", tenantId], queryFn: () => api.get("/api/admin/cutover"), enabled: !!tenantId });
  return (
    <div data-testid="portal-cutover-page">
      <PageHeader eyebrow="Install pack" title="Go-live checklist" subtitle="VeraLux marks these after scripted tests. You are not live until every box is checked." />
      <QueryBoundary query={q} skeleton={<CardSkeleton lines={7} />}>
        {(data) => (
          <Card>
            <CardHeader title={data.live ? "You are live" : "Not live yet"} />
            <InlineNote>{data.live ? "The night desk is in production." : "Your installer still has tests to pass."}</InlineNote>
            <ul className="mt-4 space-y-2">
              {(data.items || []).map((it) => (
                <li key={it.id} className="flex items-center gap-3 text-[14px]">
                  {it.passed ? <CheckCircle2 className="h-4 w-4 text-vl-gold" /> : <Circle className="h-4 w-4 text-vl-muted" />}
                  {LABELS[it.id] || it.id}
                </li>
              ))}
            </ul>
          </Card>
        )}
      </QueryBoundary>
    </div>
  );
}
