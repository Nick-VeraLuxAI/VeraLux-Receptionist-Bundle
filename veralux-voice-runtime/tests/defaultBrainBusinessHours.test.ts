import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTestEnv } from './testEnv';
import { defaultBrainReply } from '../src/ai/defaultBrain';
import { generateAssistantReply } from '../src/ai/brainClient';
import { resolveLlmExecutionPlan } from '../src/ai/llmProviderResolve';
import type { RuntimeTenantConfig } from '@veralux/shared';

setTestEnv();

const sampleBh = {
  timezone: 'UTC',
  weekly: {
    mon: { open: '10:00', close: '18:00' },
    tue: { open: '10:00', close: '18:00' },
    wed: { open: '10:00', close: '18:00' },
    thu: { open: '10:00', close: '18:00' },
    fri: { open: '10:00', close: '18:00' },
    sat: { closed: true as const },
    sun: { closed: true as const },
  },
};

test('defaultBrainReply uses structured llmContext.businessHours for close questions', () => {
  const ref = new Date('2026-05-11T12:00:00Z');
  const text = defaultBrainReply({
    transcript: 'When do you close?',
    tenantId: 'tenant_a',
    businessHours: sampleBh,
    referenceTime: ref,
    assistantContext: {
      hours:
        "We're open Monday through Friday, 9 AM to 5 PM Eastern. Closed weekends.",
    },
  });
  assert.match(text, /close at 6 PM|close at 18:00/i);
  assert.doesNotMatch(text, /9 AM to 5 PM Eastern/);
});

test('defaultBrainReply falls back when no businessHours configured', () => {
  const text = defaultBrainReply({
    transcript: 'When do you close?',
    tenantId: 'tenant_x',
    businessHours: undefined,
  });
  assert.match(text, /close at 6 PM/i);
});

test('tenant A businessHours do not appear in tenant B reply', () => {
  const ref = new Date('2026-05-11T10:00:00Z');
  const a = defaultBrainReply({
    transcript: 'When do you close?',
    tenantId: 'a',
    businessHours: sampleBh,
    referenceTime: ref,
  });
  const b = defaultBrainReply({
    transcript: 'When do you close?',
    tenantId: 'b',
    referenceTime: ref,
    businessHours: {
      timezone: 'UTC',
      weekly: {
        mon: { open: '08:00', close: '12:00' },
        tue: { closed: true as const },
        wed: { closed: true as const },
        thu: { closed: true as const },
        fri: { closed: true as const },
        sat: { closed: true as const },
        sun: { closed: true as const },
      },
    },
  });
  assert.notEqual(a, b);
});

test('generateAssistantReply stays on brain_local when PLATFORM_LLM_PROVIDER=brain_local and BRAIN_URL set', async () => {
  process.env.PLATFORM_LLM_PROVIDER = 'brain_local';
  process.env.BRAIN_URL = 'http://brain:3001';
  const ref = new Date('2026-05-11T14:00:00Z');
  const cfg = {
    contractVersion: 'v1' as const,
    tenantId: 't1',
    dids: ['+15551234567'],
    llmContext: {
      forwardingProfiles: [],
      pricing: { items: [], notes: '' },
      prompts: {
        systemPreamble: 's',
        schemaHint: 'h',
        policyPrompt: 'p',
        voicePrompt: 'v',
      },
      businessHours: sampleBh,
    },
  } as unknown as RuntimeTenantConfig;
  const plan = await resolveLlmExecutionPlan({ tenantId: 't1', tenantConfig: cfg });
  assert.equal(plan.route, 'brain_local');
  const reply = await generateAssistantReply({
    tenantId: 't1',
    tenantConfig: cfg,
    callControlId: 'cc-test',
    transcript: 'When do you close?',
    history: [],
    referenceTime: ref,
  });
  assert.equal(reply.source, 'brain_local_default');
  assert.match(reply.text, /close/i);
});
