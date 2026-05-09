import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTestEnv } from './testEnv';

setTestEnv();

/**
 * Sprint 0 cohesion test: callSession captures the per-tenant greetingText and
 * prompts from the published RuntimeTenantConfig, so that:
 *
 *   1. The opening greeting comes from tenantcfg.llmContext.prompts.greetingText
 *      when present (env.GREETING_TEXT remains the fallback when missing).
 *   2. tenant A's greeting / prompts cannot leak into tenant B.
 *
 * We only inspect the captured private fields here (cheap, no audio). Full
 * end-to-end greeting playback is exercised by the call-flow integration test.
 */

const baseTenantConfig = (overrides: any) => ({
  contractVersion: 'v1',
  tenantId: overrides.tenantId,
  dids: ['+15551234567'],
  webhookSecret: 'whsec_test',
  caps: {
    maxConcurrentCallsTenant: 1,
    maxCallsPerMinuteTenant: 1,
  },
  stt: { mode: 'whisper_http', whisperUrl: 'http://w', chunkMs: 500 },
  tts: { mode: 'kokoro_http', kokoroUrl: 'http://k' },
  audio: { runtimeManaged: true },
  llmContext: {
    forwardingProfiles: [],
    pricing: { items: [] },
    prompts: {
      systemPreamble: overrides.systemPreamble,
      schemaHint: 'JSON',
      policyPrompt: overrides.policyPrompt ?? '',
      voicePrompt: overrides.voicePrompt ?? '',
      ...(overrides.greetingText ? { greetingText: overrides.greetingText } : {}),
    },
  },
});

test('Sprint 0: callSession captures per-tenant greeting and prompts', async () => {
  const { SessionManager } = await import('../src/calls/sessionManager');
  const manager = new SessionManager({ capacityRelease: async () => {} });

  const session = manager.createSession(
    {
      callControlId: 'sprint0-greet-1',
      tenantId: 'alpha',
      tenantConfig: baseTenantConfig({
        tenantId: 'alpha',
        systemPreamble: 'TENANT-ALPHA-SYS',
        policyPrompt: 'TENANT-ALPHA-POLICY',
        voicePrompt: 'TENANT-ALPHA-TONE',
        greetingText: 'Hi, this is Alpha receptionist!',
      }),
    },
    {},
    { autoAnswer: false },
  );
  const captured = session as any;
  assert.equal(captured.tenantGreetingText, 'Hi, this is Alpha receptionist!');
  assert.equal(captured.tenantPrompts?.systemPreamble, 'TENANT-ALPHA-SYS');
  assert.equal(captured.tenantPrompts?.policyPrompt, 'TENANT-ALPHA-POLICY');
  assert.equal(captured.tenantPrompts?.voicePrompt, 'TENANT-ALPHA-TONE');
  manager.teardown('sprint0-greet-1', 'test');
});

test('Sprint 0: tenant A greeting/prompts do not leak into tenant B', async () => {
  const { SessionManager } = await import('../src/calls/sessionManager');
  const manager = new SessionManager({ capacityRelease: async () => {} });

  const a = manager.createSession(
    {
      callControlId: 'sprint0-greet-A',
      tenantId: 'alpha',
      tenantConfig: baseTenantConfig({
        tenantId: 'alpha',
        systemPreamble: 'A-SYS',
        greetingText: 'Greet A',
      }),
    },
    {},
    { autoAnswer: false },
  );
  const b = manager.createSession(
    {
      callControlId: 'sprint0-greet-B',
      tenantId: 'beta',
      tenantConfig: baseTenantConfig({
        tenantId: 'beta',
        systemPreamble: 'B-SYS',
        greetingText: 'Greet B',
      }),
    },
    {},
    { autoAnswer: false },
  );
  const ca = a as any;
  const cb = b as any;
  assert.equal(ca.tenantGreetingText, 'Greet A');
  assert.equal(cb.tenantGreetingText, 'Greet B');
  assert.equal(ca.tenantPrompts.systemPreamble, 'A-SYS');
  assert.equal(cb.tenantPrompts.systemPreamble, 'B-SYS');
  assert.notEqual(ca.tenantGreetingText, cb.tenantGreetingText);
  manager.teardown('sprint0-greet-A', 'test');
  manager.teardown('sprint0-greet-B', 'test');
});

test('Sprint 0: missing greeting falls back (tenantGreetingText is undefined)', async () => {
  const { SessionManager } = await import('../src/calls/sessionManager');
  const manager = new SessionManager({ capacityRelease: async () => {} });

  const session = manager.createSession(
    {
      callControlId: 'sprint0-greet-fallback',
      tenantId: 'gamma',
      tenantConfig: baseTenantConfig({
        tenantId: 'gamma',
        systemPreamble: 'G-SYS',
      }),
    },
    {},
    { autoAnswer: false },
  );
  const captured = session as any;
  assert.equal(captured.tenantGreetingText, undefined,
    'no tenant greeting => callSession will fall back to env.GREETING_TEXT');
  // Sanity: env.GREETING_TEXT still resolves because tests don't set it; the
  // production fallback in answerAndGreet uses the literal default below.
  manager.teardown('sprint0-greet-fallback', 'test');
});
