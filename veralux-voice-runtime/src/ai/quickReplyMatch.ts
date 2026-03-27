import type { QuickReplyIntent } from '@veralux/shared';

/** Lowercase, trim, collapse internal whitespace (STT-friendly). */
export function normalizeUtterance(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, ' ');
}

export type QuickReplyHit = { reply: string; intentId?: string };

/**
 * First intent in the list wins. Within an intent, the first matching phrase wins.
 * Match is substring on normalized text (case-insensitive).
 */
export function matchQuickReply(
  transcript: string,
  intents: QuickReplyIntent[],
): QuickReplyHit | null {
  if (!intents.length) return null;
  const norm = normalizeUtterance(transcript);
  if (!norm) return null;

  for (const intent of intents) {
    for (const phrase of intent.match) {
      const p = normalizeUtterance(phrase);
      if (p.length < 4) continue;
      if (norm.includes(p)) {
        const reply = intent.reply.trim();
        if (!reply) continue;
        return { reply, intentId: intent.id };
      }
    }
  }
  return null;
}
