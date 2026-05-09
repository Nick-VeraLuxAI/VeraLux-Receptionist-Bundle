import assert from 'node:assert/strict';
import { test } from 'node:test';
import { matchAssistantEcho } from '../src/stt/assistantEcho';
import './testEnv';

test('identical to last assistant line is echo (balanced)', () => {
  const r = matchAssistantEcho(
    'Your appointment is confirmed for Tuesday.',
    ['Your appointment is confirmed for Tuesday.'],
    'balanced',
  );
  assert.equal(r.isAssistantEcho, true);
  assert.equal(r.method, 'identical');
});

test('legitimate caller response after playback is not echo', () => {
  const r = matchAssistantEcho(
    'I need to reschedule because my kid is sick and I cannot make Tuesday anymore.',
    ['Your appointment is confirmed for Tuesday.'],
    'balanced',
  );
  assert.equal(r.isAssistantEcho, false);
});

test('mostly assistant wording with tiny variation — conservative rejects, permissive may allow', () => {
  const assistant = 'Thanks for calling VeraLux, how can I help you today?';
  const user = 'Thanks for calling VeraLux how can I help you today';
  const cons = matchAssistantEcho(user, [assistant], 'conservative');
  assert.equal(cons.isAssistantEcho, true);
  const perm = matchAssistantEcho(user, [assistant], 'permissive');
  assert.equal(perm.isAssistantEcho, true);
});

test('substring of assistant reply is echo (balanced)', () => {
  const r = matchAssistantEcho(
    'Please hold while we connect you.',
    ['Please hold while we connect you to sales.'],
    'balanced',
  );
  assert.equal(r.isAssistantEcho, true);
});

test('near-duplicate of assistant line is echo in both conservative and permissive', () => {
  const candidates = ['We can ship that overnight for an extra fee.'];
  const user = 'We can ship that overnight for an extra fee';
  assert.equal(matchAssistantEcho(user, candidates, 'conservative').isAssistantEcho, true);
  assert.equal(matchAssistantEcho(user, candidates, 'permissive').isAssistantEcho, true);
});
