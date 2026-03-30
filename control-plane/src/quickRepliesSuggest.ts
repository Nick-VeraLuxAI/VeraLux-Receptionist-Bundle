import { z } from "zod";
import { fetchWithTimeoutRetry } from "./httpClient";
import { quickReplyIntentSchema } from "./runtime/runtimeContract";

export const quickRepliesSuggestBodySchema = z.object({
  greetingText: z.string().optional(),
  systemPreamble: z.string().optional(),
  voicePrompt: z.string().optional(),
  policyPrompt: z.string().optional(),
  pricingItems: z
    .array(
      z.object({
        name: z.string(),
        price: z.string().optional(),
        description: z.string().optional(),
      }),
    )
    .optional(),
  pricingNotes: z.string().optional(),
  forwardingLines: z.array(z.string()).optional(),
  maxIntents: z.number().int().min(3).max(20).optional(),
});

export type QuickRepliesSuggestBody = z.infer<typeof quickRepliesSuggestBodySchema>;

function buildTenantBundle(body: QuickRepliesSuggestBody): string {
  const parts: string[] = [];
  if (body.greetingText?.trim()) parts.push(`Opening greeting:\n${body.greetingText.trim()}`);
  if (body.systemPreamble?.trim()) parts.push(`Business context:\n${body.systemPreamble.trim()}`);
  if (body.voicePrompt?.trim()) parts.push(`Tone:\n${body.voicePrompt.trim()}`);
  if (body.policyPrompt?.trim()) parts.push(`Policies / boundaries:\n${body.policyPrompt.trim()}`);
  if (body.pricingItems?.length) {
    const lines = body.pricingItems.map((i) => {
      const bits = [i.name, i.price, i.description].filter(Boolean);
      return bits.join(" — ");
    });
    parts.push(`Services / pricing items:\n${lines.join("\n")}`);
  }
  if (body.pricingNotes?.trim()) parts.push(`Pricing notes:\n${body.pricingNotes.trim()}`);
  if (body.forwardingLines?.length) parts.push(`Team / transfer contacts:\n${body.forwardingLines.join("\n")}`);
  return parts.length ? parts.join("\n\n---\n\n") : "(No tenant text provided — suggest generic receptionist quick replies.)";
}

const openAiEnvelopeSchema = z.object({
  quickReplies: z.array(z.unknown()),
});

/**
 * Calls OpenAI to propose quick-reply intents grounded in portal/tenant text.
 * Each suggestion is validated with quickReplyIntentSchema; invalid rows are dropped.
 */
export async function suggestQuickRepliesWithOpenAI(
  apiKey: string,
  model: string,
  body: QuickRepliesSuggestBody,
): Promise<{ quickReplies: z.infer<typeof quickReplyIntentSchema>[]; dropped: number }> {
  const maxIntents = body.maxIntents ?? 10;
  const bundle = buildTenantBundle(body);

  const systemPrompt = `You help configure an AI phone receptionist (PSTN). The product uses "quick replies": when the caller's transcript contains a phrase (case-insensitive substring), the system speaks a fixed reply WITHOUT calling the LLM — lower latency.

Return a single JSON object with key "quickReplies" (array). Each element must have:
- "id" (optional string, snake_case, for logs e.g. hours, pricing)
- "match": string array of natural phrases callers might say. EACH phrase must be at least 4 characters. Include a few variations per intent.
- "reply": string the receptionist will speak (concise, phone-friendly). Max 4000 characters.

Rules:
- Propose up to ${maxIntents} intents. Prioritize: hours/availability, what the business does, pricing/services, how to reach a human, location/service area ONLY if implied by the text, appointment booking.
- Ground answers in the tenant text. Do not invent specific addresses, prices, or phone numbers that are not in the tenant text; use cautious wording or say you will connect them if unknown.
- Replies should be speakable sentences, not bullet lists.
- Do not include intents that duplicate the same narrow topic unless clearly distinct.`;

  const userPrompt = `Tenant / business information:\n\n${bundle}\n\nProduce quickReplies JSON as specified.`;

  const resp = await fetchWithTimeoutRetry("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      max_tokens: 2500,
      temperature: 0.4,
      response_format: { type: "json_object" },
    }),
    timeoutMs: 45_000,
    retries: 1,
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`OpenAI error ${resp.status}: ${errText.slice(0, 500)}`);
  }

  const data = (await resp.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const raw = data.choices?.[0]?.message?.content?.trim() ?? "{}";
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("OpenAI returned non-JSON content");
  }

  const envelope = openAiEnvelopeSchema.safeParse(parsed);
  if (!envelope.success) {
    throw new Error("OpenAI JSON missing quickReplies array");
  }

  const valid: z.infer<typeof quickReplyIntentSchema>[] = [];
  let dropped = 0;
  for (const row of envelope.data.quickReplies) {
    const one = quickReplyIntentSchema.safeParse(row);
    if (one.success) valid.push(one.data);
    else dropped += 1;
  }

  return { quickReplies: valid.slice(0, maxIntents), dropped };
}
