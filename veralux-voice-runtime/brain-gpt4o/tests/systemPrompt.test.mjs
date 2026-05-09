import test from 'node:test';
import assert from 'node:assert/strict';
import { buildBrainSystemPrompt } from '../dist/systemPrompt.js';

test('system prompt includes tenant preamble and policy', () => {
  const s = buildBrainSystemPrompt(undefined, undefined, {
    systemPreamble: 'You work for Acme Dental.',
    policyPrompt: 'Never quote prices not in context.',
    voicePrompt: 'Speak calmly.',
  });
  assert.match(s, /Acme Dental/);
  assert.match(s, /Never quote prices/);
  assert.match(s, /Speak calmly/);
});

test('tenant A preamble does not appear when only tenant B prompts are passed', () => {
  const bOnly = buildBrainSystemPrompt(undefined, undefined, {
    systemPreamble: 'Tenant B only.',
  });
  assert.match(bOnly, /Tenant B only/);
  assert.doesNotMatch(bOnly, /Acme Dental/);
});

test('missing prompts fall back to base assistant instructions only', () => {
  const s = buildBrainSystemPrompt(undefined, undefined, undefined);
  assert.match(s, /phone assistant/);
  assert.doesNotMatch(s, /## Business identity/);
});

test('greeting framed as already played', () => {
  const s = buildBrainSystemPrompt(undefined, undefined, {
    greetingText: 'Hi, thanks for calling!',
  });
  assert.match(s, /already heard/);
  assert.match(s, /Hi, thanks for calling!/);
});
