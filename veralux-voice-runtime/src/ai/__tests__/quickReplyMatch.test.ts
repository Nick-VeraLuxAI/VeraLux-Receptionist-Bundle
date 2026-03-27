import assert from 'node:assert';
import { describe, it } from 'node:test';
import type { QuickReplyIntent } from '@veralux/shared';
import { matchQuickReply, normalizeUtterance } from '../quickReplyMatch';

describe('quickReplyMatch', () => {
  const intents: QuickReplyIntent[] = [
    {
      id: 'hours',
      match: ['what are your hours', 'office hours', 'when are you open'],
      reply: 'We are open Monday through Friday, nine to five.',
    },
    {
      id: 'parking',
      match: ['where do i park', 'parking lot'],
      reply: 'Visitor parking is in the rear lot.',
    },
  ];

  it('normalizes whitespace and case', () => {
    assert.strictEqual(normalizeUtterance('  Hello   World  '), 'hello world');
  });

  it('matches first intent when multiple phrases hit same utterance order', () => {
    const hit = matchQuickReply('Hey, what are your hours today?', intents);
    assert.strictEqual(hit?.intentId, 'hours');
    assert.ok(hit?.reply.includes('Monday'));
  });

  it('matches later intent when earlier does not', () => {
    const hit = matchQuickReply('Can you tell me where do I park?', intents);
    assert.strictEqual(hit?.intentId, 'parking');
  });

  it('returns null when no match', () => {
    assert.strictEqual(matchQuickReply('transfer me to billing', intents), null);
  });

  it('respects intent order (first matching intent wins)', () => {
    const stacked: QuickReplyIntent[] = [
      { id: 'first', match: ['help'], reply: 'A' },
      { id: 'second', match: ['need help'], reply: 'B' },
    ];
    const hit = matchQuickReply('I need help please', stacked);
    assert.strictEqual(hit?.intentId, 'first');
  });
});
