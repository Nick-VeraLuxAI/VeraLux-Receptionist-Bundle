import type { AssistantContext, TenantPromptsPayload, TransferProfile } from './types.js';

const MAX_SECTION = 12_000;

function clip(s: string | undefined): string {
  if (!s) return '';
  const t = s.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '').trim();
  if (!t) return '';
  return t.length > MAX_SECTION ? t.slice(0, MAX_SECTION) : t;
}

/**
 * Composes the system message for the reference brain from tenant prompts,
 * business context, and transfer profiles. Blank prompt fields are ignored.
 * `greetingText` is framed as the opening line already played to the caller —
 * not something to repeat every turn unless relevant.
 */
export function buildBrainSystemPrompt(
  transferProfiles: TransferProfile[] | undefined,
  assistantContext: AssistantContext | undefined,
  prompts: TenantPromptsPayload | undefined,
): string {
  let prompt = `You are a helpful, concise phone assistant. Keep replies short and natural for voice (1–3 sentences). Be warm and professional.`;

  const p = prompts || {};
  const pre = clip(p.systemPreamble);
  const pol = clip(p.policyPrompt);
  const voice = clip(p.voicePrompt);
  const schema = clip(p.schemaHint);
  const greet = clip(p.greetingText);

  if (pre) {
    prompt += `\n\n## Business identity & role\n${pre}`;
  }
  if (pol) {
    prompt += `\n\n## Policies & guardrails\n${pol}`;
  }
  if (voice) {
    prompt += `\n\n## Voice & delivery\n${voice}`;
  }
  if (schema) {
    prompt += `\n\n## Structured output hints (when applicable)\n${schema}`;
  }
  if (greet) {
    prompt += `\n\n## Opening greeting (already played)\nThe caller already heard this greeting when the call connected. Stay consistent with its tone and facts, but do not repeat it verbatim on every reply unless the caller asks about it or you are explicitly confirming the same welcome.\nGreeting was:\n${greet}`;
  }

  if (assistantContext && Object.keys(assistantContext).length > 0) {
    prompt += `\n\n## Reference information for answers\nUse the following when the caller asks about these topics. Prefer facts from here over guessing:\n\n`;
    for (const [section, text] of Object.entries(assistantContext)) {
      const body = clip(text);
      if (body) {
        prompt += `${section}:\n${body}\n\n`;
      }
    }
  }

  if (transferProfiles?.length) {
    prompt += `You can transfer the caller to a person or department. When the caller asks to speak to someone, or their need matches a department below, use the transfer_call tool with that profile's destination number and a brief message to the caller (e.g. "I'll connect you with Morgan in Sales now.").

Transfer options (use the exact \`destination\` value when calling transfer_call):
${transferProfiles
  .map(
    (p) =>
      `- ${p.name}${p.holder ? ` (${p.holder})` : ''}: handles ${p.responsibilities.join(', ')}. destination: ${p.destination}`,
  )
  .join('\n')}

Only use transfer_call when the caller clearly wants to be transferred or their request matches one of the above. Otherwise just answer in your normal voice.`;
  }

  return prompt;
}
