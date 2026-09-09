import React from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { CheckCircle2, Circle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PageHeader, Card, CardHeader, InlineNote } from "@/components/vl/Cards";
import { QueryBoundary, CardSkeleton } from "@/components/vl/States";
import { errorMessage } from "@/lib/api";
import { useAdmin } from "../AdminApp";

const LABELS = {
  did_inbound: "DID inbound rings this tenant",
  hours_published: "Hours published",
  playbook_published: "Shop playbook published",
  oncall_sms: "On-call SMS received",
  refuse_out_of_area: "Refuse out-of-area test call",
  book_or_hold: "Book-or-hold test",
  test_call: "Scripted test call",
  faq_hours: "Day desk: hours/FAQ answer",
  transfer_or_message: "Day desk: transfer or take a message",
  existing_cid: "Existing customer CID greet",
  quote_or_hold: "Quote list price or hold",
};

export default function Cutover() {
  const { api, tenantId } = useAdmin();
  const q = useQuery({ queryKey: ["cutover", tenantId], queryFn: () => api.get("/api/admin/cutover"), enabled: !!tenantId });
  const toggle = async (id, passed) => {
    try {
      await api.put(`/api/admin/cutover/${id}`, { passed });
      toast.success(passed ? "Marked passed" : "Marked incomplete");
      q.refetch();
    } catch (e) {
      toast.error("Couldn't update cutover", { description: errorMessage(e) });
    }
  };
  return (
    <div data-testid="admin-cutover-page">
      <PageHeader serif={false} eyebrow="Selected tenant" title="Cutover checklist" subtitle="You are live only after every item passes." />
      <QueryBoundary query={q} skeleton={<CardSkeleton lines={7} />}>
        {(data) => (
          <Card>
            <CardHeader title={data.live ? "Night desk is live" : "Not live yet"} />
            {data.live ? <InlineNote>All cutover tests passed. Go-live is gated on.</InlineNote> : <InlineNote>Complete every row before telling the shop they are live.</InlineNote>}
            <ul className="mt-4 space-y-2">
              {(data.items || []).map((it) => (
                <li key={it.id} className="flex items-center gap-3 rounded-[2px] border border-vl-border px-3 py-2" data-testid={`cutover-${it.id}`}>
                  {it.passed ? <CheckCircle2 className="h-4 w-4 text-vl-gold" /> : <Circle className="h-4 w-4 text-vl-muted" />}
                  <span className="flex-1 text-[14px]">{LABELS[it.id] || it.id}</span>
                  <Button size="sm" variant="outline" onClick={() => toggle(it.id, !it.passed)}>{it.passed ? "Undo" : "Pass"}</Button>
                </li>
              ))}
            </ul>
          </Card>
        )}
      </QueryBoundary>
    </div>
  );
}
