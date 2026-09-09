import assert from 'node:assert/strict';
import { test } from 'node:test';
import './testEnv';
import { applyShopSpeakGate } from '../src/calls/shopGate';

test('shop gate refuses out of area before speaking booked', () => {
  const r = applyShopSpeakGate({
    playbookRaw: { serviceArea: { zips: ['99201'], cities: [] } },
    userText: 'Can you come to 10001?',
    replyText: "I've booked you for Tuesday",
  });
  assert.equal(r.completion, 'refused');
  assert.match(r.text, /do not service/i);
});

test('shop gate pages emergencies and does not rewrite to a book-ask', () => {
  const r = applyShopSpeakGate({
    playbookRaw: { onCallE164: '+15095550100' },
    userText: 'I smell gas in the kitchen',
    replyText: "I'll have someone follow up tomorrow",
  });
  assert.equal(r.completion, 'on_call_paged');
  assert.equal(r.pageSms, true);
  assert.equal(r.transferTo, '+15095550100');
  assert.match(r.text, /paging/i);
});

test('shop gate auto-tasks empty promises', () => {
  const r = applyShopSpeakGate({
    playbookRaw: {},
    userText: 'just checking hours',
    replyText: "I'll have someone follow up tomorrow",
  });
  assert.equal(r.completion, 'tasked');
  assert.match(r.text, /task/i);
});
